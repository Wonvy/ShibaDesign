import type { Asset, DocumentData, Matrix } from '@shiba/core';
import { PdfDocumentBuilder, type PdfBuildOptions } from './build';
import { interpretPage, type PdfFont, type PdfOperatorList, type PdfResources } from './interpret';
import { emptyIssues, type PdfImageSource, type PdfIssues } from './ir';

/**
 * 第一步的外壳：用 pdf.js 解析 PDF，把每一页的绘图指令和用到的字体、图片交给解释器。
 *
 * pdf.js 模块本身由调用方传进来，而不是在这里直接 import：
 * 浏览器和 Node 要用它的不同构建，工作线程脚本和附带的字体、字符映射表放在哪里也只有宿主知道。
 */

/** 用到的那一小部分 pdf.js 接口 */
export interface PdfJsLike {
  getDocument(source: Record<string, unknown>): { promise: Promise<PdfJsDocument>; destroy(): Promise<unknown> };
  OPS: Readonly<Record<string, number>>;
}

interface PdfJsObjects {
  has(id: string): boolean;
  get(id: string, callback?: (data: unknown) => void): unknown;
}

interface PdfJsPage {
  getViewport(params: { scale: number }): { width: number; height: number; transform: ArrayLike<number> };
  getOperatorList(): Promise<PdfOperatorList>;
  objs: PdfJsObjects;
  commonObjs: PdfJsObjects;
  cleanup(): unknown;
}

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  getOptionalContentConfig(): Promise<{ isVisible(group: unknown): boolean }>;
}

export interface PdfEnvironment {
  pdfjs: PdfJsLike;
  /** pdf.js 附带资源的目录地址，都以斜杠结尾。不给的话，用到这些资源的 PDF 会缺字或缺图 */
  cMapUrl?: string;
  standardFontDataUrl?: string;
  wasmUrl?: string;
  iccUrl?: string;
}

export interface PdfImportOptions extends PdfBuildOptions {
  /** 最多转换多少页，默认 100 */
  maxPages?: number;
  /** 最多生成多少个对象，超过后不再转换后面的页，默认 60000 */
  maxObjects?: number;
  /**
   * 路径锚点的总数上限，超过后不再转换后面的页，默认 400000。
   * 文字目前是按轮廓导入的，密排文字的页面每页就有几万个锚点；不设上限的话一本书能把浏览器撑爆。
   */
  maxAnchors?: number;
  /** 每转换完一页调用一次 */
  onProgress?(done: number, total: number): void;
}

export interface PdfImportReport {
  /** 实际转换的页数 */
  pages: number;
  /** PDF 一共有多少页 */
  totalPages: number;
  /** 生成的对象数（不含画板） */
  objects: number;
  issues: PdfIssues;
}

export interface PdfImportResult {
  document: DocumentData;
  assets: Asset[];
  report: PdfImportReport;
}

/** password：有密码保护；invalid：不是有效的 PDF；empty：没有页；failed：其他原因 */
export type PdfImportErrorReason = 'password' | 'invalid' | 'empty' | 'failed';

export class PdfImportError extends Error {
  constructor(
    readonly reason: PdfImportErrorReason,
    detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

const DEFAULT_FONT_MATRIX: Matrix = [0.001, 0, 0, 0.001, 0, 0];
/** 单张图片的像素数上限。再大的图解码出来要占几百兆内存，直接跳过，在报告里算作读不了的图片 */
const MAX_IMAGE_PIXELS = 100_000_000;
/** 等一页用到的图片解码完，最多等这么久；超时的图片当作缺失处理，不让整个导入卡死 */
const RESOURCE_TIMEOUT = 30_000;

/** pdf.js 交出来的对象没有可用的静态类型，读每个字段时都自己检查 */
type Raw = Record<string, any>;

function isBytes(value: unknown): value is Uint8Array | Uint8ClampedArray {
  return value instanceof Uint8Array || value instanceof Uint8ClampedArray;
}

/** pdf.js 的图片对象 → 我们的像素格式 */
function toSource(raw: Raw | null | undefined, kind: 'image' | 'mask'): PdfImageSource | null {
  if (!raw) return null;
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!(width >= 1 && height >= 1)) return null;
  let data: unknown = raw.data;
  let format: PdfImageSource['format'] | null = null;
  if (kind === 'mask') {
    format = isBytes(data) ? 'mask' : null;
  } else if (!isBytes(data) && raw.bitmap && typeof OffscreenCanvas !== 'undefined') {
    // 有的环境里 pdf.js 直接给浏览器的位图对象，借画布读出像素
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(raw.bitmap, 0, 0);
    data = context.getImageData(0, 0, width, height).data;
    format = 'rgba';
  } else if (isBytes(data)) {
    // pdf.js 的 ImageKind：1 是每像素 1 位的黑白，2 是 RGB，3 是 RGBA
    format = raw.kind === 1 ? 'bw' : raw.kind === 2 ? 'rgb' : raw.kind === 3 ? 'rgba' : null;
  }
  return format && isBytes(data) ? { width, height, format, data } : null;
}

/** 一份打开的 PDF 里跨页共用的东西 */
class DocumentResources {
  private readonly fonts = new Map<string, PdfFont | null>();
  private readonly glyphs = new Map<string, ArrayLike<number> | null>();
  private readonly sharedImages = new Map<string, PdfImageSource | null>();

