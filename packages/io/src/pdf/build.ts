import {
  AssetStore,
  IDENTITY,
  applyToPoint,
  normalizeStops,
  DOCUMENT_VERSION,
  GLYPH_LIBRARY_MIME,
  GLYPH_PATH_ARITY,
  createNode,
  encodeGlyphLibrary,
  invert,
  isGlyphPath,
  multiply,
  spansFromStyles,
  textAppearanceBasis,
  keyBetween,
  keysBetween,
  rgba,
  solid,
  type Asset,
  type ArtboardNode,
  type BlendMode,
  type CharacterStyle,
  type Color,
  type DocumentData,
  type Fill,
  type GlyphRun,
  type GradientFill,
  type ImageFill,
  type Matrix,
  type NodeId,
  type SceneNode,
  type Stroke,
  type TextNode,
  type TextSpan,
} from '@shiba/core';
import { fontCategory, fontItalic, fontWeight, type FontChoices } from './fonts';
import { appendTransformed } from './geometry';
import {
  asAxisRect,
  asEllipse,
  asRectangle,
  asRoundedRect,
  boxContains,
  boxesOverlap,
  controlBounds,
  intersectBoxes,
  shiftSubpaths,
  tightBounds,
  toSubpaths,
} from './geometry';
import {
  CLOSE,
  LINE,
  MOVE,
  emptyIssues,
  type Box,
  type PathData,
  type PdfClip,
  type PdfGlyph,
  type PdfGradient,
  type PdfGroupItem,
  type PdfImageItem,
  type PdfImageSource,
  type PdfIssues,
  type PdfItem,
  type PdfPage,
  type PdfPathItem,
  type PdfTextItem,
  type PdfTextStyleRun,
} from './ir';
import { cleanText, groupLines, plainHanzi, type TextBlock } from './paragraphs';
import { encodePng } from './png';

/**
 * 第二步：把页面上的对象变成文档节点。
 *
 * 每页一个画板；能认出来的形状还原成矩形和椭圆，其余的是钢笔路径；图片是带图片填充的矩形；
 * 文字拼回段落，变成可以编辑的文本，同时带上原文件的字形（保真外观），改动之前看起来和原文件一样。
 */

export interface PdfBuildOptions {
  /** 文字换用的字体，按无衬线、衬线、等宽分类。省略的类别用无衬线那组 */
  fonts?: Partial<FontChoices>;
  /** 画板之间的间距 */
  gap?: number;
  /** 图片长边超过这个值就缩小 */
  maxImageSide?: number;
}

/** 画板、坐标的范围上限：超出的多半是坏数据 */
const MAX_COORDINATE = 1e7;
/** 节点名最长保留多少个字 */
const MAX_NAME = 80;

type Draft = SceneNode;

const round = (v: number): number => Math.round(v * 1000) / 1000;
/** 方向这类单位长度的量多留几位小数 */
const fine = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * 估算文本框顶边到第一行基线的距离用的字体上下沿（以字号为单位），接近大多数字体的平均值。
 * 只影响文字还按原样显示时文本框的位置；换成正常排版的那一刻，编辑器会按真实的排版结果把基线对齐。
 */
/** 判断"铺满整页"时允许差多少：页面尺寸是取整过的 */
const PAGE_SLACK = 0.5;
const ASCENT = 0.93;
const DESCENT = 0.23;
const DEFAULT_PAIR = { latin: 'Inter', cjk: 'Noto Sans SC' };

/** 一个字体的字形库：字形轮廓按第一次出现的顺序编号，同时记下每个字形代表的文字和步进宽度 */
interface Library {
  key: string;
  index: Map<ArrayLike<number>, number>;
  outlines: ArrayLike<number>[];
  text: string[];
  advances: number[];
}

function sameColor(a: Color, b: Color): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) < 1e-3;
  return close(a.r, b.r) && close(a.g, b.g) && close(a.b, b.b) && close(a.a, b.a);
}

/**
 * PDF 的渐变 → 节点的渐变填充。渐变的几何先换到节点的本地坐标，再按节点外框换成相对位置。
 * 径向渐变：我们的是从圆心开始的正圆，PDF 的是两个圆之间的过渡。两个圆同心时把色标按半径重新排就完全一样；
 * 圆心不同（焦点偏移）时近似成以外圆为准的同心圆。节点没有面积、或者坐标算不出来时返回 null
 */
