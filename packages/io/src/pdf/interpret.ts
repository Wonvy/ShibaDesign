import { BLEND_MODES, IDENTITY, multiply, parseHex, type BlendMode, type Color, type Matrix } from '@shiba/core';
import {
  appendTransformed,
  asAxisRect,
  boxContains,
  controlBounds,
  intersectBoxes,
  scaleOf,
  transformPath,
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
  type PdfImageSource,
  type PdfItem,
  type PdfPage,
  type PdfStroke,
  type PdfTextItem,
} from './ir';

/**
 * 解释器：把 PDF 的绘图指令一条条"执行"一遍，但不是真的画出来，
 * 而是记下页面上最终有哪些对象、各自长什么样。
 *
 * PDF 的页面内容是一段小程序：设置颜色、移动坐标系、构造路径、填充……
 * 每条指令只改变"当前状态"，所以必须像真正的渲染器那样维护一份图形状态，才知道每个对象最终的位置和外观。
 * 指令的格式来自解析库 pdf.js；这里对各条指令的理解与它自己的画布渲染器保持一致。
 */

export interface PdfOperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

export interface PdfFont {
  /** 同一个字体对象的标识 */
  id: string;
  /** PDF 里的字体名 */
  name: string;
  /** 每个字是一小段绘图指令的字体 */
  type3: boolean;
  vertical: boolean;
  /** PDF 没有内嵌这个字体，拿不到字形轮廓 */
  missing: boolean;
  bold: boolean;
  italic: boolean;
  fontMatrix: Matrix;
  charProc?(id: string): PdfOperatorList | null;
}

/** 解释器向外要东西的接口。实际的数据在解析库手里，这样解释器本身不依赖具体的解析库 */
export interface PdfResources {
  /** 指令名 → 指令码 */
  ops: Readonly<Record<string, number>>;
  font(id: string): PdfFont | null;
  /** 一个字的轮廓：以字号为 1 个单位的路径数据，y 向上 */
  glyph(font: PdfFont, fontChar: string): ArrayLike<number> | null;
  /** ref 是图片对象的标识，或者内嵌图片本身 */
  image(ref: unknown, kind: 'image' | 'mask'): PdfImageSource | null;
  /** 渐变的定义 */
  shading(id: string): unknown;
  /** 一个可选内容组（PDF 的图层）是否显示 */
  visible(properties: unknown): boolean;
}

export interface PdfViewport {
  width: number;
  height: number;
  /** PDF 用户空间 → 页面坐标（已含页面旋转和 y 轴翻转） */
  transform: Matrix;
}

type Paint =
  | { kind: 'color'; r: number; g: number; b: number }
  | { kind: 'gradient'; r: number; g: number; b: number }
  | { kind: 'pattern' }
  | { kind: 'none' };

interface State {
  ctm: Matrix;
  fill: Paint;
  stroke: Paint;
  fillAlpha: number;
  strokeAlpha: number;
  blendMode: BlendMode;
  lineWidth: number;
  dashed: boolean;
  softMask: boolean;
  clip: PdfClip | null;
  font: PdfFont | null;
  fontSize: number;
  fontDirection: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
  textMatrix: Matrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
}

interface GroupFrame {
  /** 这个组的内容是一张透明蒙版，不是要画出来的东西 */
  mask: boolean;
  opacity: number;
  blendMode: BlendMode;
}

interface Glyph {
  fontChar: string;
  unicode: string;
  width: number;
  isSpace: boolean;
  isInFont: boolean;
  accent: { fontChar: string; offset: { x: number; y: number } } | null;
  vmetric?: ArrayLike<number>;
  operatorListId?: string;
}

/** 指令的参数由解析库给出，没有静态类型；每个处理函数自己知道该怎么读 */
type Args = any[];

const BLACK: Paint = { kind: 'color', r: 0, g: 0, b: 0 };
/** Type3 字形里还可以再用 Type3 字体；限制嵌套层数，防止恶意文件造成无限递归 */
const MAX_DEPTH = 6;
/** 合并同一行文字时，一个对象最多攒这么多路径数据，免得一整页密密麻麻的字变成一个巨大的对象 */
const MAX_RUN_DATA = 120_000;

const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

function toMatrix(value: ArrayLike<number>): Matrix {
  return [value[0]!, value[1]!, value[2]!, value[3]!, value[4]!, value[5]!];
}

function toBlendMode(value: unknown): BlendMode {
  return (BLEND_MODES as readonly unknown[]).includes(value) ? (value as BlendMode) : 'normal';
}

function colorPaint(hex: unknown): Paint {
  const color = typeof hex === 'string' ? parseHex(hex) : null;
  return color ? { kind: 'color', r: color.r, g: color.g, b: color.b } : BLACK;
}