  constructor(
    private readonly pdfjs: PdfJsLike,
    private readonly layers: { isVisible(group: unknown): boolean } | null,
  ) {}

  forPage(page: PdfJsPage): PdfResources {
    // 标识以 g_ 开头的对象是整份文档共用的，其余只属于这一页
    const objects = (id: string): PdfJsObjects => (id.startsWith('g_') ? page.commonObjs : page.objs);
    const read = (id: string): Raw | null => {
      const store = objects(id);
      try {
        return store.has(id) ? (store.get(id) as Raw | null) : null;
      } catch {
        return null;
      }
    };
    const pageImages = new Map<string, PdfImageSource | null>();
    const inlineImages = new WeakMap<object, PdfImageSource | null>();

    return {
      ops: this.pdfjs.OPS,
      font: (id) => {
        if (!this.fonts.has(id)) this.fonts.set(id, this.toFont(id, read(id)));
        return this.fonts.get(id) ?? null;
      },
      glyph: (font, fontChar) => {
        const key = `${font.id}_path_${fontChar}`;
        if (!this.glyphs.has(key)) {
          const path: unknown = read(key)?.path;
          this.glyphs.set(
            key,
            path && typeof (path as ArrayLike<number>).length === 'number' ? (path as ArrayLike<number>) : null,
          );
        }
        return this.glyphs.get(key) ?? null;
      },
      image: (ref, kind) => {
        // 蒙版的参数是 { data: 标识或像素, width, height }；普通图片要么是标识，要么是内嵌的图片对象
        const id =
          typeof ref === 'string'
            ? ref
            : kind === 'mask' && typeof (ref as Raw | null)?.data === 'string'
              ? (ref as Raw).data
              : null;
        if (typeof id === 'string') {
          const cache = id.startsWith('g_') ? this.sharedImages : pageImages;
          if (!cache.has(id)) cache.set(id, toSource(read(id), kind));
          return cache.get(id) ?? null;
        }
        if (typeof ref !== 'object' || ref === null) return null;
        if (!inlineImages.has(ref)) inlineImages.set(ref, toSource(ref as Raw, kind));
        return inlineImages.get(ref) ?? null;
      },
      shading: (id) => read(id),
      visible: (properties) => {
        try {
          return this.layers ? this.layers.isVisible(properties) : true;
        } catch {
          return true;
        }
      },
    };
  }

