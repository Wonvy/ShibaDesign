import type { Image } from 'canvaskit-wasm';
import {
  IDENTITY,
  dashPattern,
  gradientGeometry,
  hasShapeStyle,
  rectNeedsCorners,
  invert,
  maskParts,
  multiply,
  normalizeStops,
  radialEllipseMatrix,
  transformRect,
  translation,
  unionRects,
  worldTransform,
  type ArtboardNode,
  type Color,
  type GradientFill,
  type ImageFill,
  type Matrix,
  type NodeId,
  type Rect,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import {
  GlyphOutlines,
  WebFonts,
  dataUrl,
  escapeText,
  jpegInfo,
  parseSfnt,
  serializeSvg,
  svgColor,
  svgEl,
  svgMatrix,
  svgNumber,
  svgOpacity,
  svgPath,
  xmlSafe,
  type SfntFont,
  type SvgElement,
} from '@shiba/io';
import { bakeImage, bakePlan } from './bake';
import { placeImage } from './images';
import { isPlainShape, type NodeTypeDef } from './node-types';
import { toPathData } from './path-data';
import type { PdfExportContext } from './pdf';
import type { LoadedFace } from './text/fonts';
import { appendRunGlyphs } from './text/outline';
import { TextShaper, type ShapedRun, type ShapedText } from './text/shaped';

/**
 * 把画板导出成 SVG，每个画板一个文件。和导出 PDF 一样是遍历节点树，只是写的是 SVG 元素：
 * - 形状：矩形、椭圆写成 <rect>、<ellipse>，其余写成路径；填充、描边、不透明度原样写；
 * - 渐变写成 SVG 的线性、径向渐变，几何直接用节点的本地坐标；椭圆的径向渐变用 gradientTransform 压扁；
 * - 混合模式写成 CSS 的 mix-blend-mode，16 种一一对应；不透明度写在元素上就是"先合成再整体透明"，和画布的离屏层一样；
 * - 蒙版组：按轮廓裁剪的写成 <clipPath>，按透明度、亮度遮的写成 <mask>（mask-type 区分两种）；
 * - 图片放在 <defs> 里，用 <use> 摆到形状里，再按形状的轮廓裁剪；调色和模糊先烤进像素；
 * - 文字两种写法（见 SvgTextMode）。
 *
 * 1 个文档单位是 SVG 的 1 个用户单位（CSS 像素）。
 *
 * 这个模块单独作为 @shiba/renderer/svg 导出，只有导出时才用得到，宿主可以按需加载。
 */

export type SvgExportContext = PdfExportContext;

/**
 * 文字怎么写：
 * - text：真正的文字。用到的字体做成子集内嵌在文件里，每个字按排版引擎给出的位置摆放，样子和画布上一致；
 *   可以搜索、选中、复制，在装了同样字体的设计软件里可以直接改字。
 * - outline：转成轮廓。每段字是一条路径，在哪里打开都一样，但不再是文字。
 */
export type SvgTextMode = 'text' | 'outline';

export interface SvgExportOptions {
  text: SvgTextMode;
  /** 写进 <title> 的标题 */
  title?: string;
}

/** 导出一个画板，返回 SVG 文件的内容 */
export async function exportSvg(
  context: SvgExportContext,
  artboard: NodeId,
  options: SvgExportOptions,
): Promise<string> {
  const board = context.store.get(artboard);
  if (board?.type !== 'artboard') throw new Error(`not an artboard: ${artboard}`);
  const exporter = new SvgExporter(context, options.text);
  try {
    await exporter.prepare([board]);
    return exporter.document(board, options.title);
  } finally {
    exporter.dispose();
  }
}

/**
 * 导出选中的几个对象，返回 SVG 文件的内容。画面正好框住这些对象（描边留出余量），
 * 每个对象按它在画布上的位置摆放：父节点的变换算进去，父节点的不透明度、混合模式、蒙版不算。
 * 对象按给的顺序从下到上画，调用方负责排好层序。没有看得见的对象时抛出错误
 */
export async function exportSvgNodes(
  context: SvgExportContext,
  ids: readonly NodeId[],
  options: SvgExportOptions,
): Promise<string> {
  const nodes = ids.map((id) => context.store.get(id)).filter((node): node is SceneNode => !!node?.visible);
  if (nodes.length === 0) throw new Error('nothing to export');
  const exporter = new SvgExporter(context, options.text);
  try {
    await exporter.prepare(nodes);
    return exporter.selection(nodes, options.title);
  } finally {
    exporter.dispose();
  }
}

/** 一个图层的 SVG：box 是它对应的本地坐标范围 */
export interface SvgLayer {
  svg: string;
  box: Rect;
}

/**
 * 把一批节点各自写成一段可以内联进网页的 SVG，给网页播放器当图层用（代替渲染成图片）。
 * 字体不写在每个图层里，而是所有图层共用一份 @font-face（fontCss），由播放器放进网页。
 * 元素 id（渐变、裁剪、蒙版、图片）以 SVG_ID_PLACEHOLDER 开头，播放器每次把图层放进网页时换成一个唯一的前缀：
 * 同一个网页里可能同时有好几份一样的图层（平滑切换时前后两页都在），id 重复的话引用会指到别的那份上。
 * 这样同样的内容得到一模一样的字符串，播放器也靠这一点认出"内容没变"。
 */
export class SvgLayers {
  private constructor(private readonly exporter: SvgExporter) {}

  static async create(context: SvgExportContext, nodes: readonly NodeId[]): Promise<SvgLayers> {
    const exporter = new SvgExporter(context, 'text');
    const roots = nodes.map((id) => context.store.get(id)).filter((node): node is SceneNode => !!node);
    await exporter.prepare(roots);
    return new SvgLayers(exporter);
  }

  /** 一个节点（不含它自己的变换和混合模式，含不透明度）。节点不存在或什么都不画时返回 null */
  layer(id: NodeId): SvgLayer | null {
    const node = this.exporter.context.store.get(id);
    return node ? this.exporter.layer(node) : null;
  }

  /** 所有图层用到的字体 */
  fontCss(): string {
    return this.exporter.fonts.css();
  }

  dispose(): void {
    this.exporter.dispose();
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const MISSING_IMAGE_COLOR: Color = { r: 0.82, g: 0.83, b: 0.85, a: 1 };
/**
 * 图层 SVG 里元素 id 的前缀占位符，由播放器换成真正的前缀（见 SvgLayers）。
 * 用一个控制字符：文字里的控制字符写出之前都去掉了，不会和内容混淆
 */
export const SVG_ID_PLACEHOLDER = '\u0001';

type Attrs = Record<string, string | number | null | undefined | false>;

/** 准备好的字体文件：文字模式要解析出来做子集，轮廓模式要读字形轮廓 */
interface PreparedFace {
  face: LoadedFace;
  font: SfntFont;
  outlines: GlyphOutlines | null;
}

/** 烤好、编码好的图片，一张图可以被好几个形状用 */
interface ImageData {
  href: string;
  width: number;
  height: number;
  pad: number;
}

class SvgExporter {
  readonly fonts = new WebFonts();
  private readonly shaper: TextShaper;
  private readonly shaped = new Map<NodeId, ShapedText>();
  /** 字体文件 → 准备好的字体；null 表示取不到或者用不了 */
  private readonly faces = new Map<string, PreparedFace | null>();
  private readonly imageData = new Map<string, ImageData | null>();
  private readonly remapped = new WeakSet<ShapedRun>();
  /** 用到了真正的斜体文件的家族 */
  private readonly italicFamilies = new Set<string>();

  // 以下是正在写的这一份 SVG 的状态
  private prefix = '';
  private counter = 0;
  private defs: SvgElement[] = [];
  /** 图片 → 它在 <defs> 里的 id */
  private imageIds = new Map<string, string>();

  constructor(
    readonly context: SvgExportContext,
    private readonly mode: SvgTextMode,
  ) {
    this.shaper = new TextShaper(context.ck, context.layouts, context.fonts, context.appearances);
  }

  dispose(): void {
    this.shaper.dispose();
  }

  // ───────────── 准备：排版、取字体文件 ─────────────

  async prepare(roots: readonly SceneNode[]): Promise<void> {
    const { store } = this.context;
    const needed = new Map<string, LoadedFace>();
    const visit = (node: SceneNode): void => {
      if (!node.visible) return;
      if (node.type === 'text' && !this.shaper.frozen(node) && !this.shaped.has(node.id)) {
        const shaped = this.shaper.shape(node);
        this.shaped.set(node.id, shaped);
        if (shaped !== 'raster') for (const run of shaped.runs) needed.set(run.face.key, run.face);
      }
      for (const child of store.children(node.id)) visit(child);
    };
    for (const root of roots) visit(root);

    await Promise.all(
      [...needed.values()]
        .filter((face) => !this.faces.has(face.key))
        .map(async (face) => {
          try {
            const font = parseSfnt(new Uint8Array(await face.embeddable()));
            const outlines = this.mode === 'outline' ? new GlyphOutlines(font) : null;
            this.faces.set(face.key, { face, font, outlines });
          } catch (error) {
            console.warn(`[shiba] 字体无法写进 SVG：${face.key}`, error);
            this.faces.set(face.key, null);
          }
        }),
    );

    for (const [id, shaped] of this.shaped) {
      if (shaped === 'raster') continue;
      // 有字体文件用不了的文字只能画成图片
      if (shaped.runs.some((run) => !this.faces.get(run.face.key))) {
        this.shaped.set(id, 'raster');
        continue;
      }
      for (const run of shaped.runs) {
        // 字形编号按嵌入的字体文件对一遍，见 TextShaper.remapToEmbedded。同一段字只对一次
        if (!this.remapped.has(run)) {
          this.shaper.remapToEmbedded(run, this.faces.get(run.face.key)!.font.bytes);
          this.remapped.add(run);
        }
        if (this.mode === 'text') this.registerChars(run);
        if (run.face.italic) this.italicFamilies.add(run.face.family);
      }
    }
  }

  /** 记下一段字要用的字，做字体子集时留下它们的字形 */
  private registerChars(run: ShapedRun): void {
    const prepared = this.faces.get(run.face.key);
    if (!prepared || !run.color) return;
    const chars = new Set<number>();
    for (const text of run.text) for (const char of visibleChars(text)) chars.add(char.codePointAt(0)!);
    const glyphs = new Set<number>(run.glyphs);
    // 浏览器按嵌入字体的字符映射表找字形，排版时用的可能是别的字形（连字、变体），所以映射到的字形也要留下
    const typeface = this.shaper.embeddedTypeface(run.face);
    if (typeface && chars.size > 0) {
      for (const glyph of typeface.getGlyphIDs(String.fromCodePoint(...chars))) glyphs.add(glyph);
    }
    const { face } = prepared;
    this.fonts.use(
      face.key,
      { family: face.family, weight: face.weight, italic: face.italic, font: prepared.font },
      chars,
      glyphs,
    );
  }

  // ───────────── 文件 ─────────────

  document(board: ArtboardNode, title?: string): string {
    this.begin('');
    const [width, height] = board.size;
    const body = this.node(board, IDENTITY, { blend: false, root: true });
    return this.file(width, height, body, title);
  }

  /** 选中的几个对象：画面是它们在世界坐标里的范围，原点挪到范围的左上角 */
  selection(nodes: readonly SceneNode[], title?: string): string {
    this.begin('');
    const { store } = this.context;
    const placed = nodes.map((node) => ({ node, world: worldTransform(store, node.id) }));
    const box = unionRects(placed.map(({ node, world }) => transformRect(world, paddedBounds(this.context, node))));
    if (!box || box.w <= 0 || box.h <= 0) throw new Error('nothing to export');
    const shift = translation(-box.x, -box.y);
    const body = placed.flatMap(({ node, world }) =>
      this.node(node, multiply(shift, world), { blend: true, root: false }),
    );
    return this.file(box.w, box.h, body, title);
  }

  /** 一个完整的 SVG 文件：尺寸、标题、<defs>（文字模式下有内嵌字体）和内容 */
  private file(width: number, height: number, body: SvgElement[], title?: string): string {
    const defs: SvgElement[] = [];
    const css = this.mode === 'text' ? this.fonts.css() : '';
    if (css) defs.push(svgEl('style', {}, [escapeText(css)]));
    defs.push(...this.defs);
    const root = svgEl(
      'svg',
      {
        xmlns: SVG_NS,
        'xmlns:xlink': XLINK_NS,
        version: '1.1',
        width,
        height,
        viewBox: `0 0 ${svgNumber(width)} ${svgNumber(height)}`,
      },
      [
        ...(title ? [svgEl('title', {}, [escapeText(xmlSafe(title))])] : []),
        ...(defs.length > 0 ? [svgEl('defs', {}, defs)] : []),
        ...body,
      ],
    );
    return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeSvg(root)}\n`;
  }

  layer(node: SceneNode): SvgLayer | null {
    this.begin(SVG_ID_PLACEHOLDER);
    const body = this.node(node, IDENTITY, { blend: false, root: false });
    if (body.length === 0) return null;
    const box = paddedBounds(this.context, node);
    const root = svgEl(
      'svg',
      {
        xmlns: SVG_NS,
        'xmlns:xlink': XLINK_NS,
        viewBox: [box.x, box.y, box.w, box.h].map(svgNumber).join(' '),
        width: '100%',
        height: '100%',
        preserveAspectRatio: 'none',
        overflow: 'visible',
      },
      [...(this.defs.length > 0 ? [svgEl('defs', {}, this.defs)] : []), ...body],
    );
    return { svg: serializeSvg(root), box };
  }

  private begin(prefix: string): void {
    this.prefix = prefix;
    this.counter = 0;
    this.defs = [];
    this.imageIds = new Map();
  }

  private id(kind: string): string {
    return `${this.prefix}${kind}${++this.counter}`;
  }

  // ───────────── 节点 ─────────────

  private node(node: SceneNode, own: Matrix, options: { blend: boolean; root: boolean }): SvgElement[] {
    if (!node.visible) return [];
    const def = this.context.registry.get(node.type);
    if (!def) return [];
    const content = this.self(node, def);

    if (def.children === 'clip') {
      const children = this.children(this.context.store.children(node.id));
      // 画板裁剪子节点。导出的就是这个画板时，画面本身就是它的范围，不用再裁
      if (options.root) content.push(...children);
      else if (children.length > 0) {
        const clip = this.clipPath(node, null);
        content.push(clip ? svgEl('g', { 'clip-path': `url(#${clip})` }, children) : svgEl('g', {}, children));
      }
    } else if (def.children === 'draw') {
      const { mask, contents } = maskParts(this.context.store, node);
      if (mask?.visible) content.push(...this.masked(node, mask, contents));
      else content.push(...this.children(this.context.store.children(node.id)));
    }
    if (content.length === 0) return [];

    const attrs: Attrs = {
      transform: svgMatrix(own),
      opacity: node.opacity < 1 ? svgNumber(Math.max(0, node.opacity)) : null,
      style: options.blend && node.blendMode !== 'normal' ? `mix-blend-mode:${node.blendMode}` : null,
    };
    return wrap(content, attrs);
  }

  private children(nodes: readonly SceneNode[]): SvgElement[] {
    return nodes.flatMap((child) => this.node(child, child.transform, { blend: true, root: false }));
  }

  private self(node: SceneNode, def: NodeTypeDef): SvgElement[] {
    switch (node.type) {
      case 'page':
      case 'group':
        return [];
      case 'artboard': {
        if (!node.fill) return [];
        const [w, h] = node.size;
        return [svgEl('rect', { width: w, height: h, ...this.fillAttrs(node.fill, { x: 0, y: 0, w, h }) })];
      }
      case 'text':
        return this.text(node);
      default:
        return def.draw ? this.raster(node) : this.shape(node);
    }
  }

  /** 蒙版组：按轮廓裁剪写成 <clipPath>，按透明度或亮度遮写成 <mask> */
  private masked(group: SceneNode, mask: SceneNode, contents: readonly SceneNode[]): SvgElement[] {
    const inner = this.children(contents);
    if (inner.length === 0) return [];
    if (group.type === 'group' && group.mask === 'shape' && isPlainShape(this.context.registry, mask)) {
      const clip = this.clipPath(mask, mask.transform);
      // 蒙版没有轮廓（空路径）时什么都露不出来
      return clip ? [svgEl('g', { 'clip-path': `url(#${clip})` }, inner)] : [];
    }
    const drawn = this.node(mask, mask.transform, { blend: true, root: false });
    if (drawn.length === 0) return [];
    const region = maskRegion(this.context, mask);
    const id = this.id('m');
    const alpha = !(group.type === 'group' && group.mask === 'luminance');
    this.defs.push(
      svgEl(
        'mask',
        {
          id,
          maskUnits: 'userSpaceOnUse',
          x: region.x,
          y: region.y,
          width: region.w,
          height: region.h,
          // 不写时是按亮度遮
          'mask-type': alpha ? 'alpha' : null,
          style: alpha ? 'mask-type:alpha' : null,
        },
        drawn,
      ),
    );
    return [svgEl('g', { mask: `url(#${id})` }, inner)];
  }

  /** 按一个节点的轮廓裁剪的 <clipPath>，返回 id；节点没有轮廓时返回 null */
  private clipPath(node: SceneNode, transform: Matrix | null): string | null {
    const geometry = this.geometry(node);
    if (!geometry) return null;
    const attrs = { ...geometry.attrs };
    if (attrs['fill-rule']) {
      attrs['clip-rule'] = attrs['fill-rule'];
      delete attrs['fill-rule'];
    }
    if (transform) attrs.transform = svgMatrix(transform);
    const id = this.id('c');
    this.defs.push(svgEl('clipPath', { id, clipPathUnits: 'userSpaceOnUse' }, [svgEl(geometry.tag, attrs)]));
    return id;
  }

  // ───────────── 形状 ─────────────

  /**
   * 节点轮廓的写法：矩形、椭圆用对应的元素，在设计软件里打开还是矩形、椭圆；其余写成路径。
   * @param asPath 一律写成路径：虚线从路径的起点开始排，<rect>、<ellipse> 的起点和画布上的不一定一样
   */
  private geometry(node: SceneNode, asPath = false): { tag: string; attrs: Attrs } | null {
    const [w, h] = node.size;
    // 四个角不一样、反向圆角、倒角、有平滑度的矩形写成路径（<rect> 只能表示四个角一样的普通圆角）
    const plainRect = node.type === 'artboard' || (node.type === 'rect' && !rectNeedsCorners(node));
    if (plainRect && w > 0 && h > 0 && !asPath) {
      const r = node.type === 'rect' ? Math.max(0, Math.min(node.cornerRadius, w / 2, h / 2)) : 0;
      return { tag: 'rect', attrs: { width: w, height: h, rx: r > 0 ? r : null, ry: r > 0 ? r : null } };
    }
    if (node.type === 'ellipse' && w > 0 && h > 0 && !asPath) {
      return { tag: 'ellipse', attrs: { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 } };
    }
    const { ck } = this.context;
    const path = this.context.geometry.outlineOf(node);
    const data = toPathData(ck, path);
    if (data.length === 0) return null;
    const evenOdd = path.getFillType() === ck.FillType.EvenOdd;
    return { tag: 'path', attrs: { d: svgPath(data), 'fill-rule': evenOdd ? 'evenodd' : null } };
  }

  private shape(node: SceneNode): SvgElement[] {
    if (!hasShapeStyle(node)) return [];
    const { fill } = node;
    const stroke = node.stroke && node.stroke.width > 0 ? node.stroke : null;
    if (!fill && !stroke) return [];
    const dash = stroke ? dashPattern(stroke) : null;
    const geometry = this.geometry(node, dash !== null);
    if (!geometry) return [];
    const strokeAttrs: Attrs = stroke
      ? {
          stroke: svgColor(stroke.color),
          'stroke-opacity': svgOpacity(stroke.color.a),
          'stroke-width': stroke.width,
          'stroke-linecap': stroke.cap && stroke.cap !== 'butt' ? stroke.cap : null,
          'stroke-linejoin': stroke.join && stroke.join !== 'miter' ? stroke.join : null,
          'stroke-dasharray': dash ? dash.map(svgNumber).join(' ') : null,
          'stroke-dashoffset': dash && stroke.dashOffset ? stroke.dashOffset : null,
        }
      : {};

    if (fill?.type === 'image') {
      const out = this.imageFill(node, fill, geometry);
      if (stroke) out.push(svgEl(geometry.tag, { ...geometry.attrs, fill: 'none', ...strokeAttrs }));
      return out;
    }
    const bounds = this.context.geometry.localBounds(node);
    const fillAttrs: Attrs = fill ? this.fillAttrs(fill, bounds) : { fill: 'none' };
    return [svgEl(geometry.tag, { ...geometry.attrs, ...fillAttrs, ...strokeAttrs })];
  }

  /** 纯色或渐变填充的属性 */
  private fillAttrs(fill: { type: 'solid'; color: Color } | GradientFill, bounds: Rect): Attrs {
    if (fill.type === 'solid') return { fill: svgColor(fill.color), 'fill-opacity': svgOpacity(fill.color.a) };
    const gradient = this.gradient(fill, bounds);
    if (typeof gradient === 'string') return { fill: `url(#${gradient})` };
    return gradient ? { fill: svgColor(gradient), 'fill-opacity': svgOpacity(gradient.a) } : { fill: 'none' };
  }

  /**
   * 渐变定义，返回它的 id。几何直接写在节点的本地坐标里（userSpaceOnUse），和画布上一样；
   * 色标的颜色和透明度分开写，SVG 也是分开过渡的。起止点重合时没有方向，返回最后一个颜色
   */
  private gradient(fill: GradientFill, bounds: Rect): string | Color | null {
    const stops = normalizeStops(fill.stops);
    if (stops.length === 0) return null;
    const last = stops[stops.length - 1]!.color;
    const g = gradientGeometry(fill, bounds);
    const degenerate = fill.kind === 'radial' ? g.radius < 1e-6 : Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 1e-6;
    if (stops.length < 2 || degenerate) return last;
    const id = this.id('g');
    const children = stops.map((stop) =>
      svgEl('stop', {
        offset: Math.min(1, Math.max(0, stop.offset)),
        'stop-color': svgColor(stop.color),
        'stop-opacity': svgOpacity(stop.color.a),
      }),
    );
    if (fill.kind === 'radial') {
      const ellipse = radialEllipseMatrix(fill, bounds);
      this.defs.push(
        svgEl(
          'radialGradient',
          {
            id,
            gradientUnits: 'userSpaceOnUse',
            cx: g.x0,
            cy: g.y0,
            r: g.radius,
            gradientTransform: ellipse ? svgMatrix(ellipse) : null,
          },
          children,
        ),
      );
    } else {
      this.defs.push(
        svgEl(
          'linearGradient',
          { id, gradientUnits: 'userSpaceOnUse', x1: g.x0, y1: g.y0, x2: g.x1, y2: g.y1 },
          children,
        ),
      );
    }
    return id;
  }

  // ───────────── 图片 ─────────────

  /** 图片填充：图片放在 <defs> 里，按铺放方式摆进形状的外框，再裁成形状的轮廓 */
  private imageFill(node: SceneNode, fill: ImageFill, geometry: { tag: string; attrs: Attrs }): SvgElement[] {
    const image = this.context.images.get(fill.assetId);
    if (!image) {
      // 和画布上一样：图片缺失时画一块浅灰占位
      return [svgEl(geometry.tag, { ...geometry.attrs, fill: svgColor(MISSING_IMAGE_COLOR) })];
    }
    const box = this.context.geometry.localBounds(node);
    const place = placeImage(image.width(), image.height(), box, fill);
    const data = this.image(fill, image, place.sx);
    if (!data) return [];
    const clip = this.clipPath(node, null);
    if (!clip) return [];
    const x = place.tx - data.pad * place.sx;
    const y = place.ty - data.pad * place.sy;
    const use = svgEl('use', {
      'xlink:href': `#${this.imageId(fill, image, place.sx, data)}`,
      transform: `matrix(${[place.sx, 0, 0, place.sy, x, y].map(svgNumber).join(' ')})`,
    });
    return [svgEl('g', { 'clip-path': `url(#${clip})` }, [use])];
  }

  /** 这张图在当前这份 SVG 的 <defs> 里的 id，第一次用到时放进去 */
  private imageId(fill: ImageFill, image: Image, scale: number, data: ImageData): string {
    const { key } = bakePlan(fill, image, scale);
    let id = this.imageIds.get(key);
    if (!id) {
      id = this.id('i');
      this.imageIds.set(key, id);
      this.defs.push(
        svgEl('image', {
          id,
          width: data.width,
          height: data.height,
          preserveAspectRatio: 'none',
          'xlink:href': data.href,
        }),
      );
    }
    return id;
  }

  /**
   * 图片的内容。没调整过的 PNG、JPEG 原样放（拍摄方向不正、CMYK 的 JPEG 除外）；
   * 其余的（调过色、模糊过、GIF、BMP）把调整烤进像素，编码成 PNG
   * @param scale 图片的一个像素在本地坐标里有多大
   */
  private image(fill: ImageFill, image: Image, scale: number): ImageData | null {
    const plan = bakePlan(fill, image, scale);
    if (this.imageData.has(plan.key)) return this.imageData.get(plan.key)!;
    let data: ImageData | null = null;
    if (!plan.matrix && !plan.look && plan.sigma === 0) {
      const mime = this.context.assets.meta(fill.assetId)?.mime;
      const bytes = this.context.assets.get(fill.assetId);
      const info = mime === 'image/jpeg' && bytes ? jpegInfo(bytes) : null;
      const usable =
        mime === 'image/png' ||
        (info !== null && info.orientation === 1 && (info.components === 1 || info.components === 3));
      if (bytes && usable) data = { href: dataUrl(mime!, bytes), width: image.width(), height: image.height(), pad: 0 };
    }
    if (!data) {
      const baked = bakeImage(this.context.ck, fill, image, scale);
      const png = baked?.image.encodeToBytes();
      if (baked && png)
        data = { href: dataUrl('image/png', png.slice()), width: baked.width, height: baked.height, pad: baked.pad };
      baked?.dispose();
    }
    this.imageData.set(plan.key, data);
    return data;
  }

  /** 不知道怎么写成矢量的节点画成图片 */
  private raster(node: SceneNode): SvgElement[] {
    const raster = this.context.rasterize?.(node);
    if (!raster) return [];
    const { box, png } = raster;
    return [
      svgEl('image', {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        preserveAspectRatio: 'none',
        'xlink:href': dataUrl('image/png', png),
      }),
    ];
  }

  // ───────────── 文字 ─────────────

  private text(node: TextNode): SvgElement[] {
    if (this.shaper.frozen(node)) return node.fill ? this.frozenText(node, node.fill.color) : [];
    const shaped = this.shaped.get(node.id);
    if (!shaped) return [];
    if (shaped === 'raster') return this.raster(node);
    const out: SvgElement[] = [];
    /** 写成一个 <text> 的各段字。一个文本节点是一个 <text>：选中、复制、搜索时是连着的一整段，在设计软件里也是一个文本对象 */
    const spans: SvgElement[] = [];
    shaped.runs.forEach((run, index) => {
      if (!run.color) return;
      if (this.mode === 'outline') {
        const path = this.outlineRun(run, run.color);
        if (path) out.push(path);
        return;
      }
      // 折行处的空格排版引擎不画，也不在任何一段字里；接在这段字的末尾写出来，复制、搜索时词才不会粘在一起
      const next = shaped.runs[index + 1];
      const trailing = next && next.start > run.stop ? visibleChars(node.text.slice(run.stop, next.start)) : [];
      // 模拟的斜体（字体没有斜体文件，中文字体常见）：写成 font-style="italic"，浏览器同样把字形斜切四分之一，
      // 绕各自的基线，位置不变。只有一种情况不行：这个家族还用到了真正的斜体文件，浏览器会拿那个文件来画，
      // 这时斜切要写在 transform 里，而 <tspan> 上不能写变换，只能单独成一个 <text>
      const separate = run.skew > 0 && this.italicFamilies.has(run.face.family);
      const runSpans = this.textRun(run, run.color, separate, trailing);
      if (runSpans.length === 0) return;
      if (separate) {
        out.push(svgEl('text', { ...TEXT_ATTRS, transform: `matrix(1 0 ${svgNumber(-run.skew)} 1 0 0)` }, runSpans));
      } else spans.push(...runSpans);
    });
    if (spans.length > 0) out.unshift(svgEl('text', TEXT_ATTRS, spans));
    // 下划线和删除线画在字的上面，和排版引擎一样
    for (const run of shaped.runs) {
      if (!run.color) continue;
      for (const line of run.lines) {
        out.push(
          svgEl('rect', {
            x: line.x0,
            y: line.y - line.thickness / 2,
            width: line.x1 - line.x0,
            height: line.thickness,
            fill: svgColor(run.color),
            'fill-opacity': svgOpacity(run.color.a),
          }),
        );
      }
    }
    return out;
  }

  /**
   * 一段字写成 <tspan>：每个字按排版结果给的位置摆（x 是一串数），所以不管看的人那边怎么排版，位置都和画布上一样。
   * 字体没有斜体文件时斜切模拟（见 text()），没有粗体文件时用同色描边模拟，和排版引擎一样
   * @param skewed 斜切写在外面 <text> 的 transform 里，位置要预先补偿
   * @param trailing 接在末尾的字（折行处没画出来的空格），放在这段字的终点
   */
  private textRun(run: ShapedRun, color: Color, skewed: boolean, trailing: readonly string[] = []): SvgElement[] {
    const chars: string[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const count = run.glyphs.length;
    for (let i = 0; i < count; i++) {
      const text = visibleChars(run.text[i] ?? '');
      if (text.length === 0) continue;
      const x = run.positions[i * 2]!;
      const y = run.positions[i * 2 + 1]!;
      // 一个字形代表好几个字（连字）时，把这几个字平分在这个字形占的宽度里
      const next = i + 1 < count ? run.positions[(i + 1) * 2]! : run.end;
      text.forEach((char, k) => {
        chars.push(char);
        // 斜切写在 transform 里时是绕 y = 0 做的：先把位置往右挪，斜切之后正好回到原处
        xs.push(x + ((next - x) * k) / text.length + (skewed ? run.skew * y : 0));
        ys.push(y);
      });
    }
    if (chars.length === 0) return [];
    const lastY = ys[ys.length - 1]!;
    for (const char of trailing) {
      chars.push(char);
      xs.push(run.end + (skewed ? run.skew * lastY : 0));
      ys.push(lastY);
    }
    const prepared = this.faces.get(run.face.key)!;
    const { face } = prepared;
    const attrs: Attrs = {
      'font-family': cssFamily(face.family),
      'font-size': run.size,
      'font-weight': face.weight !== 400 ? Math.round(face.weight) : null,
      'font-style': face.italic || (run.skew > 0 && !skewed) ? 'italic' : null,
      fill: svgColor(color),
      'fill-opacity': svgOpacity(color.a),
      ...(run.embolden > 0
        ? { stroke: svgColor(color), 'stroke-opacity': svgOpacity(color.a), 'stroke-width': run.embolden }
        : {}),
    };
    return positionedText(chars, xs, ys, attrs);
  }

  /** 一段字转成一条路径：字形轮廓从字体文件里读，按排版结果摆好 */
  private outlineRun(run: ShapedRun, color: Color): SvgElement | null {
    const outlines = this.faces.get(run.face.key)?.outlines;
    if (!outlines) return null;
    // 和画布上的"文字转轮廓"是同一份做法
    const data: number[] = [];
    appendRunGlyphs(run, outlines, data);
    if (data.length === 0) return null;
    return svgEl('path', {
      d: svgPath(data),
      fill: svgColor(color),
      'fill-opacity': svgOpacity(color.a),
      ...(run.embolden > 0
        ? { stroke: svgColor(color), 'stroke-opacity': svgOpacity(color.a), 'stroke-width': run.embolden }
        : {}),
    });
  }

  /**
   * 从 PDF 导入、没改过的文字：按原文件的字形画成路径，样子和原文件一样。
   * 写真正文字的模式下，再在上面叠一层看不见的文字，可以搜索、选中和复制，和扫描件 PDF 的识别层一样
   */
  private frozenText(node: TextNode, color: Color): SvgElement[] {
    const out: SvgElement[] = [];
    const { appearances } = this.context;
    for (const run of node.appearance!.runs) {
      const library = appearances.library(run.library)!;
      const [a, b, c, d] = run.matrix;
      let path = '';
      for (let i = 0; i < run.glyphs.length; i += 3) {
        const outline = library.glyphs[run.glyphs[i]!];
        if (!outline || outline.length === 0) continue;
        const x = run.glyphs[i + 1]!;
        const y = run.glyphs[i + 2]!;
        path += svgPath(outline, (u, v) => [x + a * u + c * v, y + b * u + d * v]);
      }
      if (!path) continue;
      const fill = run.color ?? color;
      out.push(svgEl('path', { d: path, fill: svgColor(fill), 'fill-opacity': svgOpacity(fill.a) }));
    }
    if (this.mode === 'text') out.push(...this.hiddenText(node));
    return out;
  }

  /**
   * 保真外观文字上面那层看不见的文字。每个字形记着它代表的文字；字形之间没画出来的字（多半是空格，
   * PDF 里常常不画空格）从节点的文字里按顺序找回来，放在前一个字形的末尾
   */
  private hiddenText(node: TextNode): SvgElement[] {
    // 方向相同的几段字放进同一个 <text>，选中、复制时是连着的
    const groups = new Map<string, { linear: Matrix; spans: SvgElement[] }>();
    const { appearances } = this.context;
    const source = node.text;
    let cursor = 0;
    /** 上一个字形的终点（本地坐标）。跨段保留：两段字之间的空格也要找回来 */
    let previousEnd: [number, number] | null = null;
    for (const run of node.appearance!.runs) {
      const library = appearances.library(run.library)!;
      const [a, b, c, d] = run.matrix;
      // 字号取字形纵向的大小；文字的方向和斜切写进 transform，位置换算到文字自己的坐标里
      const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;
      const linear: Matrix = [a / size, b / size, -c / size, -d / size, 0, 0];
      const inverse = invert(linear);
      if (!inverse) continue;
      const chars: string[] = [];
      const xs: number[] = [];
      const ys: number[] = [];
      const push = (char: string, x: number, y: number): void => {
        chars.push(char);
        xs.push(inverse[0] * x + inverse[2] * y);
        ys.push(inverse[1] * x + inverse[3] * y);
      };
      for (let i = 0; i < run.glyphs.length; i += 3) {
        const index = run.glyphs[i]!;
        const text = library.text?.[index] ?? '';
        if (!text) continue;
        const x = run.glyphs[i + 1]!;
        const y = run.glyphs[i + 2]!;
        const found = source.indexOf(text, cursor);
        if (found >= 0 && found - cursor <= 8) {
          const at = previousEnd ?? [x, y];
          for (const char of visibleChars(source.slice(cursor, found))) push(char, at[0], at[1]);
          cursor = found + text.length;
        }
        for (const char of visibleChars(text)) push(char, x, y);
        const advance = library.advances?.[index] ?? 0.5;
        previousEnd = [x + a * advance, y + b * advance];
      }
      if (chars.length === 0) continue;
      const key = linear.map((v) => v.toFixed(4)).join(',');
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { linear, spans: [] }));
      group.spans.push(
        ...positionedText(chars, xs, ys, {
          'font-family': `${cssFamily(node.style.fontFamily.latin)}, ${cssFamily(node.style.fontFamily.cjk)}`,
          'font-size': size,
        }),
      );
    }
    return [...groups.values()].map(({ linear, spans }) =>
      svgEl('text', { ...TEXT_ATTRS, 'fill-opacity': '0', transform: svgMatrix(linear) }, spans),
    );
  }
}