/** 渐变的平均色。模型里还没有渐变填充，先用一个最接近的纯色顶上 */
function shadingColor(ir: unknown): { r: number; g: number; b: number } | null {
  if (!Array.isArray(ir)) return null;
  if (ir[0] === 'RadialAxial' && Array.isArray(ir[3])) {
    const stops: { at: number; color: Color }[] = [];
    for (const stop of ir[3] as unknown[]) {
      if (!Array.isArray(stop)) continue;
      const color = typeof stop[1] === 'string' ? parseHex(stop[1]) : null;
      if (color && Number.isFinite(stop[0])) stops.push({ at: Math.min(1, Math.max(0, stop[0] as number)), color });
    }
    if (stops.length === 0) return null;
    stops.sort((a, b) => a.at - b.at);
    // 按各段在渐变里占的长度加权；两头超出首尾色标的部分用首尾的颜色
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const sum = { r: first.color.r * first.at, g: first.color.g * first.at, b: first.color.b * first.at };
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!;
      const b = stops[i]!;
      const weight = (b.at - a.at) / 2;
      sum.r += (a.color.r + b.color.r) * weight;
      sum.g += (a.color.g + b.color.g) * weight;
      sum.b += (a.color.b + b.color.b) * weight;
    }
    const rest = 1 - last.at;
    return { r: sum.r + last.color.r * rest, g: sum.g + last.color.g * rest, b: sum.b + last.color.b * rest };
  }
  if (ir[0] === 'Mesh' && ir[3] instanceof Uint8Array && ir[3].length >= 4) {
    // 网格渐变：每个顶点 4 个字节（RGB 加一个补位），取所有顶点的平均
    const colors = ir[3];
    const count = Math.floor(colors.length / 4);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < count; i++) {
      r += colors[i * 4]!;
      g += colors[i * 4 + 1]!;
      b += colors[i * 4 + 2]!;
    }
    return { r: r / count / 255, g: g / count / 255, b: b / count / 255 };
  }
  return null;
}

function sameColor(a: Color | null, b: Color | null): boolean {
  if (!a || !b) return a === b;
  const close = (x: number, y: number): boolean => Math.abs(x - y) < 1e-4;
  return close(a.r, b.r) && close(a.g, b.g) && close(a.b, b.b) && close(a.a, b.a);
}

function sameStroke(a: PdfStroke | null, b: PdfStroke | null): boolean {
  if (!a || !b) return a === b;
  return sameColor(a.color, b.color) && Math.abs(a.width - b.width) < 1e-4;
}

function sameClip(a: PdfClip | null, b: PdfClip | null): boolean {
  if (!a || !b) return a === b;
  const close = (x: number, y: number): boolean => Math.abs(x - y) < 1e-3;
  if (a.exact !== b.exact || a.shape?.data.length !== b.shape?.data.length) return false;
  return close(a.x0, b.x0) && close(a.y0, b.y0) && close(a.x1, b.x1) && close(a.y1, b.y1);
}

/** 从一张图片里切出一块，得到一张新图片 */
function cropSource(source: PdfImageSource, x: number, y: number, w: number, h: number): PdfImageSource | null {
  const channels = source.format === 'rgba' ? 4 : source.format === 'rgb' ? 3 : 0;
  if (!channels || x < 0 || y < 0 || w < 1 || h < 1 || x + w > source.width || y + h > source.height) return null;
  const data = new Uint8Array(w * h * channels);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * source.width + x) * channels;
    data.set(source.data.subarray(from, from + w * channels), row * w * channels);
  }
  return { width: w, height: h, format: source.format, data };
}

class Interpreter {
  private state: State;
  private readonly stack: State[] = [];
  /** 正在往里放对象的列表，最后一个是当前的；进入透明组或 Type3 字形时压入一个新的 */
  private readonly containers: PdfItem[][] = [[]];
  private readonly groups: GroupFrame[] = [];
  private readonly annotations: number[] = [];
  /** 标记内容的可见性栈，对应 PDF 的图层开关 */
  private readonly marked: boolean[] = [];
  private hidden = 0;
  private pendingClip: 'nonzero' | 'evenodd' | null = null;
  private textClip = false;
  private depth = 0;
  private readonly issues = emptyIssues();
  private readonly handlers: (((args: Args) => void) | undefined)[] = [];
  private readonly crops = new WeakMap<PdfImageSource, Map<string, PdfImageSource | null>>();

  constructor(
    private readonly resources: PdfResources,
    private readonly viewport: PdfViewport,
  ) {
    this.state = this.initialState();
    this.register();
  }