function gradientFill(gradient: PdfGradient, transform: Matrix, size: readonly [number, number]): GradientFill | null {
  const inverse = invert(transform);
  const [w, h] = size;
  if (!inverse || !(w > 0) || !(h > 0)) return null;
  const m = multiply(inverse, gradient.matrix);
  const unit = (x: number, y: number): { x: number; y: number } => {
    const [lx, ly] = applyToPoint(m, x, y);
    return { x: fine(lx / w), y: fine(ly / h) };
  };
  let stops = gradient.stops.map((s) => ({ offset: s.offset, color: s.color }));
  let start: { x: number; y: number };
  let end: { x: number; y: number };
  let aspect: number | undefined;
  if (gradient.kind === 'radial') {
    // 正圆经过线性变换是椭圆：长短轴的长度和方向就是变换的奇异值和奇异向量
    const [a, b, c, d] = m;
    const p = a * a + c * c;
    const q = a * b + c * d;
    const r = b * b + d * d;
    const spread = Math.sqrt(((p - r) / 2) ** 2 + q * q);
    const major = Math.sqrt(Math.max(0, (p + r) / 2 + spread));
    const minor = Math.sqrt(Math.max(0, (p + r) / 2 - spread));
    const angle = Math.atan2(2 * q, p - r) / 2;
    const radius = gradient.r1 * major;
    const [cx, cy] = applyToPoint(m, gradient.x1, gradient.y1);
    start = { x: fine(cx / w), y: fine(cy / h) };
    end = { x: fine((cx + radius * Math.cos(angle)) / w), y: fine((cy + radius * Math.sin(angle)) / h) };
    if (major > 0 && minor / major < 0.999) aspect = fine(minor / major);
    const { r0, r1 } = gradient;
    if (r0 > 0 && r1 > r0) stops = stops.map((s) => ({ ...s, offset: fine((r0 + s.offset * (r1 - r0)) / r1) }));
  } else {
    start = unit(gradient.x0, gradient.y0);
    end = unit(gradient.x1, gradient.y1);
  }
  const values = [start.x, start.y, end.x, end.y];
  if (!values.every((v) => Number.isFinite(v) && Math.abs(v) < MAX_COORDINATE)) return null;
  const fill: GradientFill = { type: 'gradient', kind: gradient.kind, start, end, stops: normalizeStops(stops) };
  return aspect === undefined ? fill : { ...fill, aspect };
}

function isFiniteData(data: ArrayLike<number>): boolean {
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!(v > -MAX_COORDINATE && v < MAX_COORDINATE)) return false;
  }
  return true;
}

function toStroke(stroke: PdfPathItem['stroke']): Stroke | null {
  return stroke ? { color: stroke.color, width: round(stroke.width) } : null;
}

function boxPath(box: Box): PathData {
  return [MOVE, box.x0, box.y0, LINE, box.x1, box.y0, LINE, box.x1, box.y1, LINE, box.x0, box.y1, CLOSE];
}

function grow(box: Box, by: number): Box {
  return { x0: box.x0 - by, y0: box.y0 - by, x1: box.x1 + by, y1: box.y1 + by };
}

/**
 * 一张占据 image 范围的图片，要透过 box 这个框去看：算出图片填充该怎么缩放和移动，才能让图片留在原来的位置。
 * 与渲染器里铺图片的算法对应：cover 先按"铺满框"来缩放，再乘 zoom；pan 在图片比框多出来的余量里移动，±1 是移到头。
 */
function placeInBox(image: Box, box: Box): Pick<ImageFill, 'fit' | 'zoom' | 'panX' | 'panY'> {
  const width = image.x1 - image.x0;
  const height = image.y1 - image.y0;
  const boxWidth = box.x1 - box.x0;
  const boxHeight = box.y1 - box.y0;
  // 铺满框时图片的宽度：按宽对齐和按高对齐里较大的那个
  const coverWidth = Math.max(boxWidth, (boxHeight * width) / height);
  const pan = (start: number, boxStart: number, full: number, visible: number): number =>
    full - visible < 1e-6
      ? 0
      : Math.min(1, Math.max(-1, (2 * (start - boxStart) + (full - visible)) / (full - visible)));
  return {
    fit: 'cover',
    zoom: Math.max(1, round(width / coverWidth)),
    panX: round(pan(image.x0, box.x0, width, boxWidth)),
    panY: round(pan(image.y0, box.y0, height, boxHeight)),
  };
}

const pointCounts = new WeakMap<ArrayLike<number>, number>();

/** 一个字形轮廓有多少个点（每条命令算一个） */
function pointCount(outline: ArrayLike<number>): number {
  let count = pointCounts.get(outline);
  if (count === undefined) {
    count = 0;
    for (let i = 0; i < outline.length; i += 1 + (GLYPH_PATH_ARITY[outline[i]!] ?? outline.length)) count++;
    pointCounts.set(outline, count);
  }
  return count;
}

