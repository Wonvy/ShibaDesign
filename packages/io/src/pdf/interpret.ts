import {
  BLEND_MODES,
  IDENTITY,
  gradientColorAt,
  multiply,
  parseHex,
  type BlendMode,
  type Color,
  type Matrix,
} from '@shiba/core';
import { asAxisRect, boxContains, controlBounds, intersectBoxes, scaleOf, transformPath } from './geometry';
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
  type PdfImageSource,
  type PdfItem,
  type PdfPage,
  type PdfStroke,
  type PdfTextFont,
  type PdfTextItem,
  type PdfTextStyleRun,
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
  serif: boolean;
  monospace: boolean;
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
  /** 渐变：平均色，以及能还原时的渐变本身（透明度还没乘） */
  | { kind: 'gradient'; r: number; g: number; b: number; gradient: PdfGradient | null }
  | { kind: 'pattern' }
  | { kind: 'none' };

interface State {
  ctm: Matrix;
  /** 图案坐标的基准：页面开始时的坐标变换，在表单里是表单的坐标。图案渐变的矩阵相对它 */
  base: Matrix;
  fill: Paint;
  stroke: Paint;
  fillAlpha: number;
  strokeAlpha: number;
  blendMode: BlendMode;
  lineWidth: number;
  dashed: boolean;
  softMask: boolean;
  /** 软蒙版画出来的内容。只有"一个灰度渐变"这种能还原成渐变透明度的蒙版才用得上 */
  mask: PdfItem[] | null;
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
/** 合并同一行文字时，一个对象最多攒这么多字，免得一整页密密麻麻的字变成一个巨大的对象 */
const MAX_RUN_GLYPHS = 4000;
/** 探测 Type3 字形时用的填充色：字形自己没设颜色的话，画出来就是这个颜色 */
/** 同一行里相隔超过这么多个字号的两段字不算同一段：多半是表格的两列，或者项目符号和正文 */
const SPLIT_GAP = 1.2;
/** 相隔超过这么多个字号就当作中间有个空格 */
const SPACE_GAP = 0.15;
const PROBE_COLOR = { r: 0.123, g: 0.456, b: 0.789 };
const PROBE: Paint = { kind: 'color', ...PROBE_COLOR };

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

/** 一个渐变最多留多少个色标。pdf.js 把渐变函数采样成色标，复杂的函数会有几百个 */
const MAX_STOPS = 256;

/**
 * 读出线性、径向渐变：色标和几何。读不懂的（网格渐变、函数渐变）返回 null，用平均色顶上。
 * 渐变两头不延伸时，pdf.js 在两头补一个透明色标，这里照样留着：透明的那一头正好就是"不延伸"
 */
function parseGradient(ir: unknown, matrix: Matrix): PdfGradient | null {
  if (!Array.isArray(ir) || ir[0] !== 'RadialAxial' || !Array.isArray(ir[3])) return null;
  const [, type, , rawStops, p0, p1, r0, r1] = ir as [
    unknown,
    unknown,
    unknown,
    unknown[],
    unknown,
    unknown,
    unknown,
    unknown,
  ];
  if (!Array.isArray(p0) || !Array.isArray(p1)) return null;
  const numbers = [p0[0], p0[1], p1[0], p1[1]];
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const stops: { offset: number; color: Color | null }[] = [];
  for (const stop of rawStops) {
    if (!Array.isArray(stop) || typeof stop[0] !== 'number' || !Number.isFinite(stop[0])) continue;
    const color = typeof stop[1] === 'string' && stop[1] !== 'transparent' ? parseHex(stop[1]) : null;
    stops.push({ offset: Math.min(1, Math.max(0, stop[0])), color });
  }
  // 透明色标借用旁边色标的颜色，只把透明度设成 0，免得过渡时混进黑色
  const solid = stops.filter((s) => s.color);
  if (solid.length === 0) return null;
  const resolved = stops.map((s, i) => {
    if (s.color) return { offset: s.offset, color: s.color };
    const neighbor = stops.slice(i + 1).find((n) => n.color) ?? [...stops.slice(0, i)].reverse().find((n) => n.color);
    return { offset: s.offset, color: { ...neighbor!.color!, a: 0 } };
  });
  resolved.sort((a, b) => a.offset - b.offset);
  let kept = resolved;
  if (kept.length > MAX_STOPS) {
    const step = (kept.length - 1) / (MAX_STOPS - 1);
    kept = Array.from({ length: MAX_STOPS }, (_, i) => resolved[Math.round(i * step)]!);
  }
  const radial = type === 'radial';
  const radius = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  return {
    kind: radial ? 'radial' : 'linear',
    stops: kept,
    x0: numbers[0] as number,
    y0: numbers[1] as number,
    x1: numbers[2] as number,
    y1: numbers[3] as number,
    r0: radial ? radius(r0) : 0,
    r1: radial ? radius(r1) : 0,
    matrix,
  };
}

function withAlpha(gradient: PdfGradient, alpha: number): PdfGradient {
  if (alpha >= 1) return gradient;
  return { ...gradient, stops: gradient.stops.map((s) => ({ ...s, color: { ...s.color, a: s.color.a * alpha } })) };
}

/** 渐变的平均色。没法还原成渐变的地方（文字、描边、网格渐变）用一个最接近的纯色顶上 */
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

/** 一行字里字数最多的字体和颜色（不算空白） */
function dominantStyle(text: string, styles: readonly PdfTextStyleRun[]): { font: PdfTextFont; fill: Color | null } {
  const fonts = new Map<string, { font: PdfTextFont; count: number }>();
  const fills = new Map<string, { fill: Color | null; count: number }>();
  let at = 0;
  for (const run of styles) {
    const count = text.slice(at, at + run.length).replace(/\s/g, '').length;
    at += run.length;
    const fontEntry = fonts.get(run.font.name) ?? { font: run.font, count: 0 };
    fontEntry.count += count;
    fonts.set(run.font.name, fontEntry);
    const key = run.fill ? `${run.fill.r},${run.fill.g},${run.fill.b},${run.fill.a}` : '';
    const fillEntry = fills.get(key) ?? { fill: run.fill, count: 0 };
    fillEntry.count += count;
    fills.set(key, fillEntry);
  }
  // 字数一样多时取先出现的
  const pick = <T extends { count: number }>(entries: Iterable<T>): T => {
    let best: T | null = null;
    for (const entry of entries) if (!best || entry.count > best.count) best = entry;
    return best!;
  };
  return { font: pick(fonts.values()).font, fill: pick(fills.values()).fill };
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
  /** Type3 字形的轮廓，按字体和字形缓存；null 表示这个字形不能当普通字形处理 */
  private readonly type3Outlines = new Map<string, PathData | null>();
  /** 最近一个软蒙版组画出来的内容，见 endGroup */
  private lastMask: PdfItem[] | null = null;

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
      base: this.viewport.transform,
      fill: BLACK,
      stroke: BLACK,
      fillAlpha: 1,
      strokeAlpha: 1,
      blendMode: 'normal',
      lineWidth: 1,
      dashed: false,
      softMask: false,
      mask: null,
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
      this.state.base = this.state.ctm;
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
      this.state.base = this.state.ctm;
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
      else if (key === 'SMask') {
        s.softMask = Boolean(value);
        // 蒙版的内容在设置它之前已经作为一个蒙版组画过了，见 endGroup
        s.mask = value ? this.lastMask : null;
      } else if (key === 'D') s.dashed = (value?.[0]?.length ?? 0) > 0;
      else if (key === 'Font') this.setFont(value?.[0], value?.[1]);
    }
  }

  private patternPaint(args: Args): Paint {
    if (args[0] === 'Shading' && typeof args[1] === 'string') {
      const ir = this.resources.shading(args[1]);
      const color = shadingColor(ir);
      // 图案的矩阵相对图案坐标的基准（页面开始时，或者表单的坐标），不是当前的坐标变换
      const matrix = args[2] ? multiply(this.state.base, toMatrix(args[2])) : this.state.base;
      if (color) return { kind: 'gradient', ...color, gradient: parseGradient(ir, matrix) };
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

  /** @param masked 软蒙版已经在这个对象上还原了（渐变的透明度），不算没还原 */
  private emit(item: PdfItem, masked = false): void {
    if (this.state.softMask && !masked) this.issues.softMasks++;
    this.current.push(item);
  }

  /**
   * 渐变填充遇到软蒙版：蒙版要是一个几何完全相同的灰度渐变（很多软件就是这样写"渐变的透明度"的，我们自己导出也是），
   * 把蒙版的亮度乘进色标的透明度里，就是一个带透明度的渐变。别的蒙版还原不了，返回 null
   */
  private maskedGradient(gradient: PdfGradient): PdfGradient | null {
    const mask = this.state.mask;
    const only = mask?.length === 1 ? mask[0] : null;
    const m = only?.kind === 'path' ? only.gradient : undefined;
    if (!m || m.kind !== gradient.kind) return null;
    const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
    const geometry = [m.x0, m.y0, m.x1, m.y1, m.r0, m.r1, ...m.matrix];
    const expected = [gradient.x0, gradient.y0, gradient.x1, gradient.y1, gradient.r0, gradient.r1, ...gradient.matrix];
    if (!geometry.every((v, i) => close(v, expected[i]!))) return null;
    const offsets = [...new Set([...gradient.stops, ...m.stops].map((s) => s.offset))].sort((a, b) => a - b);
    const stops = offsets.map((offset) => {
      const color = gradientColorAt(gradient.stops, offset);
      const lum = gradientColorAt(m.stops, offset);
      const luminance = (0.3 * lum.r + 0.59 * lum.g + 0.11 * lum.b) * lum.a;
      return { offset, color: { ...color, a: color.a * luminance } };
    });
    return { ...gradient, stops };
  }

  /** @param gradientOk 用到的地方能用渐变本身（形状的填充）：这时渐变不算没还原 */
  private fillColor(gradientOk = false): Color | null {
    const { fill, fillAlpha } = this.state;
    if (fillAlpha <= 0 || fill.kind === 'none') return null;
    if (fill.kind === 'pattern') {
      this.issues.patterns++;
      return null;
    }
    if (fill.kind === 'gradient' && !(gradientOk && fill.gradient)) this.issues.gradients++;
    return { r: fill.r, g: fill.g, b: fill.b, a: fillAlpha };
  }

  /** 当前的填充是可以还原的渐变时，返回它（透明度乘好了） */
  private fillGradient(): PdfGradient | null {
    const { fill, fillAlpha } = this.state;
    if (fill.kind !== 'gradient' || !fill.gradient || fillAlpha <= 0) return null;
    return withAlpha(fill.gradient, fillAlpha);
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
    const fillColor = fill ? this.fillColor(true) : null;
    let gradient = fill ? this.fillGradient() : null;
    const strokeStyle = stroke ? this.strokeStyle() : null;
    if (!fillColor && !strokeStyle) return;
    const { blendMode, clip } = this.state;
    const masked = gradient && this.state.softMask && !strokeStyle ? this.maskedGradient(gradient) : null;
    if (masked) gradient = masked;
    this.emit(
      {
        kind: 'path',
        data,
        fill: fillColor,
        ...(gradient ? { gradient } : {}),
        fillRule,
        stroke: strokeStyle,
        blendMode,
        clip,
      },
      masked !== null,
    );
  }

  /** 用渐变填满当前的裁剪范围 */
  private shadingFill(id: unknown): void {
    if (!this.visible || typeof id !== 'string') return;
    const ir = this.resources.shading(id);
    const color = shadingColor(ir);
    const alpha = this.state.fillAlpha;
    const page = this.pageBox();
    const box = this.state.clip ? intersectBoxes(this.state.clip, page) : page;
    if (!color || alpha <= 0 || box.x1 <= box.x0 || box.y1 <= box.y0) return;
    // sh 指令里渐变的坐标就是当前的用户空间
    const parsed = parseGradient(ir, this.state.ctm);
    let gradient = parsed ? withAlpha(parsed, alpha) : null;
    if (!gradient) this.issues.gradients++;
    const masked = gradient && this.state.softMask ? this.maskedGradient(gradient) : null;
    if (masked) gradient = masked;
    this.emit(
      {
        kind: 'path',
        data: [MOVE, box.x0, box.y0, LINE, box.x1, box.y0, LINE, box.x1, box.y1, LINE, box.x0, box.y1, CLOSE],
        fill: { ...color, a: alpha },
        ...(gradient ? { gradient } : {}),
        fillRule: 'nonzero',
        stroke: null,
        blendMode: this.state.blendMode,
        clip: this.state.clip,
      },
      masked !== null,
    );
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
    if (frame.mask) {
      // 软蒙版的内容不画出来，留给接下来设置蒙版的那一步
      this.lastMask = items;
      return;
    }
    if (items.length === 0 || frame.opacity <= 0) return;

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

  private textFont(font: PdfFont): PdfTextFont {
    return { name: font.name, bold: font.bold, italic: font.italic, serif: font.serif, monospace: font.monospace };
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

    // 一次显示的字可能被很大的空隙隔成几段（排版软件常用这种办法对齐表格的列、项目符号和正文），
    // 每段单独成为一行文字，免得把不相干的内容拼在一起
    let segment = { glyphs: [] as PdfGlyph[], text: '', start: null as number | null, end: 0, fallback: false };
    let style: { fill: Color | null; stroke: PdfStroke | null } | null = null;
    const flush = (): void => {
      const { glyphs: placed, text, start, end, fallback } = segment;
      segment = { glyphs: [], text: '', start: null, end: 0, fallback: false };
      if (!shown || start === null || (placed.length === 0 && !(fallback && text.trim()))) return;
      style ??= {
        fill: mode === 0 || mode === 2 ? this.fillColor() : null,
        stroke: mode === 1 || mode === 2 ? this.strokeStyle() : null,
      };
      if (!style.fill && !style.stroke) return;
      for (const glyph of placed) glyph.fill = style.fill;
      const textFont = this.textFont(font);
      const at = (t: number): [number, number] =>
        font.vertical ? [base[2] * t + base[4], base[3] * t + base[5]] : [base[0] * t + base[4], base[1] * t + base[5]];
      const [startX, startY] = at(start);
      const [endX, endY] = at(end);
      const length = Math.hypot(endX - startX, endY - startY);
      const axis = Math.hypot(base[0], base[1]) || 1;
      this.emitText({
        kind: 'text',
        text,
        glyphs: placed,
        fill: style.fill,
        stroke: style.stroke,
        font: textFont,
        styles: [{ length: text.length, font: textFont, size: size * Math.hypot(base[2], base[3]), fill: style.fill }],
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
    };
    const place = (fontChar: string, px: number, py: number, text: string, advance: number): void => {
      const outline = this.resources.glyph(font, fontChar);
      if (!outline) return;
      const matrix = multiply(base, [size, 0, 0, -size, px, py]);
      segment.glyphs.push({ outline, font: font.id, matrix, text, advance });
    };

    let x = 0;
    // 两个字之间空出了一个词的距离，但文字里没有空格字符：等下一个字出现时补一个空格
    let pendingSpace = false;
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') {
        const shift = (spacingSign * glyph * size) / 1000;
        x += shift;
        if (!font.vertical && segment.start !== null) {
          if (shift >= size * SPLIT_GAP) {
            flush();
            pendingSpace = false;
          } else if (shift >= size * SPACE_GAP) {
            pendingSpace = true;
          }
        }
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
      const extra = font.vertical ? -spacing * direction : spacing * direction;
      if (shown) {
        segment.start ??= x;
        if (pendingSpace && !glyph.isSpace && !segment.text.endsWith(' ')) segment.text += ' ';
        pendingSpace = false;
        segment.text += glyph.unicode ?? '';
        if (font.missing) {
          if (!glyph.isSpace) segment.fallback = true;
        } else if (glyph.isInFont) {
          place(glyph.fontChar, gx, gy, glyph.unicode ?? '', width * font.fontMatrix[0]);
          if (glyph.accent) {
            const { fontChar, offset } = glyph.accent;
            place(fontChar, gx + size * offset.x, gy - size * offset.y, '', 0);
          }
        }
        segment.end = x + width * advanceScale;
      }
      x += width * advanceScale + extra;
      // 字距（Tc）也会被用来拉开很大的距离，或者代替空格，处理方式同上
      if (!font.vertical && shown && !glyph.isSpace) {
        if (extra >= size * SPLIT_GAP) {
          flush();
          pendingSpace = false;
        } else if (extra >= size * SPACE_GAP) {
          pendingSpace = true;
        }
      }
    }
    flush();
    if (font.vertical) s.y -= x;
    else s.x += x * hScale;
  }

  /**
   * 输出一段文字。PDF 经常把一行字拆成很多小段（换一次字体就是一段，有的甚至一个字一段），
   * 这里把紧挨着、在同一条基线上的小段接成一个对象，不然图层列表里全是碎片。
   * 字体、颜色、字号不同也照样接：中英文混排、加粗或换色的词、上标本来就夹在一行里；
   * 各段的样式记在 styles 里，变成文本之后成为字符级样式。
   */
  private emitText(item: PdfTextItem): void {
    const previous = this.current[this.current.length - 1];
    if (previous?.kind === 'text' && !previous.vertical && !item.vertical) {
      const dx = item.x - previous.x;
      const dy = item.y - previous.y;
      const along = dx * previous.dirX + dy * previous.dirY;
      const across = Math.abs(dx * previous.dirY - dy * previous.dirX);
      const gap = along - previous.length;
      const size = Math.max(previous.size, item.size);
      const sameSize = Math.abs(previous.size - item.size) <= size * 0.02;
      // 字号不同的小段也接上：上标、下标、小型大写字母都是这样夹在一行里的，基线可以错开一点
      const sameLine = sameSize ? across < size * 0.05 : across < size * 0.45 && item.size >= previous.size * 0.5;
      const joinable =
        item.size <= previous.size * 2 &&
        previous.dirX * item.dirX + previous.dirY * item.dirY > 0.9999 &&
        sameLine &&
        gap > -size * 0.5 &&
        gap < size * SPLIT_GAP &&
        (previous.glyphs.length === 0) === (item.glyphs.length === 0) &&
        previous.glyphs.length + item.glyphs.length <= MAX_RUN_GLYPHS &&
        previous.blendMode === item.blendMode &&
        (previous.fill === null) === (item.fill === null) &&
        sameStroke(previous.stroke, item.stroke) &&
        sameClip(previous.clip, item.clip);
      if (joinable) {
        const spaced = gap > size * SPACE_GAP && !previous.text.endsWith(' ') && !item.text.startsWith(' ');
        if (spaced) previous.styles[previous.styles.length - 1]!.length += 1;
        previous.styles.push(...item.styles);
        if (item.size > previous.size * 1.02) {
          // 后面接上来的字更大：这一行的字号和基线以大字为准（前面那段可能是上标或小字）
          previous.size = item.size;
          previous.x = item.x - previous.dirX * along;
          previous.y = item.y - previous.dirY * along;
        }
        previous.text += (spaced ? ' ' : '') + item.text;
        for (const glyph of item.glyphs) previous.glyphs.push(glyph);
        previous.length = along + item.length;
        // 这一行主要用哪种字体、哪种颜色：看哪种的字多
        const main = dominantStyle(previous.text, previous.styles);
        previous.font = main.font;
        previous.fill = main.fill;
        return;
      }
    }
    this.emit(item);
  }

  /**
   * Type3 字体的一个字形在字形坐标里的轮廓。Type3 字体的每个字是一小段绘图指令，
   * 用字体矩阵作为坐标变换把它执行一遍，收集画出来的路径。
   * 只有"只用当前填充色填充路径"的字形才能当作普通字形处理（绝大多数都是）；
   * 自带颜色、描边或者画图片的字形返回 null，整段文字改按原样执行。
   */
  private type3Outline(font: PdfFont, id: string, proc: PdfOperatorList): ArrayLike<number> | null {
    const key = `${font.id}\u0000${id}`;
    const cached = this.type3Outlines.get(key);
    if (cached !== undefined) return cached;

    const depth = this.stack.length;
    this.save();
    const s = this.state;
    s.ctm = font.fontMatrix;
    s.fill = PROBE;
    s.fillAlpha = 1;
    s.stroke = PROBE;
    s.softMask = false;
    const clip = s.clip;
    const blendMode = s.blendMode;
    const issues = { ...this.issues };
    this.containers.push([]);
    this.depth++;
    this.run(proc);
    this.depth--;
    const items = this.containers.pop()!;
    while (this.stack.length > depth) this.restore();
    // 探测时记下的问题不算数：真正画的时候会再记一次
    Object.assign(this.issues, issues);

    const probe = { ...PROBE_COLOR, a: 1 };
    const uniform = items.every(
      (item) =>
        item.kind === 'path' &&
        !item.stroke &&
        item.fillRule === 'nonzero' &&
        item.blendMode === blendMode &&
        item.clip === clip &&
        sameColor(item.fill, probe),
    );
    let outline: PathData | null = null;
    if (uniform) {
      outline = [];
      for (const item of items) if (item.kind === 'path') for (const value of item.data) outline.push(value);
    }
    this.type3Outlines.set(key, outline);
    return outline;
  }

  /** Type3 字体：每个字是一小段绘图指令 */
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

    // 先算好每个字的位置
    const placements: { proc: PdfOperatorList; at: Matrix; id: string; text: string; advance: number }[] = [];
    let text = '';
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') {
        const shift = (spacingSign * glyph * size) / 1000;
        at = multiply(at, translation(shift, 0));
        s.x += shift * hScale;
        continue;
      }
      const spacing = (glyph.isSpace ? s.wordSpacing : 0) + s.charSpacing;
      const id = glyph.operatorListId;
      const proc = id !== undefined ? font.charProc?.(id) : null;
      if (proc && shown && id !== undefined) {
        placements.push({ proc, at, id, text: glyph.unicode ?? '', advance: glyph.width * fontMatrix[0] });
      }
      if (shown) text += glyph.unicode ?? '';
      const width = glyph.width * fontMatrix[0] * size + spacing * direction;
      at = multiply(at, translation(width, 0));
      s.x += width * hScale;
    }
    if (placements.length === 0) return;

    // 通常情况：每个字都能当成普通字形，整段就是一行普通文字
    const outlines = placements.map((p) => this.type3Outline(font, p.id, p.proc));
    if (outlines.every((outline) => outline !== null)) {
      const fill = this.fillColor();
      if (!fill) return;
      const placed: PdfGlyph[] = [];
      placements.forEach((p, i) => {
        const outline = outlines[i]!;
        if (outline.length === 0) return;
        const matrix = multiply(p.at, [size, 0, 0, size, 0, 0]);
        placed.push({ outline, font: font.id, matrix, text: p.text, advance: p.advance, fill });
      });
      const textFont = this.textFont(font);
      const textSize = size * Math.hypot(start[2], start[3]);
      if (placed.length === 0) return;
      const length = Math.hypot(at[4] - start[4], at[5] - start[5]);
      const axis = Math.hypot(start[0], start[1]) || 1;
      this.emitText({
        kind: 'text',
        text,
        glyphs: placed,
        fill,
        stroke: null,
        font: textFont,
        styles: [{ length: text.length, font: textFont, size: textSize, fill }],
        size: textSize,
        x: start[4],
        y: start[5],
        dirX: length > 1e-9 ? (at[4] - start[4]) / length : start[0] / axis,
        dirY: length > 1e-9 ? (at[5] - start[5]) / length : start[1] / axis,
        length,
        vertical: font.vertical,
        blendMode,
        clip,
      });
      return;
    }

    // 有字自带颜色、描边或者是图片：在每个字的位置上把它原样执行一遍，整段编成一组
    this.containers.push([]);
    for (const p of placements) {
      const depth = this.stack.length;
      this.save();
      this.state.ctm = multiply(multiply(p.at, [size, 0, 0, size, 0, 0]), fontMatrix);
      this.depth++;
      this.run(p.proc);
      this.depth--;
      while (this.stack.length > depth) this.restore();
    }
    const items = this.containers.pop()!;
    if (items.length > 0) {
      this.current.push({ kind: 'group', name: text.trim() || undefined, opacity: 1, blendMode, clip, items });
    }
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
  const folded = {
    ...item,
    fill: item.fill && { ...item.fill, a: item.fill.a * opacity },
    stroke: item.stroke && { ...item.stroke, color: { ...item.stroke.color, a: item.stroke.color.a * opacity } },
  };
  // 渐变的透明度在色标上，也要一起乘
  if (folded.kind === 'path' && folded.gradient) folded.gradient = withAlpha(folded.gradient, opacity);
  return folded;
}

/** 解释一页的绘图指令，得到页面上的对象列表 */
export function interpretPage(list: PdfOperatorList, resources: PdfResources, viewport: PdfViewport): PdfPage {
  const interpreter = new Interpreter(resources, viewport);
  interpreter.run(list);
  return interpreter.finish();
}