  private initialState(): State {
    return {
      ctm: this.viewport.transform,
      fill: BLACK,
      stroke: BLACK,
      fillAlpha: 1,
      strokeAlpha: 1,
      blendMode: 'normal',
      lineWidth: 1,
      dashed: false,
      softMask: false,
      clip: null,
      font: null,
      fontSize: 0,
      fontDirection: 1,
      charSpacing: 0,
      wordSpacing: 0,
      hScale: 1,
      leading: 0,
      rise: 0,
      renderMode: 0,
      textMatrix: IDENTITY,
      x: 0,
      y: 0,
      lineX: 0,
      lineY: 0,
    };
  }

  run(list: PdfOperatorList): void {
    const { fnArray, argsArray } = list;
    for (let i = 0; i < fnArray.length; i++) {
      const handler = this.handlers[fnArray[i]!];
      if (handler) handler((argsArray[i] as Args | null) ?? []);
    }
  }

  finish(): PdfPage {
    // 文件里的透明组没有正常结束时，把还没收尾的内容都留下，好过丢掉
    while (this.containers.length > 1) {
      const items = this.containers.pop()!;
      this.current.push(...items);
    }
    return { width: this.viewport.width, height: this.viewport.height, items: this.current, issues: this.issues };
  }

  private get current(): PdfItem[] {
    return this.containers[this.containers.length - 1]!;
  }

  private get visible(): boolean {
    return this.hidden === 0;
  }

  // ───────────── 指令表 ─────────────