/** 把一串字形的轮廓摆到页面上，合成一条路径 */
function composeGlyphs(glyphs: readonly PdfGlyph[]): PathData {
  const data: PathData = [];
  for (const glyph of glyphs) appendTransformed(data, glyph.outline, glyph.matrix);
  return data;
}

/** 把各种格式的像素统一成 PNG 编码器要的样子，并在需要时上色、缩小 */
function toPixels(
  source: PdfImageSource,
  tint: Color | null,
): { width: number; height: number; data: Uint8Array | Uint8ClampedArray; channels: 1 | 3 | 4 } | null {
  const { width, height, data } = source;
  const rowBytes = (width + 7) >> 3;
  if (source.format === 'rgba') return data.length >= width * height * 4 ? { width, height, data, channels: 4 } : null;
  if (source.format === 'rgb') return data.length >= width * height * 3 ? { width, height, data, channels: 3 } : null;
  if (data.length < rowBytes * height) return null;
  if (source.format === 'bw') {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        out[y * width + x] = data[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7)) ? 255 : 0;
      }
    }
    return { width, height, data: out, channels: 1 };
  }
  // 蒙版：0 的地方涂上颜色，1 的地方透明
  const color = tint ?? rgba(0, 0, 0);
  const [r, g, b] = [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255)];
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7))) continue;
      const at = (y * width + x) * 4;
      out[at] = r;
      out[at + 1] = g;
      out[at + 2] = b;
      out[at + 3] = 255;
    }
  }
  return { width, height, data: out, channels: 4 };
}

/** 按整数倍缩小：每 factor × factor 个像素取平均。带透明度的图按预乘后的颜色平均，边缘才不会发黑 */
function downscale(
  image: { width: number; height: number; data: Uint8Array | Uint8ClampedArray; channels: 1 | 3 | 4 },
  factor: number,
): typeof image {
  const { channels, data } = image;
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const out = new Uint8Array(width * height * channels);
  const sums = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sums.fill(0);
      let count = 0;
      for (let dy = 0; dy < factor; dy++) {
        const sy = y * factor + dy;
        if (sy >= image.height) break;
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          if (sx >= image.width) break;
          const at = (sy * image.width + sx) * channels;
          const alpha = channels === 4 ? data[at + 3]! / 255 : 1;
          for (let c = 0; c < Math.min(channels, 3); c++) sums[c]! += data[at + c]! * alpha;
          sums[3]! += alpha;
          count++;
        }
      }
      const at = (y * width + x) * channels;
      const weight = channels === 4 ? sums[3]! : count;
      for (let c = 0; c < Math.min(channels, 3); c++) out[at + c] = weight > 0 ? Math.round(sums[c]! / weight) : 0;
      if (channels === 4) out[at + 3] = Math.round((sums[3]! / count) * 255);
    }
  }
  return { width, height, data: out, channels };
}

export class PdfDocumentBuilder {
  private readonly nodes: Record<NodeId, SceneNode> = {};
  private readonly rootId: NodeId;
  private readonly assets = new AssetStore();
  private readonly encoded = new WeakMap<PdfImageSource, Map<string, Promise<string | null>>>();
  private readonly seq = new Map<string, number>();
  private readonly fonts: FontChoices;
  /** 按字体分的字形库，键是解析库给字体的标识 */
  private readonly libraries = new Map<string, Library>();
  private readonly gap: number;
  private readonly maxImageSide: number;
  private nextX = 0;
  private lastOrder: string | null = null;
  private lastIndex: string | null = null;
  private pages = 0;
  /** 画板之外的节点数 */
  objects = 0;
  /** 画布上要画的点数：路径的锚点，加上文字里每个字形的点。一页密排的正文就有好几万个 */
  anchors = 0;
  readonly issues: PdfIssues = emptyIssues();

  constructor(options: PdfBuildOptions = {}) {
    const sans = options.fonts?.sans ?? DEFAULT_PAIR;
    this.fonts = { sans, serif: options.fonts?.serif ?? sans, mono: options.fonts?.mono ?? sans };
    this.gap = options.gap ?? 80;
    this.maxImageSide = options.maxImageSide ?? 4096;
    const root = createNode('page', { parent: null, index: 'a0', seq: 1 });
    this.rootId = root.id;
    this.nodes[root.id] = root;
  }

