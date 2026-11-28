import { useSyncExternalStore } from 'react';
import {
  DocStore,
  artboards,
  referencedAssetIds,
  slides,
  sortByZOrder,
  topLevelOnly,
  type Asset,
  type DocumentData,
  type NodeId,
  type Point,
} from '@shiba/core';
import { playableSlides, type Editor } from '@shiba/editor';
import {
  PdfImportError,
  SHIBA_EXTENSION,
  SHIBA_MIME,
  ShibaFileError,
  packShiba,
  unpackShiba,
  zipFiles,
  type PdfIssues,
} from '@shiba/io';
import { buildPresentationHtml } from '@shiba/player';
import { i18n } from './i18n';
import { displayName } from './names';
import { compilePresentation } from './present/compile';
import type { TemplateDef } from './templates/builtin';
import { addTemplate, templateFile, type TemplateMeta } from './templates/library';
import { BLANK_PRESETS, blankDocument, type BlankPreset } from './templates/presets';
import { bitmapToPng, coverOf, documentThumbnail } from './templates/preview';
import { VideoUnsupportedError, type VideoSettings } from './present/video-settings';
import { busyToast, toast } from './ui/toast';

/**
 * 文件操作：新建、打开、保存 .shiba 文件，打开 PDF，导出图片、PDF、SVG、网页和视频，导入图片。
 *
 * 浏览器支持"文件系统访问"接口时（Chrome、Edge），保存会直接写回用户选的那个文件；
 * 不支持时（Safari、Firefox）退回成下载一个文件。
 */

// ───────────── 当前文件的状态 ─────────────

export interface FileState {
  /** 当前文件名；还没保存过时为 null */
  name: string | null;
  /** 自上次保存以来是否有修改 */
  dirty: boolean;
}