  private register(): void {
    const on = (name: string, handler: (args: Args) => void): void => {
      const code = this.resources.ops[name];
      if (code !== undefined) this.handlers[code] = handler;
    };
    const { ops } = this.resources;

    on('save', () => this.save());
    on('restore', () => this.restore());
    on('transform', (a) => this.transform(toMatrix(a)));
    on('setLineWidth', (a) => (this.state.lineWidth = Number(a[0]) || 0));
    on('setDash', (a) => (this.state.dashed = (a[0]?.length ?? 0) > 0));
    on('setGState', (a) => this.setGState(a[0]));

    on('setFillRGBColor', (a) => (this.state.fill = colorPaint(a[0])));
    on('setStrokeRGBColor', (a) => (this.state.stroke = colorPaint(a[0])));
    on('setFillTransparent', () => (this.state.fill = { kind: 'none' }));
    on('setStrokeTransparent', () => (this.state.stroke = { kind: 'none' }));
    on('setFillColorN', (a) => (this.state.fill = this.patternPaint(a)));
    on('setStrokeColorN', (a) => (this.state.stroke = this.patternPaint(a)));

    on('clip', () => (this.pendingClip = 'nonzero'));
    on('eoClip', () => (this.pendingClip = 'evenodd'));
    on('constructPath', (a) => {
      const raw: ArrayLike<number> | null = a[1]?.[0] ?? null;
      const path = raw ? transformPath(raw, this.state.ctm) : [];
      const op: number = a[0];
      const evenOdd = op === ops.eoFill || op === ops.eoFillStroke || op === ops.closeEOFillStroke;
      const fill = op !== ops.stroke && op !== ops.closeStroke && op !== ops.endPath;
      const stroke = op !== ops.fill && op !== ops.eoFill && op !== ops.endPath && op !== ops.rawFillPath;
      if (path.length > 0 && (fill || stroke)) this.paintPath(path, fill, stroke, evenOdd ? 'evenodd' : 'nonzero');
      if (this.pendingClip) {
        const rule = this.pendingClip;
        this.pendingClip = null;
        this.applyClip(path, rule);
      }
    });
    on('shadingFill', (a) => this.shadingFill(a[0]));

    on('beginText', () => {
      const s = this.state;
      s.textMatrix = IDENTITY;
      s.x = s.y = s.lineX = s.lineY = 0;
    });
    on('endText', () => {
      // 用文字轮廓做裁剪：没法用一个矩形表达，只能记下"这里有个说不清形状的裁剪"
      if (this.textClip) this.state.clip = { ...(this.state.clip ?? this.pageBox()), exact: false };
      this.textClip = false;
    });
    on('setCharSpacing', (a) => (this.state.charSpacing = Number(a[0]) || 0));
    on('setWordSpacing', (a) => (this.state.wordSpacing = Number(a[0]) || 0));
    on('setHScale', (a) => (this.state.hScale = (Number(a[0]) || 0) / 100));
    on('setLeading', (a) => (this.state.leading = -(Number(a[0]) || 0)));
    on('setFont', (a) => this.setFont(a[0], a[1]));
    on('setTextRenderingMode', (a) => (this.state.renderMode = Number(a[0]) || 0));
    on('setTextRise', (a) => (this.state.rise = Number(a[0]) || 0));
    on('moveText', (a) => this.moveText(a[0], a[1]));
    on('setLeadingMoveText', (a) => {
      this.state.leading = Number(a[1]) || 0;
      this.moveText(a[0], a[1]);
    });
    on('setTextMatrix', (a) => {
      const s = this.state;
      s.textMatrix = toMatrix(a[0]);
      s.x = s.y = s.lineX = s.lineY = 0;
    });
    on('nextLine', () => this.moveText(0, this.state.leading));
    on('showText', (a) => this.showText(a[0]));

    on('paintImageXObject', (a) => this.paintImage(a[0], 'image'));
    on('paintInlineImageXObject', (a) => this.paintImage(a[0], 'image'));
    on('paintImageMaskXObject', (a) => this.paintImage(a[0], 'mask'));
    on('paintImageXObjectRepeat', (a) => {
      const positions: ArrayLike<number> = a[3] ?? [];
      for (let i = 0; i + 1 < positions.length; i += 2) {
        this.within([a[1], 0, 0, a[2], positions[i]!, positions[i + 1]!], () => this.paintImage(a[0], 'image'));
      }
    });
    on('paintImageMaskXObjectRepeat', (a) => {
      const positions: ArrayLike<number> = a[5] ?? [];
      for (let i = 0; i + 1 < positions.length; i += 2) {
        const m: Matrix = [a[1], a[2] ?? 0, a[3] ?? 0, a[4], positions[i]!, positions[i + 1]!];
        this.within(m, () => this.paintImage(a[0], 'mask'));
      }
    });
    on('paintImageMaskXObjectGroup', (a) => {
      for (const image of a[0] ?? []) this.within(toMatrix(image.transform), () => this.paintImage(image, 'mask'));
    });
    on('paintInlineImageXObjectGroup', (a) => {
      for (const entry of a[1] ?? []) {
        this.within(toMatrix(entry.transform), () => this.paintImage(a[0], 'image', entry));
      }
    });
    on('paintSolidColorImageMask', () => {
      this.paintPath(
        transformPath([MOVE, 0, 0, LINE, 1, 0, LINE, 1, 1, LINE, 0, 1, CLOSE], this.state.ctm),
        true,
        false,
        'nonzero',
      );
    });

    on('paintFormXObjectBegin', (a) => {
      this.save();
      if (a[0]) this.transform(toMatrix(a[0]));
      if (a[1]) this.clipBox(a[1]);
    });
    on('paintFormXObjectEnd', () => this.restore());
    on('beginGroup', (a) => this.beginGroup(a[0] ?? {}));
    on('endGroup', () => this.endGroup());

    on('beginAnnotation', (a) => {
      // 批注的外观不受页面内容留下的状态影响：从初始状态开始画
      this.annotations.push(this.stack.length);
      this.save();
      this.state = this.initialState();
      if (a[1]) this.clipBox(a[1]);
      if (a[2]) this.transform(toMatrix(a[2]));
      if (a[3]) this.transform(toMatrix(a[3]));
    });
    on('endAnnotation', () => {
      const depth = this.annotations.pop();
      if (depth !== undefined) while (this.stack.length > depth) this.restore();
    });

    on('beginMarkedContent', () => this.marked.push(true));
    on('beginMarkedContentProps', (a) => {
      const shown = a[0] !== 'OC' || this.resources.visible(a[1]);
      this.marked.push(shown);
      if (!shown) this.hidden++;
    });
    on('endMarkedContent', () => {
      if (this.marked.pop() === false) this.hidden--;
    });
  }

  // ───────────── 图形状态 ─────────────

  private save(): void {
    this.stack.push(this.state);
    this.state = { ...this.state };
  }

  private restore(): void {
    const previous = this.stack.pop();
    if (previous) this.state = previous;
  }

  private transform(m: Matrix): void {
    this.state.ctm = multiply(this.state.ctm, m);
  }

  /** 临时叠加一个变换，执行完恢复 */
  private within(m: Matrix, fn: () => void): void {
    const saved = this.state.ctm;
    this.state.ctm = multiply(saved, m);
    fn();
    this.state.ctm = saved;
  }

