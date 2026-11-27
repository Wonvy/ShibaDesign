import type { CanvasKit, GlyphRun as SkGlyphRun, Image, Path, Typeface } from 'canvaskit-wasm';
import {
  hasLiveAppearance,
  hasShapeStyle,
  invert,
  multiply,
  type ArtboardNode,
  type AssetStore,
  type BlendMode,
  type Color,
  type DocStore,
  type ImageFill,
  type Matrix,
  type NodeId,
  type Rect,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import {
  ContentStream,
  EmbeddedFont,
  OutlineFont,
  PdfWriter,
  formatNumber,
  parseSfnt,
  pdfDate,
  pdfName,
  pdfText,
  writeJpeg,
  writeRgbaImage,
  type PdfRef,
} from '@shiba/io';
import { adjustmentMatrix } from './adjust';
import type { GeometryCache } from './geometry';
import { placeImage, type ImageCache } from './images';
import type { NodeTypeDef, NodeTypeRegistry } from './node-types';
import type { TextAppearances } from './text/appearance';
import type { FontManager, LoadedFace } from './text/fonts';
import type { TextLayouts } from './text/layout';

/**
 * 把画板导出成矢量 PDF，每个画板一页。
 * 这个模块单独作为 @shiba/renderer/pdf 导出，不在包的主入口里：只有导出时才用得到，宿主可以按需加载。
 *
 * 做法和屏幕渲染器一样是遍历节点树，只是不往 Skia 画布上画，而是写 PDF 的绘图指令：
 * - 形状写成路径，填充、描边、透明度、16 种混合模式都是 PDF 原生支持的；
 * - 图片原样或解码后放进去，裁剪成形状的轮廓；调色和模糊先在像素上做好；
 * - 文字写成真正的文字：我们排版的文字嵌入子集化的字体，按排版引擎给出的每个字的位置写；
 *   从 PDF 导入、没改过的文字用它的字形轮廓做成 Type3 字体。两种都能被搜索和复制；
 * - 需要先合成再整体透明或混合的（编组、文字）写成透明组，对应渲染器里的离屏层。
 *
 * 1 个文档单位是 PDF 的 1 点，和导入时一致，导入再导出尺寸不变。
 */

export interface PdfExportContext {
  ck: CanvasKit;
  store: DocStore;
  registry: NodeTypeRegistry;
  geometry: GeometryCache;
  layouts: TextLayouts;
  fonts: FontManager;
  appearances: TextAppearances;
  images: ImageCache;
  assets: AssetStore;
  /**
   * 不知道怎么写成矢量的节点（扩展的节点类型、拿不到字体文件的文字）画成图片放进去。
   * 返回 PNG 和它对应的本地坐标范围；不提供或返回 null 时跳过这个节点
   */
  rasterize?(node: SceneNode): { png: Uint8Array; box: Rect } | null;
}

export interface PdfExportOptions {
  title?: string;
  /** 文件里记的创建时间，默认是现在 */
  date?: Date;
}

/** PDF 阅读器能处理的页面边长上限（200 英寸）；更大的页面整体缩小，再用 UserUnit 告诉阅读器实际大小 */
const MAX_PAGE_SIDE = 14_400;
/** Skia 描边的默认斜接限制是 4，PDF 默认是 10，要写明 */
const MITER_LIMIT = 4;
const MISSING_IMAGE_COLOR: Color = { r: 0.82, g: 0.83, b: 0.85, a: 1 };

const BLEND_NAMES: Record<BlendMode, string> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  'color-dodge': 'ColorDodge',
  'color-burn': 'ColorBurn',
  'hard-light': 'HardLight',
  'soft-light': 'SoftLight',
  difference: 'Difference',
  exclusion: 'Exclusion',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
};

/** 画一个节点时还要乘上的不透明度和混合模式。已经包进透明组时是 1 和 normal */
interface Paint {
  opacity: number;
  blend: BlendMode;
}

/** 排好版的一段字：同一个字体文件、同一个字号 */
interface ShapedRun {
  face: string;
  size: number;
  glyphs: Uint16Array;
  /** 每个字的位置 x0, y0, x1, y1……（节点本地坐标，y 是基线） */
  positions: Float32Array;
  /** 每个字代表的文字；一个字代表多个字符（连字）或者几个字合起来代表一个字符时，只有第一个有 */
  text: string[];
}

/** 文字怎么写：按排版结果写字，或者因为拿不到字体文件只能画成图片 */
type ShapedText = { runs: ShapedRun[] } | 'raster';

