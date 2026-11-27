import {
  AssetStore,
  DOCUMENT_VERSION,
  createNode,
  keyBetween,
  keysBetween,
  rgba,
  solid,
  type Asset,
  type BlendMode,
  type Color,
  type DocumentData,
  type Fill,
  type ImageFill,
  type Matrix,
  type NodeId,
  type SceneNode,
  type Stroke,
} from '@shiba/core';
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
  type PdfGroupItem,
  type PdfImageItem,
  type PdfImageSource,
  type PdfIssues,
  type PdfItem,
  type PdfPage,
  type PdfPathItem,
  type PdfTextItem,
} from './ir';
import { encodePng } from './png';

/**
 * 第二步：把页面上的对象变成文档节点。
 *
 * 每页一个画板；能认出来的形状还原成矩形和椭圆，其余的是钢笔路径；图片是带图片填充的矩形；
 * 文字目前是轮廓路径（看起来和原文件一样，但不能改字），节点名就是那段文字。
 */

export interface PdfBuildOptions {
  /** 没有内嵌字体的文字改用这组字体重排 */
  fonts?: { latin: string; cjk: string };
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

/**
 * 整理从 PDF 里读出来的文字：合并空白；把"部首"字符换回普通汉字。
 * 有些字体把「小」「一」这样的字映射到了外形相同的康熙部首码位（⼩、⼀），看着一样，搜索和输入时却对不上。
 */
function cleanText(text: string): string {
  return text
    .replace(/[\u2e80-\u2fdf]/g, (char) => char.normalize('NFKC'))
    .replace(/\s+/g, ' ')
    .trim();
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
  private readonly fonts: { latin: string; cjk: string };
  private readonly gap: number;
  private readonly maxImageSide: number;
  private nextX = 0;
  private lastOrder: string | null = null;
  private lastIndex: string | null = null;
  private pages = 0;
  /** 画板之外的节点数 */
  objects = 0;
  /** 所有路径的锚点总数。文档有多重主要看它：一页密排的文字轮廓就有好几万个锚点 */
  anchors = 0;
  readonly issues: PdfIssues = emptyIssues();

  constructor(options: PdfBuildOptions = {}) {
    this.fonts = options.fonts ?? { latin: 'Inter', cjk: 'Noto Sans SC' };
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
    const board = createNode('artboard', {
      parent: this.rootId,
      index: this.lastIndex,
      seq: ++this.pages,
      transform: [1, 0, 0, 1, this.nextX, 0],
      size: [width, height],
      fill: solid(rgba(1, 1, 1)),
      deck: { order: this.lastOrder, notes: '' },
    });
    this.nodes[board.id] = board;
    this.nextX = round(this.nextX + width + this.gap);

    for (const key of Object.keys(page.issues) as (keyof PdfIssues)[]) this.issues[key] += page.issues[key];
    await this.addItems(page.items, board.id);
  }

  finish(): { document: DocumentData; assets: Asset[] } {
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
    for (const item of items) {
      const draft = await this.convert(item, parent);
      if (draft) drafts.push(draft);
    }
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
        return this.pathNode(item, parent, undefined);
      case 'text':
        return item.data.length > 0 ? this.pathNode(item, parent, item.text) : this.fallbackText(item, parent);
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

  private pathNode(item: PdfPathItem | PdfTextItem, parent: NodeId, text: string | undefined): Draft | null {
    let data = item.data;
    if (!isFiniteData(data)) return null;
    const rough = controlBounds(data);
    if (!rough) return null;
    const stroke = toStroke(item.stroke);
    let fillRule = item.kind === 'path' ? item.fillRule : 'nonzero';

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

    return this.shapeNode(data, fillRule, text === undefined, {
      parent,
      index: '',
      name: text === undefined ? undefined : cleanText(text).slice(0, MAX_NAME) || undefined,
      blendMode: item.blendMode,
      fill: item.fill ? solid(item.fill) : null,
      stroke,
    });
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

  /** PDF 没有内嵌字体时拿不到字形轮廓：用我们自己的字体按原来的位置和字号重排，样子会有出入 */
  private fallbackText(item: PdfTextItem, parent: NodeId): Draft | null {
    const text = cleanText(item.text);
    const size = round(item.size);
    if (!text || !(size > 0) || !isFiniteData([item.x, item.y, item.dirX, item.dirY, size])) return null;
    const reach = Math.max(item.length, size);
    const bounds: Box = {
      x0: Math.min(item.x, item.x + item.dirX * reach) - size,
      y0: Math.min(item.y, item.y + item.dirY * reach) - size,
      x1: Math.max(item.x, item.x + item.dirX * reach) + size,
      y1: Math.max(item.y, item.y + item.dirY * reach) + size,
    };
    if (this.clipVerdict(item.clip, bounds) === 'outside') return null;
    this.issues.fallbackText++;

    const lineHeight = 1.2;
    // 文本框的左上角在基线上方大约 0.95 个字号处（行高 1.2 时基线的位置）
    const rise = size * 0.95;
    const { dirX, dirY } = item;
    return createNode('text', {
      parent,
      index: '',
      seq: this.nextSeq('text'),
      transform: [dirX, dirY, -dirY, dirX, round(item.x + dirY * rise), round(item.y - dirX * rise)],
      size: [round(Math.max(item.length, size)), round(size * lineHeight)],
      blendMode: item.blendMode,
      text,
      style: {
        fontFamily: this.fonts,
        fontSize: size,
        fontWeight: item.bold ? 700 : 400,
        lineHeight,
        letterSpacing: 0,
      },
      align: 'left',
      sizing: 'auto',
      fill: solid(item.fill ?? item.stroke?.color ?? rgba(0, 0, 0)),
    });
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