  async addPage(page: PdfPage): Promise<void> {
    const width = Math.min(Math.max(1, round(page.width)), MAX_COORDINATE);
    const height = Math.min(Math.max(1, round(page.height)), MAX_COORDINATE);
    this.lastIndex = keyBetween(this.lastIndex, null);
    this.lastOrder = keyBetween(this.lastOrder, null);
    // 很多 PDF（演示软件导出的尤其如此）先画一个铺满整页的矩形当底色：把它变成画板的背景色，
    // 而不是一个盖住整页、一点就选中的大矩形。我们自己导出的 PDF 也是这样写画板背景的
    let items = page.items;
    let background: ArtboardNode['fill'] = solid(rgba(1, 1, 1));
    const first = items[0];
    if (first?.kind === 'path' && this.isBackground(first, width, height)) {
      // 铺满整页的渐变也能当背景：画板的背景支持渐变
      const gradient = first.gradient ? gradientFill(first.gradient, IDENTITY, [width, height]) : null;
      background = gradient ?? solid(first.fill!);
      items = items.slice(1);
    }
    const board = createNode('artboard', {
      parent: this.rootId,
      index: this.lastIndex,
      seq: ++this.pages,
      transform: [1, 0, 0, 1, this.nextX, 0],
      size: [width, height],
      fill: background,
      deck: { order: this.lastOrder, notes: '' },
    });
    this.nodes[board.id] = board;
    this.nextX = round(this.nextX + width + this.gap);

    for (const key of Object.keys(page.issues) as (keyof PdfIssues)[]) this.issues[key] += page.issues[key];
    await this.addItems(items, board.id);
  }

  /** 不透明、没有描边、正常混合、铺满整页的矩形 */
  private isBackground(item: PdfPathItem, width: number, height: number): boolean {
    if (!item.fill || item.fill.a < 1 || item.stroke || item.blendMode !== 'normal') return false;
    if (item.gradient && item.gradient.stops.some((s) => s.color.a < 1)) return false;
    const covers = (box: Box): boolean =>
      box.x0 <= PAGE_SLACK && box.y0 <= PAGE_SLACK && box.x1 >= width - PAGE_SLACK && box.y1 >= height - PAGE_SLACK;
    if (item.clip && !(item.clip.exact && covers(item.clip))) return false;
    const box = asAxisRect(item.data);
    return box !== null && covers(box);
  }

  async finish(): Promise<{ document: DocumentData; assets: Asset[] }> {
    // 字形库要等所有页都转换完才完整，这时才编码成资源，再把文字里的临时标识换成资源 id
    const ids = new Map<string, string>();
    for (const library of this.libraries.values()) {
      const bytes = encodeGlyphLibrary(library.outlines, { text: library.text, advances: library.advances });
      const meta = await this.assets.add(bytes, { mime: GLYPH_LIBRARY_MIME, width: 0, height: 0 });
      ids.set(library.key, meta.id);
    }
    for (const [id, node] of Object.entries(this.nodes)) {
      if (node.type !== 'text' || !node.appearance) continue;
      const runs = node.appearance.runs.map((run) => ({ ...run, library: ids.get(run.library) ?? run.library }));
      this.nodes[id] = { ...node, appearance: { ...node.appearance, runs } };
    }
    return {
      document: { version: DOCUMENT_VERSION, rootId: this.rootId, nodes: this.nodes },
      assets: this.assets.all(),
    };
  }

  get pageCount(): number {
    return this.pages;
  }

  // ───────────── 对象 → 节点 ─────────────

  /** 把一组对象放进 parent，返回实际生成了几个节点 */
  private async addItems(items: readonly PdfItem[], parent: NodeId): Promise<number> {
    const drafts: Draft[] = [];
    // 连续的几行文字先攒起来，一起拼成段落
    let lines: PdfTextItem[] = [];
    const flush = (): void => {
      for (const block of groupLines(lines, this.styleOf)) {
        const draft = this.textNode(block, parent);
        if (draft) drafts.push(draft);
      }
      lines = [];
    };
    for (const item of items) {
      if (item.kind === 'text' && this.editable(item)) {
        lines.push(item);
        continue;
      }
      flush();
      const draft = await this.convert(item, parent);
      if (draft) drafts.push(draft);
    }
    flush();
    const indices = keysBetween(null, null, drafts.length);
    drafts.forEach((draft, i) => {
      this.nodes[draft.id] = { ...draft, index: indices[i]! };
      this.objects++;
    });
    return drafts.length;
  }

  private nextSeq(type: string): number {
    const value = (this.seq.get(type) ?? 0) + 1;
    this.seq.set(type, value);
    return value;
  }