/** 导出一组画板，返回 PDF 文件的字节 */
export async function exportPdf(
  context: PdfExportContext,
  artboards: readonly NodeId[],
  options: PdfExportOptions = {},
): Promise<Uint8Array> {
  const exporter = new PdfExporter(context);
  try {
    return await exporter.run(artboards, options);
  } finally {
    exporter.dispose();
  }
}

class PdfExporter {
  private readonly writer = new PdfWriter();
  private readonly resourcesRef: PdfRef;
  private readonly fontResources: Record<string, PdfRef> = {};
  private readonly xobjects: Record<string, PdfRef> = {};
  private readonly states: Record<string, PdfRef> = {};
  private readonly stateNames = new Map<string, string>();
  private readonly imageNames = new Map<string, string>();
  /** 字体文件 → 嵌入的字体 */
  private readonly embedded = new Map<string, { name: string; ref: PdfRef; font: EmbeddedFont }>();
  /** 字形库 → 用它的字形做的 Type3 字体（一个字体只能放 256 个字形，所以可能有好几个） */
  private readonly outlineFonts = new Map<string, { name: string; ref: PdfRef; font: OutlineFont }[]>();
  private readonly shaped = new Map<NodeId, ShapedText>();
  /** 认字体文件用的 Skia 字体，导出完释放 */
  private readonly typefaces = new Map<string, Typeface | null>();
  private counter = 0;
  /** 当前页面用到了透明度或混合模式 */
  private transparent = false;

  constructor(private readonly c: PdfExportContext) {
    this.resourcesRef = this.writer.alloc();
  }

  async run(artboards: readonly NodeId[], options: PdfExportOptions): Promise<Uint8Array> {
    const { writer } = this;
    const boards = artboards
      .map((id) => this.c.store.get(id))
      .filter((node): node is ArtboardNode => node?.type === 'artboard');
    await this.prepareText(boards);

    const pagesRef = writer.alloc();
    const pageRefs: PdfRef[] = [];
    for (const board of boards) pageRefs.push(this.page(board, pagesRef));

    for (const { ref, font } of this.embedded.values()) font.write(writer, ref);
    for (const fonts of this.outlineFonts.values()) for (const { ref, font } of fonts) font.write(writer, ref);
    writer.set(this.resourcesRef, {
      Font: this.fontResources,
      XObject: this.xobjects,
      ExtGState: this.states,
    });
    writer.set(pagesRef, { Type: pdfName('Pages'), Kids: pageRefs, Count: pageRefs.length });
    const catalog = writer.add({ Type: pdfName('Catalog'), Pages: pagesRef });
    const info = writer.add({
      Title: options.title ? pdfText(options.title) : undefined,
      Creator: pdfText('ShibaDesign'),
      Producer: pdfText('ShibaDesign'),
      CreationDate: pdfDate(options.date ?? new Date()),
    });
    return writer.finish(catalog, info);
  }

  dispose(): void {
    for (const typeface of this.typefaces.values()) typeface?.delete();
    this.typefaces.clear();
  }

  // ───────────── 页面与节点 ─────────────

  private page(board: ArtboardNode, parent: PdfRef): PdfRef {
    const [width, height] = board.size;
    const unit = Math.max(1, Math.max(width, height) / MAX_PAGE_SIDE);
    const content = new ContentStream();
    this.transparent = false;
    // PDF 的 y 轴向上，原点在左下角；翻过来以后就和文档坐标一样了
    content.transform([1 / unit, 0, 0, -1 / unit, 0, height / unit]);
    this.drawNode(content, board, [1, 0, 0, 1, 0, 0], [0, 0, width, height], [1, 0, 0, 1, 0, 0]);
    const contents = this.writer.stream({}, content.toBytes());
    return this.writer.add({
      Type: pdfName('Page'),
      Parent: parent,
      MediaBox: [0, 0, width / unit, height / unit],
      UserUnit: unit > 1 ? unit : undefined,
      Resources: this.resourcesRef,
      Contents: contents,
      Group: this.transparent
        ? { Type: pdfName('Group'), S: pdfName('Transparency'), CS: pdfName('DeviceRGB') }
        : undefined,
    });
  }