  private toFont(id: string, raw: Raw | null): PdfFont | null {
    if (!raw) return null;
    const matrix: unknown = raw.fontMatrix;
    const procs: unknown = raw.charProcOperatorList;
    return {
      id: typeof raw.loadedName === 'string' ? raw.loadedName : id,
      name: typeof raw.name === 'string' ? raw.name : '',
      type3: Boolean(raw.isType3Font),
      vertical: Boolean(raw.vertical),
      missing: Boolean(raw.missingFile),
      bold: Boolean(raw.bold || raw.black),
      italic: Boolean(raw.italic),
      fontMatrix:
        Array.isArray(matrix) && matrix.length === 6 && matrix.every((v) => Number.isFinite(v))
          ? (matrix as unknown as Matrix)
          : DEFAULT_FONT_MATRIX,
      charProc: procs instanceof Map ? (key) => (procs.get(key) as PdfOperatorList | undefined) ?? null : undefined,
    };
  }
}

/** 等这一页用到的字体和图片都准备好。pdf.js 解码图片是异步的，指令列表到手时图片不一定解完了 */
async function waitForResources(pdfjs: PdfJsLike, page: PdfJsPage, list: PdfOperatorList): Promise<void> {
  const dependency = pdfjs.OPS.dependency;
  const waiting: Promise<void>[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.fnArray.length; i++) {
    if (list.fnArray[i] !== dependency) continue;
    for (const id of (list.argsArray[i] as unknown[] | null) ?? []) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      const store = id.startsWith('g_') ? page.commonObjs : page.objs;
      waiting.push(
        new Promise((resolve) => {
          try {
            store.get(id, () => resolve());
          } catch {
            resolve();
          }
        }),
      );
    }
  }
  if (waiting.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, RESOURCE_TIMEOUT)));
  await Promise.race([Promise.all(waiting), timeout]);
  clearTimeout(timer);
}

function classify(error: unknown): PdfImportError {
  if (error instanceof PdfImportError) return error;
  const name = error instanceof Error ? error.name : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (name === 'PasswordException') return new PdfImportError('password', detail);
  if (name === 'InvalidPDFException' || name === 'FormatError') return new PdfImportError('invalid', detail);
  return new PdfImportError('failed', detail);
}

/**
 * 把一个 PDF 文件转成文档：每页一个画板，页面上的图形、图片、文字变成可以编辑的对象。
 * 文件有问题时抛出 PdfImportError；单页出错不影响其他页。
 */
export async function importPdf(
  environment: PdfEnvironment,
  bytes: Uint8Array,
  options: PdfImportOptions = {},
): Promise<PdfImportResult> {
  const { pdfjs } = environment;
  const task = pdfjs.getDocument({
    // pdf.js 会把这块内存转交给工作线程，所以给它一份拷贝，调用方手里的数据不受影响
    data: bytes.slice(),
    cMapUrl: environment.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: environment.standardFontDataUrl,
    wasmUrl: environment.wasmUrl,
    iccUrl: environment.iccUrl,
    // 不让 pdf.js 把字体装进浏览器，而是让它把每个字的轮廓算出来给我们
    disableFontFace: true,
    useSystemFonts: false,
    // 图片一律要裸像素，不要浏览器的位图对象：这样在哪里跑结果都一样
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    // PDF 是不可信的输入：不让解析库用动态生成代码的方式加速，也不解码大得离谱的图片
    isEvalSupported: false,
    maxImageSize: MAX_IMAGE_PIXELS,
    verbosity: 0,
  });

  try {
    const pdf = await task.promise;
    const totalPages = pdf.numPages;
    if (!(totalPages >= 1)) throw new PdfImportError('empty');
    const layers = await pdf.getOptionalContentConfig().catch(() => null);
    const resources = new DocumentResources(pdfjs, layers);
    const builder = new PdfDocumentBuilder(options);
    const limit = Math.min(totalPages, options.maxPages ?? 100);
    const maxObjects = options.maxObjects ?? 60_000;
    const maxAnchors = options.maxAnchors ?? 400_000;

    for (let number = 1; number <= limit; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const size = { width: viewport.width, height: viewport.height };
      const transform = Array.from(viewport.transform).slice(0, 6) as unknown as Matrix;
      try {
        const list = await page.getOperatorList();
        await waitForResources(pdfjs, page, list);
        await builder.addPage(interpretPage(list, resources.forPage(page), { ...size, transform }));
      } catch (error) {
        // 这一页解析失败：留一张空白画板占位，页码才对得上
        console.warn(`PDF page ${number} failed`, error);
        await builder.addPage({ ...size, items: [], issues: emptyIssues() });
      }
      page.cleanup();
      options.onProgress?.(number, limit);
      if (builder.objects >= maxObjects || builder.anchors >= maxAnchors) break;
    }

    const { document, assets } = builder.finish();
    return {
      document,
      assets,
      report: { pages: builder.pageCount, totalPages, objects: builder.objects, issues: builder.issues },
    };
  } catch (error) {
    throw classify(error);
  } finally {
    await task.destroy().catch(() => {});
  }
}