  private async convert(item: PdfItem, parent: NodeId): Promise<Draft | null> {
    switch (item.kind) {
      case 'path':
        return this.pathNode(item.data, item.fillRule, item, parent);
      case 'text':
        // 竖排、描边、没有填充的文字还没法变成可编辑的文本，按原样变成轮廓，节点名就是那段文字
        if (item.glyphs.length > 0)
          return this.pathNode(composeGlyphs(item.glyphs), 'nonzero', item, parent, item.text);
        return this.textNode(groupLines([item], this.styleOf)[0]!, parent);
      case 'image':
        return this.imageNode(item, parent);
      case 'group':
        return this.groupNode(item, parent);
    }
  }

  /**
   * 对象和它的裁剪范围是什么关系：
   * outside 完全在外面，看不见；inside 完全在里面，裁剪不起作用；cut 被裁掉了一部分。
   */
  private clipVerdict(clip: PdfClip | null, bounds: Box): 'outside' | 'inside' | 'cut' {
    if (!clip) return 'inside';
    if (!boxesOverlap(clip, bounds)) return 'outside';
    return clip.exact && boxContains(clip, bounds, 0.01) ? 'inside' : 'cut';
  }

  private pathNode(
    data: PathData,
    rule: 'nonzero' | 'evenodd',
    item: PdfPathItem | PdfTextItem,
    parent: NodeId,
    text?: string,
  ): Draft | null {
    if (!isFiniteData(data)) return null;
    const rough = controlBounds(data);
    if (!rough) return null;
    const stroke = toStroke(item.stroke);
    let fillRule = rule;

    const { clip } = item;
    const verdict = this.clipVerdict(clip, grow(rough, stroke ? stroke.width / 2 : 0));
    if (verdict === 'outside') return null;
    if (verdict === 'cut' && clip) {
      // 没旋转的纯色矩形有两种情况可以精确还原：
      // 被矩形裁剪，结果还是矩形；盖住了整个裁剪形状，结果就是那个形状
      const box = stroke ? null : asAxisRect(data);
      if (box && clip.exact) {
        data = boxPath(intersectBoxes(box, clip));
      } else if (box && clip.shape && boxContains(box, clip, 0.01) && isFiniteData(clip.shape.data)) {
        data = clip.shape.data;
        fillRule = clip.shape.fillRule;
      } else {
        this.issues.clips++;
      }
    }

    const node = this.shapeNode(data, fillRule, text === undefined, {
      parent,
      index: '',
      name: text === undefined ? undefined : cleanText(text).slice(0, MAX_NAME) || undefined,
      blendMode: item.blendMode,
      fill: item.fill ? solid(item.fill) : null,
      stroke,
    });
    // 渐变要等形状的位置和大小定下来，才能换算到它的本地坐标里
    if (node && item.kind === 'path' && item.gradient && 'fill' in node) {
      const fill = gradientFill(item.gradient, node.transform, node.size);
      if (fill) return { ...node, fill } as Draft;
      this.issues.gradients++;
    }
    return node;
  }

  /**
   * 用一条路径建一个形状节点。recognize 不为 false 时，能认出来的就还原成矩形、圆角矩形、椭圆，
   * 这样用户拿到的是可以直接改大小、改圆角的形状，而不是一堆锚点；传 'upright' 表示不接受旋转过的矩形。
   */
  private shapeNode(
    data: PathData,
    fillRule: 'nonzero' | 'evenodd',
    recognize: boolean | 'upright',
    common: {
      parent: NodeId;
      index: string;
      name?: string;
      blendMode: BlendMode;
      fill: Fill | null;
      stroke: Stroke | null;
    },
  ): Draft | null {
    if (recognize) {
      const frame = asRectangle(data, common.stroke !== null);
      if (frame && (frame.axisAligned || recognize !== 'upright')) {
        const t = frame.transform;
        return createNode('rect', {
          ...common,
          seq: this.nextSeq('rect'),
          transform: [t[0], t[1], t[2], t[3], round(t[4]), round(t[5])],
          size: [round(frame.width), round(frame.height)],
          cornerRadius: 0,
        });
      }
    }

    const subpaths = toSubpaths(data);
    const bounds = tightBounds(subpaths);
    if (!bounds) return null;
    const size: [number, number] = [round(bounds.x1 - bounds.x0), round(bounds.y1 - bounds.y0)];
    const transform: Matrix = [1, 0, 0, 1, round(bounds.x0), round(bounds.y0)];
    if (recognize) {
      if (asEllipse(subpaths))
        return createNode('ellipse', { ...common, seq: this.nextSeq('ellipse'), transform, size });
      const rounded = asRoundedRect(subpaths);
      if (rounded) {
        const cornerRadius = round(rounded.radius);
        return createNode('rect', { ...common, seq: this.nextSeq('rect'), transform, size, cornerRadius });
      }
    }
    for (const sub of subpaths) this.anchors += sub.anchors.length;
    return createNode('path', {
      ...common,
      seq: this.nextSeq('path'),
      transform,
      size,
      subpaths: shiftSubpaths(subpaths, -transform[4], -transform[5]),
      fillRule,
    });
  }