// ───────────── 小工具 ─────────────

/**
 * 给一组元素加上变换、不透明度、混合模式。只有一个元素、并且它自己没有同名的属性时直接加在它身上，
 * 不另包一层 <g>：一个形状导出来就是一个 <rect> 或 <path>，在设计软件里打开不会多出一层编组。
 * 元素上已有的裁剪、蒙版不妨碍：它们和内容一样在元素自己的坐标里，加上变换后一起变换，先裁剪再整体透明，效果和多包一层相同
 */
function wrap(content: SvgElement[], attrs: Attrs): SvgElement[] {
  const present = Object.entries(attrs).filter(([, value]) => value !== null && value !== undefined && value !== false);
  if (present.length === 0) return content;
  const only = content.length === 1 ? content[0]! : null;
  if (only && !present.some(([key]) => key in only.attrs)) {
    for (const [key, value] of present) only.attrs[key] = String(value);
    return [only];
  }
  return [svgEl('g', attrs, content)];
}

/** <text> 元素的公共属性：空白原样保留（位置是逐字给的，空格也占一个位置） */
const TEXT_ATTRS: Attrs = { 'xml:space': 'preserve', style: 'white-space:pre' };

/**
 * 一串定好位置的字 → 若干个 <tspan>，每个都带上 attrs（字体、颜色等）。
 * 基本平面以外的字（生僻字、表情）各自单独放一个 <tspan>：不同的浏览器对它们算一个字还是两个字有分歧，
 * 单独放就不会让后面的位置错开
 */