interface SaveHandle {
  name: string;
  createWritable(): Promise<{ write(data: Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface PickerWindow {
  showSaveFilePicker?(options: { suggestedName: string; types: PickerType[] }): Promise<SaveHandle>;
  showOpenFilePicker?(options: { types: PickerType[]; multiple: boolean }): Promise<SaveHandle[]>;
}

const picker = window as unknown as PickerWindow;
const t = (key: string, options: Record<string, unknown> = {}): string => i18n.t(key, options);

let state: FileState = { name: null, dirty: false };
let handle: SaveHandle | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<FileState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

export function useFileState(): FileState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** 文档一有修改就标记为"未保存" */
export function trackChanges(store: DocStore): void {
  store.subscribe((change) => {
    if (change.source !== 'load' && !state.dirty) setState({ dirty: true });
  });
}

// ───────────── 小工具 ─────────────

const SHIBA_TYPES: PickerType[] = [{ description: 'ShibaDesign', accept: { [SHIBA_MIME]: [SHIBA_EXTENSION] } }];
const PDF_EXTENSION = '.pdf';
const PDF_MIME = 'application/pdf';
/** "打开"能打开的文件：自己的格式，以及可以转换成文档的 PDF */
const OPEN_TYPES: PickerType[] = [
  { description: 'ShibaDesign / PDF', accept: { [SHIBA_MIME]: [SHIBA_EXTENSION], [PDF_MIME]: [PDF_EXTENSION] } },
];
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const PNG_TYPES: PickerType[] = [{ description: 'PNG', accept: { 'image/png': ['.png'] } }];
const JPEG_TYPES: PickerType[] = [{ description: 'JPEG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }];
/** JPEG 的压缩质量。0.92 是浏览器默认的质量，看不出压缩的痕迹，文件比 PNG 小得多 */
const JPEG_QUALITY = 0.92;
const HTML_TYPES: PickerType[] = [{ description: 'HTML', accept: { 'text/html': ['.html'] } }];
const PDF_TYPES: PickerType[] = [{ description: 'PDF', accept: { [PDF_MIME]: [PDF_EXTENSION] } }];
const SVG_MIME = 'image/svg+xml';
const SVG_TYPES: PickerType[] = [{ description: 'SVG', accept: { [SVG_MIME]: ['.svg'] } }];
const ZIP_MIME = 'application/zip';
const VIDEO_TYPES: Record<VideoSettings['format'], { mime: string; extension: string }> = {
  mp4: { mime: 'video/mp4', extension: '.mp4' },
  gif: { mime: 'image/gif', extension: '.gif' },
};
const ZIP_TYPES: PickerType[] = [{ description: 'ZIP', accept: { [ZIP_MIME]: ['.zip'] } }];
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';
/** 图片长边超过这个值就在导入时缩小。解码后的图片整张放在内存和显存里，太大会拖垮整个画布 */
const MAX_IMAGE_SIDE = 4096;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** 模板缩略图的最大边长，像素 */
const TEMPLATE_THUMB = 480;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function download(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([toBuffer(bytes)], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 弹出系统的文件选择框 */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

function starterDocument(): DocumentData {
  return blankDocument(BLANK_PRESETS[0]!);
}

/** 一个只有一张空白画板（一页 16:9 的幻灯片）的新文档 */
export function createStarterDocument(): DocumentData {
  return starterDocument();
}

/** 换文档之前，如果有没保存的修改，先问一下 */
function confirmDiscard(): boolean {
  return !state.dirty || window.confirm(t('file.discardConfirm'));
}

// ───────────── 新建、打开、保存 ─────────────

/**
 * 从模板或空白尺寸新建：换掉当前文档（有没保存的修改时先问），是一份还没保存过的新文档。
 * 有幻灯片的进幻灯片视图，没有的进画布视图。返回是否换了
 */
function startFrom(editor: Editor, document: DocumentData, assets: readonly Asset[]): boolean {
  if (!confirmDiscard()) return false;
  editor.setTool('select');
  editor.assets.replaceAll([...assets]);
  editor.store.load(document);
  editor.setViewMode(slides(editor.store).length > 0 ? 'slides' : 'canvas');
  editor.zoomToFit();
  handle = null;
  setState({ name: null, dirty: false });
  return true;
}

/** 按空白尺寸新建 */
export function newBlankDocument(editor: Editor, preset: BlankPreset): boolean {
  return startFrom(editor, blankDocument(preset), []);
}

/** 从内置模板新建，示例文字用当前的语言 */
export function newFromBuiltin(editor: Editor, template: TemplateDef): boolean {
  return startFrom(editor, template.build(t), []);
}

/** 从"我的模板"新建。模板文件坏了时提示原因 */
export async function newFromUserTemplate(editor: Editor, template: TemplateMeta): Promise<boolean> {
  try {
    const bytes = await templateFile(template.id);
    if (!bytes) return false;
    const parsed = unpackShiba(bytes);
    return startFrom(editor, parsed.document, parsed.assets);
  } catch (error) {
    const reason = error instanceof ShibaFileError ? error.reason : 'badDocument';
    if (!(error instanceof ShibaFileError)) console.error(error);
    toast(t('file.openFailed', { reason: t(`file.reason.${reason}`) }), 'error');
    return false;
  }
}

/** 把当前文档存成"我的模板"：连同用到的图片打包，再画一张封面的缩略图 */
export async function saveAsTemplate(editor: Editor, name: string): Promise<void> {
  try {
    const cover = coverOf(editor.store);
    if (cover) await editor.fontsReady(cover);
    const bitmap = cover ? editor.renderThumbnail(cover, TEMPLATE_THUMB, TEMPLATE_THUMB) : null;
    await addTemplate({
      name,
      file: buildFile(editor),
      thumbnail: bitmap ? await bitmapToPng(bitmap) : null,
      slides: slides(editor.store).length,
    });
    toast(t('template.saved', { name }));
  } catch (error) {
    console.error(error);
    toast(t('template.saveFailed'), 'error');
  }
}

/** 把"我的模板"导出成 .shiba 文件（备份、发给别人） */
export async function exportUserTemplate(template: TemplateMeta): Promise<void> {
  await saveExported(
    `${fileSafe(template.name)}${SHIBA_EXTENSION}`,
    SHIBA_TYPES,
    SHIBA_MIME,
    t('template.exporting'),
    async () => {
      const bytes = await templateFile(template.id);
      if (!bytes) throw new Error(`模板 ${template.id} 不存在`);
      return bytes;
    },
  );
}

/** 把 .shiba 文件导入成"我的模板"。文件按不可信输入解包、校验，坏的提示原因 */
export async function importTemplateFiles(editor: Editor): Promise<void> {
  const files = await pickFiles(SHIBA_EXTENSION, true);
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = unpackShiba(bytes);
      const thumbnail = await documentThumbnail(editor.ck, parsed.document, parsed.assets, TEMPLATE_THUMB);
      const count = parsed.document.nodes
        ? Object.values(parsed.document.nodes).filter((n) => n.type === 'artboard' && n.deck).length
        : 0;
      const name = file.name.replace(/\.shiba$/i, '');
      await addTemplate({ name, file: bytes, thumbnail, slides: count });
      toast(t('template.imported', { name }));
    } catch (error) {
      const reason = error instanceof ShibaFileError ? error.reason : 'badDocument';
      if (!(error instanceof ShibaFileError)) console.error(error);
      toast(t('file.openFailed', { reason: t(`file.reason.${reason}`) }), 'error');
    }
  }
}

/** 把一个 .shiba 文件的内容装进编辑器。文件有问题时提示原因，当前文档不受影响 */
async function loadShiba(editor: Editor, file: File, from: SaveHandle | null): Promise<void> {
  try {
    const parsed = unpackShiba(new Uint8Array(await file.arrayBuffer()));
    editor.setTool('select');
    // 先换资源再换文档，这样文档一出现图片就已经在了
    editor.assets.replaceAll(parsed.assets);
    editor.store.load(parsed.document);
    editor.zoomToFit();
    handle = from;
    setState({ name: file.name, dirty: false });
  } catch (error) {
    const reason = error instanceof ShibaFileError ? error.reason : 'badDocument';
    if (!(error instanceof ShibaFileError)) console.error(error);
    toast(t('file.openFailed', { reason: t(`file.reason.${reason}`) }), 'error');
  }
}

/**
 * 把一个 PDF 转成文档装进编辑器：每页一个画板，页面上的内容变成可以编辑的对象。
 * 转换出来的是一份还没保存的新文档——原来的 PDF 不会被改动，保存时另存为 .shiba。
 */
async function loadPdf(editor: Editor, file: File): Promise<void> {
  const fail = (reason: string): void => toast(t('file.openFailed', { reason: t(`file.reason.${reason}`) }), 'error');
  if (file.size > MAX_PDF_BYTES) return fail('pdfTooLarge');
  const progress = busyToast(t('pdf.opening'));
  try {
    // 解析库体积不小，用到时才加载
    const { importPdfBytes } = await import('./pdf');
    const result = await importPdfBytes(new Uint8Array(await file.arrayBuffer()), (page, total) =>
      progress.update(t('pdf.progress', { page, total })),
    );
    editor.setTool('select');
    editor.assets.replaceAll(result.assets);
    editor.store.load(result.document);
    editor.zoomToFit();
    handle = null;
    const name = file.name.replace(/\.pdf$/i, '');
    setState({ name: `${name}${SHIBA_EXTENSION}`, dirty: true });
    progress.close();

    const { report } = result;
    toast(t('pdf.opened', { name: file.name, pages: report.pages, objects: report.objects }));
    if (report.pages < report.totalPages) toast(t('pdf.truncated', { pages: report.pages, total: report.totalPages }));
    const issues = (Object.keys(report.issues) as (keyof PdfIssues)[])
      .filter((key) => report.issues[key] > 0)
      .map((key) => t(`pdf.issue.${key}`, { count: report.issues[key] }));
    if (issues.length > 0) toast(t('pdf.lossy', { items: issues.join(t('pdf.separator')) }), 'warning');
  } catch (error) {
    progress.close();
    const reason = error instanceof PdfImportError ? error.reason : 'failed';
    if (reason === 'failed') console.error(error);
    fail(`pdf${reason[0]!.toUpperCase()}${reason.slice(1)}`);
  }
}

/** 按文件类型打开。from 是文件选择框给的句柄，保存时可以直接写回——只对 .shiba 文件有意义 */
async function loadFile(editor: Editor, file: File, from: SaveHandle | null): Promise<void> {
  if (isPdfFile(file)) await loadPdf(editor, file);
  else await loadShiba(editor, file, from);
}

export async function openDocument(editor: Editor): Promise<void> {
  if (!confirmDiscard()) return;
  try {
    if (picker.showOpenFilePicker) {
      const [picked] = await picker.showOpenFilePicker({ types: OPEN_TYPES, multiple: false });
      if (picked) await loadFile(editor, await picked.getFile(), picked);
      return;
    }
    const [file] = await pickFiles(`${SHIBA_EXTENSION},${PDF_EXTENSION}`, false);
    if (file) await loadFile(editor, file, null);
  } catch (error) {
    if (!isAbort(error)) throw error;
  }
}

/** 打开一个拖进窗口的 .shiba 或 PDF 文件 */
export async function openDroppedDocument(editor: Editor, file: File): Promise<void> {
  if (!confirmDiscard()) return;
  await loadFile(editor, file, null);
}

function buildFile(editor: Editor): Uint8Array {
  // 只写入文档实际引用的图片：撤销掉的、换掉的图片不占文件体积
  const referenced = referencedAssetIds(editor.store);
  return packShiba({
    document: editor.store.toJSON(),
    assets: editor.assets.all().filter((asset) => referenced.has(asset.meta.id)),
  });
}

async function writeTo(target: SaveHandle, bytes: Uint8Array): Promise<void> {
  const writable = await target.createWritable();
  await writable.write(toBuffer(bytes));
  await writable.close();
}

export async function saveDocumentAs(editor: Editor): Promise<void> {
  const suggested = state.name ?? `${t('file.untitled')}${SHIBA_EXTENSION}`;
  try {
    const bytes = buildFile(editor);
    if (picker.showSaveFilePicker) {
      const target = await picker.showSaveFilePicker({ suggestedName: suggested, types: SHIBA_TYPES });
      await writeTo(target, bytes);
      handle = target;
      setState({ name: target.name, dirty: false });
      toast(t('file.saved', { name: target.name }));
      return;
    }
    download(suggested, bytes, SHIBA_MIME);
    setState({ name: suggested, dirty: false });
    toast(t('file.downloaded', { name: suggested }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

export async function saveDocument(editor: Editor): Promise<void> {
  if (!handle) return saveDocumentAs(editor);
  try {
    await writeTo(handle, buildFile(editor));
    setState({ dirty: false });
    toast(t('file.saved', { name: handle.name }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

// ───────────── 导出 ─────────────

export type ImageFormat = 'png' | 'jpeg';

/**
 * PNG → JPEG，用浏览器自己的编码器（渲染引擎的默认构建里没有 JPEG 编码器）。
 * JPEG 没有透明，透明的地方垫成白色，不然会变成黑色。编码失败时返回 null
 */
async function pngToJpeg(png: Uint8Array): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([toBuffer(png)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    console.error(error);
    return null;
  }
}

/** 导出 PNG 或 JPEG：选中了一个对象就导出它，否则导出当前画板 */
export async function exportImage(editor: Editor, format: ImageFormat, scale: number): Promise<void> {
  const selected = editor.selectedNodes();
  const target = selected.length === 1 ? selected[0]! : editor.activeArtboard;
  if (!target) return;
  const png = await editor.exportPng(target.id, scale);
  const bytes = png && format === 'jpeg' ? await pngToJpeg(png) : png;
  if (!bytes) {
    toast(t('file.exportFailed'), 'error');
    return;
  }
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const name = `${fileSafe(displayName(target, t))}${scale === 1 ? '' : `@${scale}x`}.${extension}`;
  try {
    if (picker.showSaveFilePicker) {
      const types = format === 'jpeg' ? JPEG_TYPES : PNG_TYPES;
      const out = await picker.showSaveFilePicker({ suggestedName: name, types });
      await writeTo(out, bytes);
      toast(t('file.exported', { name: out.name }));
      return;
    }
    download(name, bytes, format === 'jpeg' ? 'image/jpeg' : 'image/png');
    toast(t('file.exported', { name }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

/**
 * 把演示稿导出成一个可以独立播放的 HTML 文件：图片和播放器都内嵌在文件里，
 * 断网也能播，发给别人双击就能打开。
 */
export async function exportHtml(editor: Editor): Promise<void> {
  const title = (state.name ?? t('file.untitled')).replace(/\.shiba$/i, '');
  const compiled = await compilePresentation(editor, 'export', title);
  if (compiled.data.slides.length === 0) {
    toast(t('present.empty'), 'error');
    return;
  }
  const bytes = new TextEncoder().encode(buildPresentationHtml(compiled.data));
  const name = `${title}.html`;
  try {
    if (picker.showSaveFilePicker) {
      const out = await picker.showSaveFilePicker({ suggestedName: name, types: HTML_TYPES });
      await writeTo(out, bytes);
      toast(t('file.exported', { name: out.name }));
      return;
    }
    download(name, bytes, 'text/html');
    toast(t('file.exported', { name }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

/** 导出全部画板时的顺序：先是幻灯片（按播放顺序），再是其余的画板 */
function exportOrder(store: DocStore): NodeId[] {
  const ordered = slides(store).map((board) => board.id);
  const rest = artboards(store)
    .map((board) => board.id)
    .filter((id) => !ordered.includes(id));
  return [...ordered, ...rest];
}

/**
 * 导出 PDF：每个画板一页，图形是矢量，文字可以搜索和复制。
 * 能直接写文件的浏览器先选好保存位置再导出：导出要取字体文件，可能要好几秒，
 * 而选择保存位置的对话框只能在用户刚点过菜单时弹出。
 */
export async function exportPdf(editor: Editor): Promise<void> {
  const pages = exportOrder(editor.store);
  if (pages.length === 0) {
    toast(t('file.noArtboards'), 'error');
    return;
  }
  const title = documentTitle();
  const name = `${title}.pdf`;
  let out: SaveHandle | null = null;
  try {
    if (picker.showSaveFilePicker) out = await picker.showSaveFilePicker({ suggestedName: name, types: PDF_TYPES });
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
  }

  const busy = busyToast(t('file.exportingPdf', { count: pages.length }));
  let bytes: Uint8Array;
  try {
    bytes = await editor.exportPdf(pages, { title });
  } catch (error) {
    console.error(error);
    busy.close();
    toast(t('file.exportPdfFailed'), 'error');
    return;
  }
  busy.close();
  try {
    if (out) {
      await writeTo(out, bytes);
      toast(t('file.exported', { name: out.name }));
      return;
    }
    download(name, bytes, PDF_MIME);
    toast(t('file.exported', { name }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

/** 当前文档的标题：文件名去掉扩展名 */
function documentTitle(): string {
  return (state.name ?? t('file.untitled')).replace(/\.(shiba|pdf)$/i, '');
}

/** 文件名里不能出现的字符换成下划线 */
function fileSafe(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || t('file.untitled');
}

export interface SvgExportChoice {
  /** selection：选中的对象，合成一个文件；current：当前画板；all：全部画板，打包成 ZIP */
  scope: 'selection' | 'current' | 'all';
  /** text：保留成文字（内嵌字体子集）；outline：转成轮廓 */
  text: 'text' | 'outline';
}

/** 导出"选中的对象"时导出哪些：选区里最外层的那些，按层序从下到上 */
function selectionExportIds(editor: Editor): NodeId[] {
  const { store } = editor;
  return sortByZOrder(store, topLevelOnly(store, editor.selection))
    .filter((node) => node.visible)
    .map((node) => node.id);
}

/** 导出 SVG 时有哪些可选：选中了几个对象、当前画板叫什么、一共有几个画板 */
export function svgExportTargets(editor: Editor): { selection: number; current: string | null; all: number } {
  const active = editor.activeArtboard;
  return {
    selection: selectionExportIds(editor).length,
    current: active ? displayName(active, t) : null,
    all: exportOrder(editor.store).length,
  };
}

/**
 * 导出 SVG：选中的对象合成一个文件；画板每个一个文件，导出全部画板时打包成一个 ZIP。
 * 要在用户点"导出"的那一下里调用：能直接写文件的浏览器先弹出保存位置的对话框，再慢慢导出
 */
export async function exportSvg(editor: Editor, choice: SvgExportChoice): Promise<void> {
  const { store } = editor;
  const nodeName = (id: NodeId): string => {
    const node = store.get(id);
    return fileSafe(node ? displayName(node, t) : t('file.untitled'));
  };
  if (choice.scope === 'selection') {
    const ids = selectionExportIds(editor);
    if (ids.length === 0) {
      toast(t('file.nothingSelected'), 'error');
      return;
    }
    const name = `${ids.length === 1 ? nodeName(ids[0]!) : fileSafe(documentTitle())}.svg`;
    await saveExported(name, SVG_TYPES, SVG_MIME, t('file.exportingSvgSelection'), async () => {
      const title = ids.length === 1 ? displayName(store.get(ids[0]!)!, t) : documentTitle();
      return new TextEncoder().encode(await editor.exportSvgNodes(ids, { text: choice.text, title }));
    });
    return;
  }

  const active = editor.activeArtboard;
  const boards = choice.scope === 'all' ? exportOrder(store) : active ? [active.id] : [];
  if (boards.length === 0) {
    toast(t('file.noArtboards'), 'error');
    return;
  }
  const single = boards.length === 1;
  const name = single ? `${nodeName(boards[0]!)}.svg` : `${fileSafe(documentTitle())}.zip`;
  await saveExported(
    name,
    single ? SVG_TYPES : ZIP_TYPES,
    single ? SVG_MIME : ZIP_MIME,
    t('file.exportingSvg', { count: boards.length }),
    async () => {
      const encoder = new TextEncoder();
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (const [index, id] of boards.entries()) {
        const node = store.get(id);
        const title = node ? displayName(node, t) : undefined;
        const svg = await editor.exportSvg(id, { text: choice.text, title });
        // 打包的文件名前面加上序号，解压出来按幻灯片的顺序排
        const prefix = single ? '' : `${String(index + 1).padStart(String(boards.length).length, '0')} `;
        files.push({ name: `${prefix}${nodeName(id)}.svg`, bytes: encoder.encode(svg) });
      }
      return single ? files[0]!.bytes : zipFiles(files);
    },
  );
}

/**
 * 导出 SVG 的公共步骤：先选保存位置（能直接写文件的浏览器），再显示"正在导出"并生成内容，最后写文件或者下载
 */
async function saveExported(
  name: string,
  types: PickerType[],
  mime: string,
  busyMessage: string,
  produce: () => Promise<Uint8Array>,
): Promise<void> {
  let out: SaveHandle | null = null;
  try {
    if (picker.showSaveFilePicker) out = await picker.showSaveFilePicker({ suggestedName: name, types });
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
  }

  const busy = busyToast(busyMessage);
  let bytes: Uint8Array;
  try {
    bytes = await produce();
  } catch (error) {
    console.error(error);
    busy.close();
    toast(t('file.exportSvgFailed'), 'error');
    return;
  }
  busy.close();
  try {
    if (out) {
      await writeTo(out, bytes);
      toast(t('file.exported', { name: out.name }));
      return;
    }
    download(name, bytes, mime);
    toast(t('file.exported', { name }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

/**
 * 把演示稿导出成 MP4 视频或 GIF 动图。要等一阵子，提示里显示进度，可以中途取消。
 * 和导出 PDF 一样，能直接写文件的浏览器先选好保存位置再开始
 */
export async function exportVideo(editor: Editor, settings: VideoSettings): Promise<void> {
  if (playableSlides(editor).length === 0) {
    toast(t('present.empty'), 'error');
    return;
  }
  const type = VIDEO_TYPES[settings.format];
  const name = `${fileSafe(documentTitle())}${type.extension}`;
  let out: SaveHandle | null = null;
  try {
    if (picker.showSaveFilePicker) {
      out = await picker.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: settings.format.toUpperCase(), accept: { [type.mime]: [type.extension] } }],
      });
    }
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
  }

  const controller = new AbortController();
  const busy = busyToast(t('file.exportingVideo', { percent: 0 }), {
    label: t('file.cancel'),
    run: () => controller.abort(),
  });
  let bytes: Uint8Array;
  try {
    let shown = 0;
    // 录制和编码的代码只在这里用到，用到时才加载
    const { renderVideo } = await import('./present/video');
    bytes = await renderVideo(editor, settings, {
      signal: controller.signal,
      onProgress(fraction) {
        const percent = Math.floor(fraction * 100);
        if (percent === shown) return;
        shown = percent;
        busy.update(t('file.exportingVideo', { percent }));
      },
    });
  } catch (error) {
    busy.close();
    if (isAbort(error)) {
      toast(t('file.exportCancelled'));
      return;
    }
    console.error(error);
    toast(t(error instanceof VideoUnsupportedError ? 'file.videoUnsupported' : 'file.exportVideoFailed'), 'error');
    return;
  }
  busy.close();
  try {
    if (out) {
      await writeTo(out, bytes);
      toast(t('file.exported', { name: out.name }));
      return;
    }
    download(name, bytes, type.mime);
    toast(t('file.exported', { name }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

// ───────────── 导入图片 ─────────────

/**
 * 用浏览器自己的解码器把图片转成 PNG。两种情况会用到：
 * 渲染引擎不认识的格式（比如 WebP、AVIF），以及需要缩小的大图。
 */
async function transcode(file: Blob, maxSide: number): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } catch {
    return null;
  }
}

/** 把一个图片文件收进资源库，返回资源 id；失败时提示并返回 null */
export async function importImageFile(editor: Editor, file: File): Promise<string | null> {
  const fail = (): null => {
    toast(t('image.unsupported', { name: file.name || t('node.image') }), 'error');
    return null;
  };
  if (file.size > MAX_IMAGE_BYTES) return fail();

  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  let mime = file.type || 'image/png';
  const size = editor.images.probe(bytes);
  const tooBig = size !== null && Math.max(size.width, size.height) > MAX_IMAGE_SIDE;
  if (!size || tooBig) {
    const converted = await transcode(file, MAX_IMAGE_SIDE);
    if (!converted) return fail();
    bytes = converted;
    mime = 'image/png';
    if (tooBig) toast(t('image.downscaled', { name: file.name, size: MAX_IMAGE_SIDE }));
  }
  const meta = await editor.importImage(bytes, { mime, name: file.name || undefined });
  return meta ? meta.id : fail();
}

/** 导入一批图片并放到画布上。at 是世界坐标；不传时放在当前画板中央 */
export async function placeImageFiles(editor: Editor, files: readonly File[], at?: Point): Promise<void> {
  let offset = 0;
  for (const file of files) {
    const assetId = await importImageFile(editor, file);
    if (!assetId) continue;
    editor.commands.run('image.place', { assetId, at: at ? { x: at.x + offset, y: at.y + offset } : undefined });
    offset += 24;
  }
}

export async function pickAndPlaceImages(editor: Editor): Promise<void> {
  await placeImageFiles(editor, await pickFiles(IMAGE_ACCEPT, true));
}

/** 选一张图片，作为选中形状的填充 */
export async function pickImageFill(editor: Editor): Promise<void> {
  const [file] = await pickFiles(IMAGE_ACCEPT, false);
  if (!file) return;
  const assetId = await importImageFile(editor, file);
  if (assetId) editor.commands.run('image.setFill', { assetId });
}

export function isShibaFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(SHIBA_EXTENSION);
}

export function isPdfFile(file: File): boolean {
  return file.type === PDF_MIME || file.name.toLowerCase().endsWith(PDF_EXTENSION);
}

/** 可以整个打开的文件（而不是插入到当前文档里的素材） */
export function isDocumentFile(file: File): boolean {
  return isShibaFile(file) || isPdfFile(file);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}