  // ───────────── 文字 ─────────────

  /** 能变成可编辑文本的行：横排或者斜着排，只有填充 */
  private editable(item: PdfTextItem): boolean {
    return !item.vertical && item.fill !== null && item.stroke === null;
  }

  /** 字体的类别和粗细：不同的不拼成一段 */
  private readonly styleOf = (item: PdfTextItem): string =>
    `${fontCategory(item.font)}/${fontWeight(item.font) >= 600 ? 'bold' : 'regular'}`;

  private library(font: string): Library {
    let library = this.libraries.get(font);
    if (!library) {
      library = { key: `font:${font}`, index: new Map(), outlines: [], text: [], advances: [] };
      this.libraries.set(font, library);
    }
    return library;
  }

  /**
   * 一段文字 → 文本节点。
   * 节点的本地坐标系跟着文字方向走（斜着排的文字就是转过角度的文本框），左上角是文本框的左上角。
   * 有字形的时候带上保真外观：每个字形在本地坐标里的位置，改动之前按它们画。
   */
  private textNode(block: TextBlock, parent: NodeId): Draft | null {
    const first = block.lines[0]!;
    const size = round(first.size);
    const { text, dirX, dirY } = block;
    const numbers = [block.originX, block.originY, dirX, dirY, block.left, block.right, block.spacing, size];
    if (!text || !(size > 0) || !isFiniteData(numbers)) return null;

    const count = block.lines.length;
    const lineHeight = count > 1 ? Math.min(4, Math.max(0.8, round(block.spacing / size))) : 1.2;
    const width = round(Math.max(block.right - block.left, size * 0.5));
    const height = round(count > 1 ? block.spacing * (count - 1) + lineHeight * size : lineHeight * size);
    const baseline = round(size * ((lineHeight - (ASCENT + DESCENT)) / 2 + ASCENT));
    // 文本框左上角：从第一行基线的起点沿文字方向走到最左边，再往上退一个"顶边到基线"的距离
    const transform: Matrix = [
      fine(dirX),
      fine(dirY),
      fine(-dirY),
      fine(dirX),
      round(block.originX + dirX * block.left + dirY * baseline),
      round(block.originY + dirY * block.left - dirX * baseline),
    ];

    const corners = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ].map(([x, y]) => [
      transform[0] * x! + transform[2] * y! + transform[4],
      transform[1] * x! + transform[3] * y! + transform[5],
    ]);
    const bounds: Box = {
      x0: Math.min(...corners.map((c) => c[0]!)),
      y0: Math.min(...corners.map((c) => c[1]!)),
      x1: Math.max(...corners.map((c) => c[0]!)),
      y1: Math.max(...corners.map((c) => c[1]!)),
    };
    const verdict = this.clipVerdict(first.clip, bounds);
    if (verdict === 'outside') return null;
    if (verdict === 'cut') this.issues.clips++;

    const font = first.font;
    const fill = first.fill ?? rgba(0, 0, 0);
    const plain: TextNode = createNode('text', {
      parent,
      index: '',
      seq: this.nextSeq('text'),
      transform,
      size: [width, height],
      blendMode: first.blendMode,
      text,
      style: {
        fontFamily: this.fonts[fontCategory(font)],
        fontSize: size,
        fontWeight: fontWeight(font),
        lineHeight,
        letterSpacing: 0,
        ...(fontItalic(font) ? { italic: true } : {}),
      },
      align: block.align,
      sizing: count > 1 ? 'fixed' : 'auto',
      fill: solid(fill),
    });
    // 和这一段主要样式不同的字（加粗或换色的词、换了字体的字、上标）变成字符级样式
    const node: TextNode = { ...plain, spans: this.characterSpans(plain, block) };

