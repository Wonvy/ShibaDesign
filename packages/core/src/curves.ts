import type { CurvePoint, ImageCurves } from './model';

/**
 * 曲线：控制点之间用单调三次插值连起来（Fritsch–Carlson），曲线不会冲过相邻两个控制点的高度，
 * 拖一个点时别处不会意外鼓起来；第一个点左边、最后一个点右边是平的，和 Photoshop 一样。
 * 渲染时把曲线算成 256 格的查找表交给着色器，见渲染器的 image-look.ts。
 */

export const CURVE_CHANNELS = ['rgb', 'red', 'green', 'blue'] as const;
/** rgb 是总曲线，其余是单个通道的曲线 */
export type CurveChannel = (typeof CURVE_CHANNELS)[number];

/** 一条曲线最多几个控制点 */
export const MAX_CURVE_POINTS = 16;

/** 不变的直线 */
export const IDENTITY_CURVE: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * 整理控制点：坐标限制在 0–1，按 x 排好，x 几乎相同的只留后一个，最多 MAX_CURVE_POINTS 个。
 * 不是数的点丢掉；剩下不到两个点时返回 null
 */
export function normalizeCurve(points: readonly CurvePoint[] | undefined): CurvePoint[] | null {
  if (!points) return null;
  const sorted = points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const point of sorted) {
    const last = out[out.length - 1];
    if (last && point.x - last.x < 1e-4) out[out.length - 1] = point;
    else out.push(point);
  }
  return out.length >= 2 ? out.slice(0, MAX_CURVE_POINTS) : null;
}

/** 这条曲线是不是什么都不改：从 (0, 0) 到 (1, 1)，所有点都在对角线上。省略的曲线也算 */
export function isIdentityCurve(points: readonly CurvePoint[] | undefined): boolean {
  const curve = normalizeCurve(points);
  if (!curve) return true;
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (first.x > 1e-4 || last.x < 1 - 1e-4) return false;
  return curve.every((p) => Math.abs(p.x - p.y) < 1e-4);
}

/** 有没有哪条曲线在起作用 */
export function hasCurves(curves: ImageCurves | undefined): boolean {
  return !!curves && CURVE_CHANNELS.some((channel) => !isIdentityCurve(curves[channel]));
}

/** 曲线对应的函数：输入 0–1，输出 0–1。控制点不够两个时是不变的直线 */
export function curveFunction(points: readonly CurvePoint[] | undefined): (x: number) => number {
  const curve = normalizeCurve(points);
  if (!curve) return clamp01;
  const n = curve.length;
  const xs = curve.map((p) => p.x);
  const ys = curve.map((p) => p.y);
  // 相邻两点之间的斜率，再按 Fritsch–Carlson 算每个点的切线，保证每一段都是单调的
  const secants: number[] = [];
  for (let k = 0; k < n - 1; k++) secants.push((ys[k + 1]! - ys[k]!) / (xs[k + 1]! - xs[k]!));
  const tangents = new Array<number>(n).fill(0);
  tangents[0] = secants[0]!;
  tangents[n - 1] = secants[n - 2]!;
  for (let k = 1; k < n - 1; k++) {
    const a = secants[k - 1]!;
    const b = secants[k]!;
    tangents[k] = a * b <= 0 ? 0 : (a + b) / 2;
  }
  for (let k = 0; k < n - 1; k++) {
    const d = secants[k]!;
    if (d === 0) {
      tangents[k] = 0;
      tangents[k + 1] = 0;
      continue;
    }
    const a = tangents[k]! / d;
    const b = tangents[k + 1]! / d;
    const length = a * a + b * b;
    if (length > 9) {
      const t = 3 / Math.sqrt(length);
      tangents[k] = t * a * d;
      tangents[k + 1] = t * b * d;
    }
  }
  return (x: number): number => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]!) k++;
    const h = xs[k + 1]! - xs[k]!;
    const t = (x - xs[k]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * ys[k]! +
      (t3 - 2 * t2 + t) * h * tangents[k]! +
      (-2 * t3 + 3 * t2) * ys[k + 1]! +
      (t3 - t2) * h * tangents[k + 1]!;
    return clamp01(y);
  };
}

/** 曲线在 size 个等分点上的值（第 i 格的输入是 i / (size - 1)） */
export function curveTable(points: readonly CurvePoint[] | undefined, size = 256): Float32Array {
  const f = curveFunction(points);
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) table[i] = f(i / (size - 1));
  return table;
}

/**
 * 三个通道最终的查找表：先过通道自己的曲线，再过总曲线。每个通道 size 格。
 * 所有曲线都不起作用时返回 null
 */
export function channelTables(
  curves: ImageCurves | undefined,
  size = 256,
): { red: Float32Array; green: Float32Array; blue: Float32Array } | null {
  if (!hasCurves(curves)) return null;
  const master = curveFunction(curves!.rgb);
  const table = (channel: 'red' | 'green' | 'blue'): Float32Array => {
    const own = curveFunction(curves![channel]);
    const out = new Float32Array(size);
    for (let i = 0; i < size; i++) out[i] = master(own(i / (size - 1)));
    return out;
  };
  return { red: table('red'), green: table('green'), blue: table('blue') };
}

/**
 * 整理一组曲线，存进文档之前用：每条曲线整理好，不起作用的去掉；全都不起作用时返回 undefined（不存这个字段）
 */
export function normalizeCurves(curves: ImageCurves | undefined): ImageCurves | undefined {
  if (!curves) return undefined;
  const out: { -readonly [K in keyof ImageCurves]: ImageCurves[K] } = {};
  for (const channel of CURVE_CHANNELS) {
    if (isIdentityCurve(curves[channel])) continue;
    const curve = normalizeCurve(curves[channel]);
    if (curve) out[channel] = curve;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