  /**
   * @param own 节点自己的变换（画板作为页面时是单位矩阵）
   * @param page 页面在画板坐标里的范围，透明组的范围由它推出来
   * @param parentToPage 父节点坐标 → 页面坐标
   */
  private drawNode(
    content: ContentStream,
    node: SceneNode,
    own: Matrix,
    page: readonly [number, number, number, number],
    parentToPage: Matrix,
  ): void {
    if (!node.visible) return;
    const def = this.c.registry.get(node.type);
    if (!def) return;
    const toPage = multiply(parentToPage, own);
    const isContainer = def.children === 'draw' || def.children === 'clip';
    const special = node.opacity < 1 || node.blendMode !== 'normal';
    // 和渲染器的离屏层条件一致：要先合成再整体透明或混合的，写成透明组
    const layered = special && (isContainer || def.draw !== undefined || paintCount(node) > 1);

    content.save();
    content.transform(own);
    if (layered) {
      const form = new ContentStream();
      this.drawSelf(form, node, def, { opacity: 1, blend: 'normal' }, page, toPage);
      if (!form.empty) {
        const name = this.form(form, toPage, page);
        const state = this.state(node.opacity, node.opacity, node.blendMode);
        if (state) content.graphicsState(state);
        content.xobject(name);
      }
    } else {
      this.drawSelf(content, node, def, { opacity: node.opacity, blend: node.blendMode }, page, toPage);
    }
    content.restore();
  }

  private drawSelf(
    content: ContentStream,
    node: SceneNode,
    def: NodeTypeDef,
    paint: Paint,
    page: readonly [number, number, number, number],
    toPage: Matrix,
  ): void {
    switch (node.type) {
      case 'page':
      case 'group':
        break;
      case 'artboard':
        if (node.fill) this.fillPath(content, this.outline(node), node.fill.color, paint);
        break;
      case 'text':
        this.drawText(content, node, paint);
        break;
      default:
        if (def.draw) this.drawRaster(content, node);
        else this.drawShape(content, node, paint);
    }

    if (def.children === 'clip') {
      content.save();
      this.clipTo(content, this.outline(node));
      for (const child of this.c.store.children(node.id)) this.drawNode(content, child, child.transform, page, toPage);
      content.restore();
    } else if (def.children === 'draw') {
      for (const child of this.c.store.children(node.id)) this.drawNode(content, child, child.transform, page, toPage);
    }
  }