  private setGState(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    const s = this.state;
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const [key, value] = entry as [string, Args[number]];
      if (key === 'LW') s.lineWidth = Number(value) || 0;
      else if (key === 'CA') s.strokeAlpha = clamp01(value);
      else if (key === 'ca') s.fillAlpha = clamp01(value);
      else if (key === 'BM') s.blendMode = value === 'source-over' ? 'normal' : toBlendMode(value);
      else if (key === 'SMask') s.softMask = Boolean(value);
      else if (key === 'D') s.dashed = (value?.[0]?.length ?? 0) > 0;
      else if (key === 'Font') this.setFont(value?.[0], value?.[1]);
    }
  }

  private patternPaint(args: Args): Paint {
    if (args[0] === 'Shading' && typeof args[1] === 'string') {
      const color = shadingColor(this.resources.shading(args[1]));
      if (color) return { kind: 'gradient', ...color };
    }
    return { kind: 'pattern' };
  }

  private pageBox(): Box {
    return { x0: 0, y0: 0, x1: this.viewport.width, y1: this.viewport.height };
  }

  /** 把当前的裁剪范围和一条路径取交集 */
  private applyClip(path: PathData, fillRule: 'nonzero' | 'evenodd' = 'nonzero'): void {
    const bounds = controlBounds(path);
    const current = this.state.clip;
    if (!bounds) {
      // 空路径做裁剪：之后什么都画不出来
      this.state.clip = { x0: 0, y0: 0, x1: 0, y1: 0, exact: true };
      return;
    }
    const rect = asAxisRect(path);
    if (!current || (current.exact && boxContains(current, bounds, 0.01))) {
      // 新路径整个落在现有的矩形范围里：裁剪区域就是这条路径本身
      this.state.clip = rect ? { ...rect, exact: true } : { ...bounds, exact: false, shape: { data: path, fillRule } };
    } else if (rect && boxContains(rect, current, 0.01)) {
      // 新的矩形把现有的范围整个包住了：不起作用
    } else {
      this.state.clip = { ...intersectBoxes(current, bounds), exact: current.exact && rect !== null };
    }
  }

  /** 用用户空间里的一个矩形 [x0, y0, x1, y1] 裁剪 */
  private clipBox(box: ArrayLike<number>): void {
    const [x0, y0, x1, y1] = [box[0]!, box[1]!, box[2]!, box[3]!];
    this.applyClip(transformPath([MOVE, x0, y0, LINE, x1, y0, LINE, x1, y1, LINE, x0, y1, CLOSE], this.state.ctm));
  }

  // ───────────── 输出对象 ─────────────

  private emit(item: PdfItem): void {
    if (this.state.softMask) this.issues.softMasks++;
    this.current.push(item);
  }

  private fillColor(): Color | null {
    const { fill, fillAlpha } = this.state;
    if (fillAlpha <= 0 || fill.kind === 'none') return null;
    if (fill.kind === 'pattern') {
      this.issues.patterns++;
      return null;
    }
    if (fill.kind === 'gradient') this.issues.gradients++;
    return { r: fill.r, g: fill.g, b: fill.b, a: fillAlpha };
  }

  private strokeStyle(): PdfStroke | null {
    const { stroke, strokeAlpha, lineWidth, ctm, dashed } = this.state;
    if (strokeAlpha <= 0 || stroke.kind === 'none') return null;
    if (stroke.kind === 'pattern') {
      this.issues.patterns++;
      return null;
    }
    if (stroke.kind === 'gradient') this.issues.gradients++;
    if (dashed) this.issues.dashes++;
    // PDF 里线宽为 0 表示"设备能画出的最细的线"，给它一个看得见的细线宽度
    const width = lineWidth * scaleOf(ctm) || 0.25;
    return { color: { r: stroke.r, g: stroke.g, b: stroke.b, a: strokeAlpha }, width };
  }

  private paintPath(data: PathData, fill: boolean, stroke: boolean, fillRule: 'nonzero' | 'evenodd'): void {
    if (!this.visible) return;
    const fillColor = fill ? this.fillColor() : null;
    const strokeStyle = stroke ? this.strokeStyle() : null;
    if (!fillColor && !strokeStyle) return;
    const { blendMode, clip } = this.state;
    this.emit({ kind: 'path', data, fill: fillColor, fillRule, stroke: strokeStyle, blendMode, clip });
  }

  /** 用渐变填满当前的裁剪范围 */
  private shadingFill(id: unknown): void {
    if (!this.visible || typeof id !== 'string') return;
    const color = shadingColor(this.resources.shading(id));
    const alpha = this.state.fillAlpha;
    const page = this.pageBox();
    const box = this.state.clip ? intersectBoxes(this.state.clip, page) : page;
    if (!color || alpha <= 0 || box.x1 <= box.x0 || box.y1 <= box.y0) return;
    this.issues.gradients++;
    this.emit({
      kind: 'path',
      data: [MOVE, box.x0, box.y0, LINE, box.x1, box.y0, LINE, box.x1, box.y1, LINE, box.x0, box.y1, CLOSE],
      fill: { ...color, a: alpha },
      fillRule: 'nonzero',
      stroke: null,
      blendMode: this.state.blendMode,
      clip: this.state.clip,
    });
  }

  private paintImage(
    ref: unknown,
    kind: 'image' | 'mask',
    part?: { x: number; y: number; w: number; h: number },
  ): void {
    if (!this.visible) return;
    const s = this.state;
    if (s.fillAlpha <= 0) return;
    let tint: Color | null = null;
    if (kind === 'mask') {
      // 蒙版图片：只有形状，颜色用当前的填充色
      const color = this.fillColor();
      if (!color) return;
      tint = { ...color, a: 1 };
    }
    let source = this.resources.image(ref, kind);
    if (source && part && (part.x !== 0 || part.y !== 0 || part.w !== source.width || part.h !== source.height)) {
      source = this.crop(source, part);
    }
    if (!source) {
      this.issues.images++;
      return;
    }
    this.emit({
      kind: 'image',
      source,
      tint,
      opacity: s.fillAlpha,
      // PDF 的图片占满用户空间的单位正方形，y 向上；换成左上角为原点、y 向下
      matrix: multiply(s.ctm, [1, 0, 0, -1, 0, 1]),
      blendMode: s.blendMode,
      clip: s.clip,
    });
  }

  private crop(source: PdfImageSource, part: { x: number; y: number; w: number; h: number }): PdfImageSource | null {
    let cache = this.crops.get(source);
    if (!cache) this.crops.set(source, (cache = new Map()));
    const key = `${part.x},${part.y},${part.w},${part.h}`;
    if (!cache.has(key)) cache.set(key, cropSource(source, part.x, part.y, part.w, part.h));
    return cache.get(key) ?? null;
  }

  // ───────────── 透明组 ─────────────

  private beginGroup(group: {
    matrix?: ArrayLike<number> | null;
    bbox?: ArrayLike<number> | null;
    smask?: unknown;
  }): void {
    this.save();
    const s = this.state;
    this.groups.push({ mask: Boolean(group.smask), opacity: s.fillAlpha, blendMode: s.blendMode });
    this.containers.push([]);
    if (group.bbox) {
      const saved = s.ctm;
      if (group.matrix) s.ctm = multiply(saved, toMatrix(group.matrix));
      this.clipBox(group.bbox);
      s.ctm = saved;
    }
    // 组里的内容先按完全不透明、正常混合画好，组的透明度和混合模式在收尾时整体应用
    s.fillAlpha = 1;
    s.strokeAlpha = 1;
    s.blendMode = 'normal';
    s.softMask = false;
  }

  private endGroup(): void {
    const frame = this.groups.pop();
    if (!frame || this.containers.length < 2) return;
    const items = this.containers.pop()!;
    this.restore();
    if (frame.mask || items.length === 0 || frame.opacity <= 0) return;

    const plain = frame.opacity >= 0.999 && frame.blendMode === 'normal';
    if (plain) {
      for (const item of items) this.current.push(item);
      if (this.state.softMask) this.issues.softMasks += items.length;
      return;
    }
    // 只有一个对象的组不需要真的建组：把透明度直接乘到这个对象上，效果完全一样
    const only = items.length === 1 ? items[0]! : null;
    if (only && only.blendMode === 'normal') {
      const folded = foldOpacity(only, frame.opacity);
      if (folded) {
        folded.blendMode = frame.blendMode;
        this.emit(folded);
        return;
      }
    }
    this.emit({ kind: 'group', opacity: frame.opacity, blendMode: frame.blendMode, clip: null, items });
  }

  // ───────────── 文字 ─────────────

  private setFont(id: unknown, size: unknown): void {
    const s = this.state;
    s.font = typeof id === 'string' ? this.resources.font(id) : null;
    const value = Number(size) || 0;
    s.fontSize = Math.abs(value);
    s.fontDirection = value < 0 ? -1 : 1;
  }

  private moveText(x: unknown, y: unknown): void {
    const s = this.state;
    s.x = s.lineX += Number(x) || 0;
    s.y = s.lineY += Number(y) || 0;
  }

  private showText(glyphs: readonly (Glyph | number)[] | undefined): void {
    const s = this.state;
    const font = s.font;
    if (!font || !glyphs) return;
    if (font.type3) {
      this.showType3Text(font, glyphs);
      return;
    }
    const size = s.fontSize;
    if (size === 0) return;

    const direction = s.fontDirection;
    const hScale = s.hScale * direction;
    const spacingSign = font.vertical ? 1 : -1;
    const advanceScale = size * font.fontMatrix[0];
    // 文字空间 → 页面。最后一步把 y 翻过来，字形轮廓（y 向上）乘上 (size, -size) 之后正好是正的
    const base = multiply(multiply(multiply(s.ctm, s.textMatrix), translation(s.x, s.y + s.rise)), [
      hScale,
      0,
      0,
      direction > 0 ? -1 : 1,
      0,
      0,
    ]);
    const mode = s.renderMode & 3;
    const shown = this.visible && mode !== 3;
    if (s.renderMode & 4) this.textClip = true;

    const data: PathData = [];
    let text = '';
    let needsFallback = false;
    let x = 0;
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') {
        x += (spacingSign * glyph * size) / 1000;
        continue;
      }
      const spacing = (glyph.isSpace ? s.wordSpacing : 0) + s.charSpacing;
      let gx = x;
      let gy = 0;
      let width = glyph.width;
      if (font.vertical && glyph.vmetric) {
        gx = -glyph.vmetric[1]! * advanceScale;
        gy = x + glyph.vmetric[2]! * advanceScale;
        width = -glyph.vmetric[0]!;
      }
      if (shown) {
        text += glyph.unicode ?? '';
        if (font.missing) {
          if (!glyph.isSpace) needsFallback = true;
        } else if (glyph.isInFont) {
          const place = (fontChar: string, px: number, py: number): void => {
            const outline = this.resources.glyph(font, fontChar);
            if (outline) appendTransformed(data, outline, multiply(base, [size, 0, 0, -size, px, py]));
          };
          place(glyph.fontChar, gx, gy);
          if (glyph.accent) {
            place(glyph.accent.fontChar, gx + size * glyph.accent.offset.x, gy - size * glyph.accent.offset.y);
          }
        }
      }
      x += font.vertical ? width * advanceScale - spacing * direction : width * advanceScale + spacing * direction;
    }

    const startX = base[4];
    const startY = base[5];
    const [endX, endY] = font.vertical
      ? [base[2] * x + base[4], base[3] * x + base[5]]
      : [base[0] * x + base[4], base[1] * x + base[5]];
    if (font.vertical) s.y -= x;
    else s.x += x * hScale;

    if (!shown || (data.length === 0 && !(needsFallback && text.trim()))) return;
    const fill = mode === 0 || mode === 2 ? this.fillColor() : null;
    const stroke = mode === 1 || mode === 2 ? this.strokeStyle() : null;
    if (!fill && !stroke) return;

    const length = Math.hypot(endX - startX, endY - startY);
    const axis = Math.hypot(base[0], base[1]) || 1;
    this.emitText({
      kind: 'text',
      text,
      data,
      fill,
      stroke,
      fontName: font.name,
      fontId: font.id,
      bold: font.bold,
      italic: font.italic,
      size: size * Math.hypot(base[2], base[3]),
      x: startX,
      y: startY,
      // 朝向取文字前进的方向；字号为负或水平缩放为负时前进方向与坐标轴相反
      dirX: length > 1e-9 ? (endX - startX) / length : base[0] / axis,
      dirY: length > 1e-9 ? (endY - startY) / length : base[1] / axis,
      length,
      vertical: font.vertical,
      blendMode: s.blendMode,
      clip: s.clip,
    });
  }

  /**
   * 输出一段文字。PDF 经常把一行字拆成很多小段（换一次字体就是一段，有的甚至一个字一段），
   * 这里把紧挨着、字号和颜色相同、在同一条基线上的小段接成一个对象，不然图层列表里全是碎片。
   * 字体不同也照样接：中英文混排的一行字本来就是好几种字体。
   */
  private emitText(item: PdfTextItem): void {
    const previous = this.current[this.current.length - 1];
    if (previous?.kind === 'text' && !previous.vertical && !item.vertical) {
      const dx = item.x - previous.x;
      const dy = item.y - previous.y;
      const along = dx * previous.dirX + dy * previous.dirY;
      const across = Math.abs(dx * previous.dirY - dy * previous.dirX);
      const gap = along - previous.length;
      const size = previous.size;
      const joinable =
        Math.abs(size - item.size) < size * 1e-3 &&
        previous.dirX * item.dirX + previous.dirY * item.dirY > 0.9999 &&
        across < size * 0.05 &&
        gap > -size * 0.5 &&
        gap < size * 1.5 &&
        (previous.data.length === 0) === (item.data.length === 0) &&
        previous.data.length + item.data.length <= MAX_RUN_DATA &&
        previous.blendMode === item.blendMode &&
        sameColor(previous.fill, item.fill) &&
        sameStroke(previous.stroke, item.stroke) &&
        sameClip(previous.clip, item.clip);
      if (joinable) {
        const spaced = gap > size * 0.2 && !previous.text.endsWith(' ') && !item.text.startsWith(' ');
        previous.text += (spaced ? ' ' : '') + item.text;
        for (const value of item.data) previous.data.push(value);
        previous.length = along + item.length;
        return;
      }
    }
    this.emit(item);
  }

  /** Type3 字体：每个字是一小段绘图指令，在字的位置上把它执行一遍 */
  private showType3Text(font: PdfFont, glyphs: readonly (Glyph | number)[]): void {
    const s = this.state;
    const size = s.fontSize;
    if (size === 0) return;
    const direction = s.fontDirection;
    const hScale = s.hScale * direction;
    const spacingSign = font.vertical ? 1 : -1;
    const fontMatrix = font.fontMatrix;
    const shown = this.visible && s.renderMode !== 3 && this.depth < MAX_DEPTH;
    let at = multiply(multiply(multiply(s.ctm, s.textMatrix), translation(s.x, s.y + s.rise)), [
      hScale,
      0,
      0,
      direction,
      0,
      0,
    ]);
    const start = at;
    const { blendMode, clip } = s;

    this.containers.push([]);
    let text = '';
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') {
        const shift = (spacingSign * glyph * size) / 1000;
        at = multiply(at, translation(shift, 0));
        s.x += shift * hScale;
        continue;
      }
      const spacing = (glyph.isSpace ? s.wordSpacing : 0) + s.charSpacing;
      const proc = glyph.operatorListId !== undefined ? font.charProc?.(glyph.operatorListId) : null;
      if (proc && shown) {
        const depth = this.stack.length;
        this.save();
        this.state.ctm = multiply(multiply(at, [size, 0, 0, size, 0, 0]), fontMatrix);
        this.depth++;
        this.run(proc);
        this.depth--;
        while (this.stack.length > depth) this.restore();
      }
      if (shown) text += glyph.unicode ?? '';
      const width = glyph.width * fontMatrix[0] * size + spacing * direction;
      at = multiply(at, translation(width, 0));
      s.x += width * hScale;
    }
    const items = this.containers.pop()!;
    if (items.length === 0) return;

    // 所有字都是同一种填充的路径时，合成一段文字；否则（比如点阵字体，每个字是一张小图）编成一组
    const first = items[0]!;
    const uniform =
      first.kind === 'path' &&
      items.every(
        (item) =>
          item.kind === 'path' &&
          item.fillRule === 'nonzero' &&
          item.blendMode === first.blendMode &&
          sameColor(item.fill, first.fill) &&
          sameStroke(item.stroke, first.stroke) &&
          sameClip(item.clip, first.clip),
      );
    if (!uniform || first.kind !== 'path') {
      this.current.push({ kind: 'group', name: text.trim() || undefined, opacity: 1, blendMode, clip, items });
      return;
    }
    const data: PathData = [];
    for (const item of items) if (item.kind === 'path') for (const value of item.data) data.push(value);
    const length = Math.hypot(at[4] - start[4], at[5] - start[5]);
    const axis = Math.hypot(start[0], start[1]) || 1;
    this.emitText({
      kind: 'text',
      text,
      data,
      fill: first.fill,
      stroke: first.stroke,
      fontName: font.name,
      fontId: font.id,
      bold: font.bold,
      italic: font.italic,
      size: size * Math.hypot(start[2], start[3]),
      x: start[4],
      y: start[5],
      dirX: length > 1e-9 ? (at[4] - start[4]) / length : start[0] / axis,
      dirY: length > 1e-9 ? (at[5] - start[5]) / length : start[1] / axis,
      length,
      vertical: font.vertical,
      blendMode: first.blendMode,
      clip: first.clip,
    });
  }
}

function clamp01(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/**
 * 把一个透明度乘到单个对象上。只有在结果和"先画好再整体变透明"完全一样时才这么做：
 * 同时有填充和描边的形状不行（描边和填充重叠的地方会透出两层）。
 */
function foldOpacity(item: PdfItem, opacity: number): PdfItem | null {
  if (item.kind === 'image') return { ...item, opacity: item.opacity * opacity };
  if (item.kind === 'group') return { ...item, opacity: item.opacity * opacity } satisfies PdfGroupItem;
  if (item.fill && item.stroke) return null;
  return {
    ...item,
    fill: item.fill && { ...item.fill, a: item.fill.a * opacity },
    stroke: item.stroke && { ...item.stroke, color: { ...item.stroke.color, a: item.stroke.color.a * opacity } },
  };
}

/** 解释一页的绘图指令，得到页面上的对象列表 */
export function interpretPage(list: PdfOperatorList, resources: PdfResources, viewport: PdfViewport): PdfPage {
  const interpreter = new Interpreter(resources, viewport);
  interpreter.run(list);
  return interpreter.finish();
}