    const runs = this.glyphRuns(block, transform, fill);
    if (!runs) {
      // PDF 没有内嵌字体，拿不到字形：只能用我们的字体重排，样子会有出入
      this.issues.fallbackText++;
      return node;
    }
    return { ...node, appearance: { runs, basis: textAppearanceBasis(node), baseline } };
  }

  /**
   * 每个字的字体、字号、颜色 → 字符级样式。同一段样式只换算一次。
   * 空格的样式不可靠（PDF 里常常根本没画空格，是导入时按间距补出来的），所以：
   * 前后的字样式相同时跟着它们（加粗的一句话中间的空格也加粗），不同时用整段的默认样式
   */
  private characterSpans(node: TextNode, block: TextBlock): TextSpan[] | undefined {
    const size = node.style.fontSize;
    const memo = new Map<PdfTextStyleRun, Partial<CharacterStyle>>();
    const per = block.styles.map((run) => {
      let style = memo.get(run);
      if (!style) {
        // 字号只差一点点的是同一个字号，免得浮点误差造出一堆区间
        const runSize = Math.abs(run.size - size) <= size * 0.02 ? size : round(run.size);
        style = {
          fontFamily: this.fonts[fontCategory(run.font)],
          fontWeight: fontWeight(run.font),
          italic: fontItalic(run.font),
          fontSize: runSize,
          color: run.fill ?? node.fill?.color ?? null,
        };
        memo.set(run, style);
      }
      return style;
    });
    const text = node.text;
    const styles = per.map((style, i) => {
      if (!/\s/.test(text[i] ?? '')) return style;
      let before: Partial<CharacterStyle> | null = null;
      for (let k = i - 1; k >= 0 && !before; k--) if (!/\s/.test(text[k]!)) before = per[k] ?? null;
      let after: Partial<CharacterStyle> | null = null;
      for (let k = i + 1; k < text.length && !after; k++) if (!/\s/.test(text[k]!)) after = per[k] ?? null;
      return before && before === after ? before : null;
    });
    return spansFromStyles(node, styles);
  }

  /**
   * 把一段文字里每个字形的位置换算到文本框的本地坐标，按字形库和大小方向分组。
   * 只把前后紧挨着的字形分进同一组，组的先后就是原文件里画字的顺序：
   * 导出 PDF 时按这个顺序写，复制出来的文字才不会乱（中英文混排的一行字就是好几组交替出现）。
   */
  private glyphRuns(block: TextBlock, transform: Matrix, fill: Color): GlyphRun[] | null {
    const inverse = invert(transform);
    if (!inverse) return null;
    const runs: {
      key: string;
      library: string;
      matrix: [number, number, number, number];
      glyphs: number[];
      color?: Color;
    }[] = [];
    for (const line of block.lines) {
      for (const glyph of line.glyphs) {
        const library = this.library(glyph.font);
        let index = library.index.get(glyph.outline);
        if (index === undefined) {
          if (!isGlyphPath(glyph.outline)) continue;
          index = library.outlines.length;
          library.outlines.push(glyph.outline);
          // 和文本内容一样把部首码位换回普通汉字，导出的 PDF 里才搜得到"小""页"这样的字
          library.text.push(plainHanzi(glyph.text).slice(0, 32));
          library.advances.push(Number.isFinite(glyph.advance) ? glyph.advance : 0);
          library.index.set(glyph.outline, index);
        }
        const local = multiply(inverse, glyph.matrix);
        if (!isFiniteData(local)) continue;
        const matrix: [number, number, number, number] = [
          fine(local[0]),
          fine(local[1]),
          fine(local[2]),
          fine(local[3]),
        ];
        // 和节点填充色不同的字（一行里换了颜色的词）单独成组，记下自己的颜色
        const color = glyph.fill && !sameColor(glyph.fill, fill) ? glyph.fill : undefined;
        const key = `${library.key}|${matrix.join(',')}|${color ? `${color.r},${color.g},${color.b},${color.a}` : ''}`;
        let run = runs[runs.length - 1];
        if (run?.key !== key) runs.push((run = { key, library: library.key, matrix, glyphs: [], color }));
        run.glyphs.push(index, round(local[4]), round(local[5]));
        // 画的时候每个字形的每个点都要算一遍，按点数记进总量
        this.anchors += pointCount(glyph.outline);
      }
    }
    return runs.length > 0
      ? runs.map(({ library, matrix, glyphs, color }) =>
          color ? { library, matrix, glyphs, color } : { library, matrix, glyphs },
        )
      : null;
  }

  private async imageNode(item: PdfImageItem, parent: NodeId): Promise<Draft | null> {
    const m = item.matrix;
    if (!isFiniteData(m)) return null;
    const width = Math.hypot(m[0], m[1]);
    const height = Math.hypot(m[2], m[3]);
    if (width < 1e-6 || height < 1e-6) return null;
    const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
    const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
    const bounds: Box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const { clip } = item;
    const verdict = this.clipVerdict(clip, bounds);
    if (verdict === 'outside') return null;

    const assetId = await this.assetFor(item.source, item.tint);
    if (!assetId) {
      this.issues.images++;
      return null;
    }
    const common = {
      parent,
      index: '',
      opacity: Math.min(1, Math.max(0, item.opacity)),
      blendMode: item.blendMode,
      stroke: null,
    };
    const whole: ImageFill = { type: 'image', assetId, fit: 'stretch' };

    if (verdict === 'cut' && clip) {
      // 图片被裁掉了一部分——PDF 里"图片放在框里"就是这么表达的。
      // 我们的图片本来就是形状的填充，可以在形状里缩放和移动，所以能原样还原：
      // 形状是裁剪的范围（矩形，或者圆、圆角矩形等任意形状），图片在里面放大并移到原来的位置。
      // 只处理没有旋转、没有被拉变形的图片。
      const upright = m[0] > 0 && m[3] > 0 && Math.abs(m[1]) < width * 1e-4 && Math.abs(m[2]) < height * 1e-4;
      const scaleX = width / item.source.width;
      const scaleY = height / item.source.height;
      const undistorted = Math.abs(scaleX - scaleY) <= Math.max(scaleX, scaleY) * 0.01;
      if (upright && undistorted && clip.exact) {
        const box = intersectBoxes(bounds, clip);
        if (box.x1 - box.x0 > 1e-3 && box.y1 - box.y0 > 1e-3) {
          return createNode('rect', {
            ...common,
            seq: this.nextSeq('rect'),
            transform: [1, 0, 0, 1, round(box.x0), round(box.y0)],
            size: [round(box.x1 - box.x0), round(box.y1 - box.y0)],
            cornerRadius: 0,
            fill: { ...whole, ...placeInBox(bounds, box) },
          });
        }
      } else if (
        upright &&
        undistorted &&
        clip.shape &&
        boxContains(bounds, clip, 0.01) &&
        isFiniteData(clip.shape.data)
      ) {
        const shape = this.shapeNode(clip.shape.data, clip.shape.fillRule, 'upright', { ...common, fill: whole });
        if (shape && (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'path')) {
          const [x, y] = [shape.transform[4], shape.transform[5]];
          const box = { x0: x, y0: y, x1: x + shape.size[0], y1: y + shape.size[1] };
          return { ...shape, opacity: common.opacity, fill: { ...whole, ...placeInBox(bounds, box) } };
        }
      }
      this.issues.clips++;
    }

    return createNode('rect', {
      ...common,
      seq: this.nextSeq('rect'),
      transform: [m[0] / width, m[1] / width, m[2] / height, m[3] / height, round(m[4]), round(m[5])],
      size: [round(width), round(height)],
      cornerRadius: 0,
      fill: whole,
    });
  }

  private async groupNode(item: PdfGroupItem, parent: NodeId): Promise<Draft | null> {
    const group = createNode('group', {
      parent,
      index: '',
      seq: this.nextSeq('group'),
      name: item.name?.slice(0, MAX_NAME) || undefined,
      opacity: Math.min(1, Math.max(0, item.opacity)),
      blendMode: item.blendMode,
    });
    const before = this.objects;
    const added = await this.addItems(item.items, group.id);
    if (added === 0) {
      this.objects = before;
      return null;
    }
    return group;
  }

  /** 把一张图片编码后放进资源库，返回资源 id。同一张图片只处理一次 */
  private assetFor(source: PdfImageSource, tint: Color | null): Promise<string | null> {
    let variants = this.encoded.get(source);
    if (!variants) this.encoded.set(source, (variants = new Map()));
    const key = tint ? `${tint.r},${tint.g},${tint.b}` : '';
    let pending = variants.get(key);
    if (!pending) {
      pending = this.encode(source, tint).catch(() => null);
      variants.set(key, pending);
    }
    return pending;
  }

  private async encode(source: PdfImageSource, tint: Color | null): Promise<string | null> {
    if (!(source.width >= 1 && source.height >= 1) || source.width * source.height > 2 ** 28) return null;
    let image = toPixels(source, tint);
    if (!image) return null;
    const factor = Math.ceil(Math.max(image.width, image.height) / this.maxImageSide);
    if (factor > 1) image = downscale(image, factor);
    const bytes = encodePng(image.width, image.height, image.data, image.channels);
    const meta = await this.assets.add(bytes, { mime: 'image/png', width: image.width, height: image.height });
    return meta.id;
  }
}