  /** 一段内容写成透明组，返回它的资源名 */
  private form(form: ContentStream, toPage: Matrix, page: readonly [number, number, number, number]): string {
    // 范围取页面在节点本地坐标里的外框：页面外的东西反正看不见
    const inverse = invert(toPage);
    let bbox = [-1e6, -1e6, 1e6, 1e6];
    if (inverse) {
      const [x0, y0, x1, y1] = page;
      const corners = [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
      ].map(([x, y]) => [
        inverse[0] * x! + inverse[2] * y! + inverse[4],
        inverse[1] * x! + inverse[3] * y! + inverse[5],
      ]);
      const xs = corners.map((p) => p[0]!);
      const ys = corners.map((p) => p[1]!);
      bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    const ref = this.writer.stream(
      {
        Type: pdfName('XObject'),
        Subtype: pdfName('Form'),
        BBox: bbox,
        Resources: this.resourcesRef,
        // 隔离的透明组：先在透明的底上合成，再整体和下面混合，和渲染器的离屏层一样
        Group: { Type: pdfName('Group'), S: pdfName('Transparency'), I: true, CS: pdfName('DeviceRGB') },
      },
      form.toBytes(),
    );
    const name = `X${++this.counter}`;
    this.xobjects[name] = ref;
    this.transparent = true;
    return name;
  }

  /** 一组透明度和混合模式的资源名；都是默认值时返回 null */
  private state(fillAlpha: number, strokeAlpha: number, blend: BlendMode): string | null {
    const ca = Math.round(Math.max(0, Math.min(1, fillAlpha)) * 1000) / 1000;
    const CA = Math.round(Math.max(0, Math.min(1, strokeAlpha)) * 1000) / 1000;
    if (ca === 1 && CA === 1 && blend === 'normal') return null;
    this.transparent = true;
    const key = `${ca}|${CA}|${blend}`;
    let name = this.stateNames.get(key);
    if (!name) {
      name = `G${this.stateNames.size + 1}`;
      this.stateNames.set(key, name);
      this.states[name] = this.writer.add({
        Type: pdfName('ExtGState'),
        ca,
        CA,
        BM: pdfName(BLEND_NAMES[blend]),
      });
    }
    return name;
  }

  // ───────────── 形状 ─────────────

  private outline(node: SceneNode): { data: number[]; evenOdd: boolean } {
    const path = this.c.geometry.outlineOf(node);
    return { data: toPathData(this.c.ck, path), evenOdd: path.getFillType() === this.c.ck.FillType.EvenOdd };
  }

  private clipTo(content: ContentStream, outline: { data: number[]; evenOdd: boolean }): void {
    content.path(outline.data).clip(outline.evenOdd);
  }

  private fillPath(content: ContentStream, outline: { data: number[]; evenOdd: boolean }, color: Color, paint: Paint) {
    if (outline.data.length === 0) return;
    content.save();
    const state = this.state(color.a * paint.opacity, 1, paint.blend);
    if (state) content.graphicsState(state);
    content.fillColor(color).path(outline.data).fill(outline.evenOdd);
    content.restore();
  }

  private drawShape(content: ContentStream, node: SceneNode, paint: Paint): void {
    if (!hasShapeStyle(node)) return;
    const outline = this.outline(node);
    if (outline.data.length === 0) return;
    const { fill } = node;
    const stroke = node.stroke && node.stroke.width > 0 ? node.stroke : null;

    // 纯色填充加不透明的描边：用一条"填充并描边"指令，读回来还是一个对象，文件也小。
    // 描边半透明时不能这样合：PDF 规定这条指令的描边不叠在填充上，而是直接盖掉它，和画布上不一样
    if (fill?.type === 'solid' && stroke && stroke.color.a >= 1 && paint.opacity >= 1) {
      content.save();
      const state = this.state(fill.color.a, 1, paint.blend);
      if (state) content.graphicsState(state);
      content.fillColor(fill.color).strokeColor(stroke.color).lineWidth(stroke.width).miterLimit(MITER_LIMIT);
      content.path(outline.data).raw(outline.evenOdd ? 'B*' : 'B');
      content.restore();
      return;
    }
    if (fill?.type === 'solid') this.fillPath(content, outline, fill.color, paint);
    else if (fill?.type === 'image') this.drawImageFill(content, node, fill, outline, paint);
    if (stroke) {
      content.save();
      const state = this.state(1, stroke.color.a * paint.opacity, paint.blend);
      if (state) content.graphicsState(state);
      content.strokeColor(stroke.color).lineWidth(stroke.width).miterLimit(MITER_LIMIT).path(outline.data).stroke();
      content.restore();
    }
  }

  // ───────────── 图片 ─────────────

  private drawImageFill(
    content: ContentStream,
    node: SceneNode,
    fill: ImageFill,
    outline: { data: number[]; evenOdd: boolean },
    paint: Paint,
  ): void {
    const image = this.c.images.get(fill.assetId);
    if (!image) {
      // 和画布上一样：图片缺失时画一块浅灰占位
      this.fillPath(content, outline, MISSING_IMAGE_COLOR, paint);
      return;
    }
    const box = this.c.geometry.localBounds(node);
    const place = placeImage(image.width(), image.height(), box, fill);
    const placed = this.imageObject(fill, image, place.sx);
    if (!placed) return;
    content.save();
    this.clipTo(content, outline);
    const state = this.state(paint.opacity, 1, paint.blend);
    if (state) content.graphicsState(state);
    // 图片占据单位正方形、第一行在上面；我们的 y 轴向下，所以要再翻一次
    const w = placed.width * place.sx;
    const h = placed.height * place.sy;
    const x = place.tx - placed.pad * place.sx;
    const y = place.ty - placed.pad * place.sy;
    content.transform([w, 0, 0, -h, x, y + h]).xobject(placed.name);
    content.restore();
  }

  /**
   * 图片资源。没调整过的 JPEG 原样放；其余的取像素，调色和模糊先在像素上做好。
   * 模糊之后图片边缘会向外扩散（"适应"铺放时尤其明显），所以四周留出一圈空白，pad 是它的宽度（像素）。
   * @param scale 图片的一个像素在本地坐标里有多大，用来把模糊半径换算成像素
   */
  private imageObject(
    fill: ImageFill,
    image: Image,
    scale: number,
  ): { name: string; width: number; height: number; pad: number } | null {
    const { ck } = this.c;
    const matrix = adjustmentMatrix(fill.adjust);
    const sigma = Math.max(0, fill.adjust?.blur ?? 0) / 2 / Math.max(scale, 1e-6);
    const blurred = sigma > 0.01;
    const pad = blurred && fill.fit === 'contain' ? Math.ceil(sigma * 3) : 0;
    const width = image.width() + pad * 2;
    const height = image.height() + pad * 2;
    const key = `${fill.assetId}|${matrix?.join(',') ?? ''}|${blurred ? `${sigma.toFixed(2)}|${fill.fit}` : ''}`;
    const cached = this.imageNames.get(key);
    if (cached) return { name: cached, width, height, pad };

    let ref: PdfRef | null = null;
    if (!matrix && !blurred && this.c.assets.meta(fill.assetId)?.mime === 'image/jpeg') {
      const bytes = this.c.assets.get(fill.assetId);
      if (bytes) ref = writeJpeg(this.writer, bytes);
    }
    if (!ref) {
      let source = image;
      let surface = null;
      if (matrix || blurred) {
        surface = ck.MakeSurface(width, height);
        if (!surface) return null;
        const canvas = surface.getCanvas();
        canvas.clear(ck.TRANSPARENT);
        // 和画布上一样用图片着色器填满一个矩形，而不是 drawImage：
        // 实测 drawImage 加模糊时，半透明的边缘颜色会被多乘一次透明度，变成一圈暗边
        const paint = new ck.Paint();
        paint.setColor(ck.Color4f(1, 1, 1, 1));
        const tile = fill.fit === 'contain' ? ck.TileMode.Decal : ck.TileMode.Clamp;
        const shader = image.makeShaderOptions(tile, tile, ck.FilterMode.Linear, ck.MipmapMode.None, [
          1,
          0,
          pad,
          0,
          1,
          pad,
          0,
          0,
          1,
        ]);
        const colorFilter = matrix ? ck.ColorFilter.MakeMatrix(matrix) : null;
        const blur = blurred ? ck.ImageFilter.MakeBlur(sigma, sigma, tile, null) : null;
        paint.setShader(shader);
        paint.setColorFilter(colorFilter);
        paint.setImageFilter(blur);
        canvas.drawRect(ck.LTRBRect(0, 0, width, height), paint);
        paint.delete();
        shader.delete();
        colorFilter?.delete();
        blur?.delete();
        source = surface.makeImageSnapshot();
      }
      const pixels = source.readPixels(0, 0, {
        width,
        height,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      if (surface) {
        source.delete();
        surface.delete();
      }
      if (!pixels) return null;
      ref = writeRgbaImage(this.writer, { width, height, pixels: pixels as Uint8Array });
    }
    const name = `I${this.imageNames.size + 1}`;
    this.imageNames.set(key, name);
    this.xobjects[name] = ref;
    return { name, width, height, pad };
  }

  /** 画成图片放进去 */
  private drawRaster(content: ContentStream, node: SceneNode): void {
    const raster = this.c.rasterize?.(node);
    if (!raster) return;
    const { ck } = this.c;
    const image = ck.MakeImageFromEncoded(raster.png);
    if (!image) return;
    const width = image.width();
    const height = image.height();
    const pixels = image.readPixels(0, 0, {
      width,
      height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    image.delete();
    if (!pixels) return;
    const name = `I${this.imageNames.size + 1}`;
    this.imageNames.set(`raster:${name}`, name);
    this.xobjects[name] = writeRgbaImage(this.writer, { width, height, pixels: pixels as Uint8Array });
    const { box } = raster;
    content
      .save()
      .transform([box.w, 0, 0, -box.h, box.x, box.y + box.h])
      .xobject(name)
      .restore();
  }

  // ───────────── 文字 ─────────────

  /**
   * 先把要写的文字都排好版，认出每段字用的是哪个字体文件，再把这些字体文件的可嵌入版本取来。
   * 取字体文件是异步的，所以放在写页面之前一次做完。
   */
  private async prepareText(boards: readonly ArtboardNode[]): Promise<void> {
    const needed = new Map<string, LoadedFace>();
    const visit = (node: SceneNode): void => {
      if (!node.visible) return;
      if (node.type === 'text') {
        const shaped = this.shape(node, needed);
        if (shaped) this.shaped.set(node.id, shaped);
      }
      for (const child of this.c.store.children(node.id)) visit(child);
    };
    for (const board of boards) visit(board);

    const failed = new Set<string>();
    await Promise.all(
      [...needed.values()].map(async (face) => {
        try {
          const font = parseSfnt(new Uint8Array(await face.embeddable()));
          const name = `F${++this.counter}`;
          const ref = this.writer.alloc();
          this.embedded.set(face.key, { name, ref, font: new EmbeddedFont(font, face.key) });
          this.fontResources[name] = ref;
        } catch (error) {
          console.warn(`[shiba] 字体无法嵌入 PDF：${face.key}`, error);
          failed.add(face.key);
        }
      }),
    );
    // 有字体文件取不到的文字只能画成图片
    if (failed.size > 0) {
      for (const [id, shaped] of this.shaped) {
        if (shaped !== 'raster' && shaped.runs.some((run) => failed.has(run.face))) this.shaped.set(id, 'raster');
      }
    }
  }

  /** 排版一个文本节点，记下每段字的字体文件。按保真外观显示的文字不需要 */
  private shape(node: TextNode, needed: Map<string, LoadedFace>): ShapedText | null {
    if (!node.fill || (hasLiveAppearance(node) && this.frozenReady(node))) return null;
    const { style } = node;
    const names = this.c.fonts.resolve(
      [style.fontFamily.latin, style.fontFamily.cjk],
      node.text,
      style.fontWeight,
    ).names;
    const toUtf16 = utf8Offsets(node.text);
    const runs: ShapedRun[] = [];
    for (const line of this.c.layouts.get(node).paragraph.getShapedLines()) {
      for (const run of line.runs) {
        const count = run.glyphs.length;
        const text: string[] = [];
        for (let i = 0; i < count; i++) {
          const from = toUtf16.get(run.offsets[i]!);
          const to = toUtf16.get(run.offsets[i + 1]!);
          text.push(from !== undefined && to !== undefined && to > from ? node.text.slice(from, to) : '');
        }
        const face = this.identify(run, text.join(''), names, style.fontWeight);
        (run.typeface as Typeface | null)?.delete();
        if (!face) return 'raster';
        needed.set(face.key, face);
        runs.push({
          face: face.key,
          size: run.size,
          glyphs: Uint16Array.from(run.glyphs.subarray(0, count)),
          positions: Float32Array.from(run.positions.subarray(0, count * 2)),
          text,
        });
      }
    }
    return { runs };
  }

  /**
   * 认出一段排好的字用的是哪个字体文件。排版引擎给的结果里有它用的字体，但认不出是哪个文件；
   * 所以拿这段字在这个字体里的字形编号，和每个候选文件比，编号完全一样的就是它。
   * 同一个家族的不同分片覆盖不同的字，所以几乎不会认错；真有几个都一样，取排在前面的，排版引擎也是这么选的。
   */
  private identify(run: SkGlyphRun, text: string, names: readonly string[], weight: number): LoadedFace | null {
    const actual = (run.typeface as Typeface | null)?.getGlyphIDs(text) ?? null;
    let fallback: LoadedFace | null = null;
    for (const name of names) {
      const face = this.c.fonts.loadedFace(name, weight);
      if (!face) continue;
      fallback ??= face;
      if (!actual) return face;
      const typeface = this.typeface(face);
      if (typeface && sameIds(typeface.getGlyphIDs(text), actual)) return face;
    }
    return fallback;
  }

  private typeface(face: LoadedFace): Typeface | null {
    if (!this.typefaces.has(face.key)) {
      this.typefaces.set(face.key, this.c.ck.Typeface.MakeTypefaceFromData(face.bytes.slice(0)));
    }
    return this.typefaces.get(face.key) ?? null;
  }

  private drawText(content: ContentStream, node: TextNode, paint: Paint): void {
    if (!node.fill) return;
    const color = node.fill.color;
    if (hasLiveAppearance(node) && this.frozenReady(node)) {
      this.drawFrozenText(content, node, color, paint);
      return;
    }
    const shaped = this.shaped.get(node.id);
    if (!shaped) return;
    if (shaped === 'raster') {
      this.drawRaster(content, node);
      return;
    }
    content.save();
    const state = this.state(color.a * paint.opacity, 1, paint.blend);
    if (state) content.graphicsState(state);
    content.fillColor(color).beginText();
    // 字距等文字状态在 q / Q 之间有效，restore 之后自动回到默认值
    const textState: TextState = { spacing: 0 };
    for (const run of shaped.runs) {
      const embedded = this.embedded.get(run.face);
      if (!embedded) continue;
      const { font } = embedded;
      const { size, glyphs, positions } = run;
      content.font(embedded.name, size);
      const writer = new GlyphWriter(content, size, textState);
      for (let i = 0; i < glyphs.length; i++) {
        const glyph = glyphs[i]!;
        const x = positions[i * 2]!;
        const y = positions[i * 2 + 1]!;
        // 字号写在 Tf 里，文字矩阵只负责位置和把 y 轴翻回来
        writer.glyph(font.use(glyph, run.text[i]!), x, y, font.width(glyph) / 1000, () => [1, 0, 0, -1, x, y]);
      }
      writer.flush();
    }
    content.endText().restore();
  }

  /** 保真外观用到的字形库都在 */
  private frozenReady(node: TextNode): boolean {
    return node.appearance!.runs.every((run) => this.c.appearances.library(run.library) !== null);
  }

  /** 按原文件的字形写字：字形做成 Type3 字体，每个字放在原来的位置 */
  private drawFrozenText(content: ContentStream, node: TextNode, color: Color, paint: Paint): void {
    content.save();
    const state = this.state(color.a * paint.opacity, 1, paint.blend);
    if (state) content.graphicsState(state);
    content.fillColor(color).beginText();
    const textState: TextState = { spacing: 0 };
    for (const run of node.appearance!.runs) {
      const library = this.c.appearances.library(run.library)!;
      const [a, b, c, d] = run.matrix;
      let current: { name: string; font: OutlineFont } | null = null;
      // Type3 字体的字号写 1，大小和方向全在文字矩阵里
      let writer: GlyphWriter | null = null;
      for (let i = 0; i < run.glyphs.length; i += 3) {
        const index = run.glyphs[i]!;
        const outline = library.glyphs[index];
        if (!outline) continue;
        const x = run.glyphs[i + 1]!;
        const y = run.glyphs[i + 2]!;
        const target = this.outlineFont(run.library, index);
        if (target !== current) {
          writer?.flush();
          current = target;
          content.font(target.name, 1);
          writer = new GlyphWriter(content, 1, textState, [a, b, c, d]);
        }
        const glyph = { outline, advance: library.advances?.[index] ?? null, text: library.text?.[index] ?? '' };
        const code = current.font.use(index, glyph);
        writer!.glyph(code, x, y, current.font.advance(parseInt(code, 16)), () => [a, b, c, d, x, y]);
      }
      writer?.flush();
    }
    content.endText().restore();
  }

  /** 放得下这个字形的 Type3 字体：已经有它的、或者还没满的；都没有就新建一个 */
  private outlineFont(library: string, index: number): { name: string; font: OutlineFont } {
    let fonts = this.outlineFonts.get(library);
    if (!fonts) this.outlineFonts.set(library, (fonts = []));
    const existing = fonts.find((f) => f.font.has(index));
    if (existing) return existing;
    const last = fonts[fonts.length - 1];
    if (last && !last.font.full) return last;
    const name = `T${++this.counter}`;
    const ref = this.writer.alloc();
    const entry = { name, ref, font: new OutlineFont() };
    fonts.push(entry);
    this.fontResources[name] = ref;
    return entry;
  }
}

/** 一个文字对象（BT 到 ET）里当前的字距设置（Tc），几个 GlyphWriter 共用 */
interface TextState {
  /** 当前的字距，用 TJ 调整量的单位（千分之一字号，正数往回退）表示 */
  spacing: number;
}

/**
 * 把一串定好位置的字写成尽量少的文字指令：同一条基线上的字放进一个 TJ，
 * 字与字之间和默认宽度不一样的距离写成调整量；换行或者方向不对时重设文字矩阵。
 *
 * 大多数字之间都多出来的那一份距离（字距、中文两端对齐时每个字之间拉开的距离）用字距指令 Tc 写，
 * 不写成一个个调整量：阅读器复制文字时会把较大的调整量当成词与词的间隔，在每个字之间都补上空格，
 * 复制出来的中文就成了"导 出 文 字"，也搜不到。
 */
class GlyphWriter {
  private codes: string[] = [];
  /** 第 i 个字前面的调整量（TJ 的单位）；第一个字没有 */
  private gaps: number[] = [];
  /** 当前文字矩阵的线性部分的逆，用来把本地坐标的位移换算到文字空间 */
  private readonly inverse: [number, number, number, number];
  private origin: [number, number] | null = null;
  /** 下一个字按默认宽度会落在文字空间的哪里 */
  private pen = 0;

  constructor(
    private readonly content: ContentStream,
    /** Tf 里写的字号 */
    private readonly size: number,
    private readonly state: TextState,
    linear: readonly [number, number, number, number] = [1, 0, 0, -1],
  ) {
    const [a, b, c, d] = linear;
    const det = a * d - b * c || 1;
    this.inverse = [d / det, -b / det, -c / det, a / det];
  }

  /**
   * @param code 字形代码（十六进制）
   * @param x 字的原点，本地坐标
   * @param advance 字的默认宽度，以字号为 1 个单位
   * @param matrix 需要重设文字矩阵时用的矩阵
   */
  glyph(code: string, x: number, y: number, advance: number, matrix: () => Matrix): void {
    let restart = this.origin === null;
    let shift = 0;
    if (this.origin) {
      const dx = x - this.origin[0];
      const dy = y - this.origin[1];
      // 位移换算到文字空间，再除以字号就是以字号为单位
      const u = (this.inverse[0] * dx + this.inverse[2] * dy) / this.size;
      const v = (this.inverse[1] * dx + this.inverse[3] * dy) / this.size;
      if (Math.abs(v) > 1e-3) restart = true;
      else shift = u - this.pen;
      if (Math.abs(shift) > 50) restart = true;
    }
    if (restart) {
      this.flush();
      this.content.textMatrix(matrix());
      this.origin = [x, y];
      this.pen = 0;
      shift = 0;
    }
    // TJ 里的数是千分之一字号，正数往回退
    if (this.codes.length > 0) this.gaps.push(Math.round(-shift * 1000 * 100) / 100);
    this.codes.push(code);
    this.pen += shift + advance;
  }

  flush(): void {
    if (this.codes.length === 0) return;
    const spacing = commonGap(this.gaps);
    if (spacing !== this.state.spacing) {
      this.content.raw(`${formatNumber((-spacing / 1000) * this.size)} Tc`);
      this.state.spacing = spacing;
    }
    const items: (string | number)[] = [this.codes[0]!];
    for (let i = 1; i < this.codes.length; i++) {
      const rest = Math.round((this.gaps[i - 1]! - spacing) * 100) / 100;
      if (Math.abs(rest) >= 0.05) items.push(rest);
      const last = items[items.length - 1];
      if (typeof last === 'string') items[items.length - 1] = last + this.codes[i]!;
      else items.push(this.codes[i]!);
    }
    this.content.showText(items);
    this.codes = [];
    this.gaps = [];
  }
}

/**
 * 一串调整量里占多数的那个值，当作统一的字距；没有占到一半的、或者大到不像字距的（超过半个字）返回 0
 */
function commonGap(gaps: readonly number[]): number {
  if (gaps.length === 0) return 0;
  const counts = new Map<number, number>();
  let best = 0;
  let bestCount = 0;
  for (const gap of gaps) {
    // 排版结果有浮点误差，按十分之一个单位归并
    const key = Math.round(gap * 10) / 10;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  if (bestCount * 2 < gaps.length || Math.abs(best) > 500 || Math.abs(best) < 0.05) return 0;
  return best;
}

function sameIds(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** UTF-8 字节偏移 → JavaScript 字符串下标。排版引擎给的字符位置是前者 */
function utf8Offsets(text: string): Map<number, number> {
  const map = new Map<number, number>();
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    map.set(bytes, index);
    const cp = char.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    index += char.length;
  }
  map.set(bytes, index);
  return map;
}

function paintCount(node: SceneNode): number {
  if (!hasShapeStyle(node)) return 0;
  return (node.fill ? 1 : 0) + (node.stroke && node.stroke.width > 0 ? 1 : 0);
}

/**
 * Skia 路径 → 导入器用的那种路径数据（0 移动、1 直线、2 三次、3 二次、4 闭合）。
 * Skia 的椭圆和圆角用的是圆锥曲线，PDF 没有，换成三次曲线：
 * 对 90° 的圆弧这正是通常画圆用的那组控制点，对更小的弧误差也远小于一个像素。
 */
export function toPathData(ck: CanvasKit, path: Path): number[] {
  const cmds = path.toCmds();
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < cmds.length;) {
    const verb = cmds[i++]!;
    if (verb === ck.MOVE_VERB || verb === ck.LINE_VERB) {
      x = cmds[i++]!;
      y = cmds[i++]!;
      out.push(verb === ck.MOVE_VERB ? 0 : 1, x, y);
    } else if (verb === ck.QUAD_VERB) {
      out.push(3, cmds[i]!, cmds[i + 1]!, cmds[i + 2]!, cmds[i + 3]!);
      x = cmds[i + 2]!;
      y = cmds[i + 3]!;
      i += 4;
    } else if (verb === ck.CONIC_VERB) {
      const [cx, cy, ex, ey, w] = [cmds[i]!, cmds[i + 1]!, cmds[i + 2]!, cmds[i + 3]!, cmds[i + 4]!];
      i += 5;
      const k = (4 * w) / (3 * (1 + w));
      out.push(2, x + k * (cx - x), y + k * (cy - y), ex + k * (cx - ex), ey + k * (cy - ey), ex, ey);
      x = ex;
      y = ey;
    } else if (verb === ck.CUBIC_VERB) {
      out.push(2, cmds[i]!, cmds[i + 1]!, cmds[i + 2]!, cmds[i + 3]!, cmds[i + 4]!, cmds[i + 5]!);
      x = cmds[i + 4]!;
      y = cmds[i + 5]!;
      i += 6;
    } else if (verb === ck.CLOSE_VERB) {
      out.push(4);
    } else {
      break;
    }
  }
  return out;
}