function positionedText(chars: string[], xs: number[], ys: number[], attrs: Attrs = {}): SvgElement[] {
  const out: SvgElement[] = [];
  let start = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    const ySlice = ys.slice(start, end);
    const flat = ySlice.every((y) => Math.abs(y - ySlice[0]!) < 1e-3);
    out.push(
      svgEl(
        'tspan',
        {
          x: xs.slice(start, end).map(svgNumber).join(' '),
          y: flat ? svgNumber(ySlice[0]!) : ySlice.map(svgNumber).join(' '),
          ...attrs,
        },
        [escapeText(chars.slice(start, end).join(''))],
      ),
    );
    start = end;
  };
  for (let i = 0; i < chars.length; i++) {
    if (chars[i]!.length === 1) continue;
    flush(i);
    flush(i + 1);
  }
  flush(chars.length);
  return out;
}

/** 一段文字里要写出来的字，按码点拆开：去掉换行等控制字符和 XML 不允许的字符，制表符换成空格 */
function visibleChars(text: string): string[] {
  const out: string[] = [];
  for (const char of xmlSafe(text.replace(/\t/g, ' '))) {
    if (char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029') continue;
    out.push(char);
  }
  return out;
}

/** 属性里的字体家族名，用单引号（双引号在属性里要转义，不好读）；和 @font-face 里的名字一致 */
function cssFamily(name: string): string {
  // eslint-disable-next-line no-control-regex
  return `'${name.replace(/[\u0000-\u001f<>]/g, '').replace(/['\\]/g, '\\$&')}'`;
}

/** 节点的外框，四周留出描边的一半和一点余量。和渲染成图层图片时的范围一致 */
function paddedBounds(context: SvgExportContext, node: SceneNode): Rect {
  let padding = 1;
  const visit = (item: SceneNode): void => {
    if (hasShapeStyle(item) && item.stroke) padding = Math.max(padding, item.stroke.width / 2 + 1);
    for (const child of context.store.children(item.id)) visit(child);
  };
  visit(node);
  const bounds = context.geometry.localBounds(node);
  return { x: bounds.x - padding, y: bounds.y - padding, w: bounds.w + padding * 2, h: bounds.h + padding * 2 };
}

/**
 * <mask> 的范围（父节点坐标）：蒙版画出来的东西都要在里面，范围外的内容一律被遮住。
 * 取蒙版的外框，四周再放宽一些，给描边、斜体字伸出外框的部分留余地
 */
function maskRegion(context: SvgExportContext, mask: SceneNode): Rect {
  const own = paddedBounds(context, mask);
  const pad = Math.max(own.w, own.h) * 0.25;
  const local = { x: own.x - pad, y: own.y - pad, w: own.w + pad * 2, h: own.h + pad * 2 };
  return transformRect(mask.transform, local);
}
