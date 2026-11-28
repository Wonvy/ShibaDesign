import { toCssColor } from './color';
import type { Color, GradientFill, GradientKind, GradientStop } from './model';
import type { Rect } from './rect';

/**
 * 渐变填充的辅助函数。
 *
 * 渐变的起点终点按节点外框的相对位置记（见 model.ts 的 GradientFill），
 * 画的时候换算成本地坐标：线性渐变的色带垂直于起止点连线，径向渐变是以起点为圆心、到终点的距离为半径的正圆。
 */

/** 一个渐变最多多少个色标 */
export const MAX_GRADIENT_STOPS = 256;

/** 渐变在本地坐标里的几何：线性是起点到终点，径向是圆心和半径 */
export function gradientGeometry(
  fill: Pick<GradientFill, 'start' | 'end'>,
  bounds: Rect,
): { x0: number; y0: number; x1: number; y1: number; radius: number } {
  const x0 = bounds.x + fill.start.x * bounds.w;
  const y0 = bounds.y + fill.start.y * bounds.h;
  const x1 = bounds.x + fill.end.x * bounds.w;
  const y1 = bounds.y + fill.end.y * bounds.h;
  return { x0, y0, x1, y1, radius: Math.hypot(x1 - x0, y1 - y0) };
}

/**
 * 椭圆径向渐变的变换（本地坐标里的 2×3 矩阵）：把以圆心为中心的正圆沿垂直于 end 方向压扁 aspect 倍。
 * 正圆时返回 null。渲染、导出 PDF 和 SVG 都把这个矩阵乘在正圆的径向渐变上
 */
export function radialEllipseMatrix(
  fill: Pick<GradientFill, 'kind' | 'start' | 'end' | 'aspect'>,
  bounds: Rect,
): [number, number, number, number, number, number] | null {
  const aspect = fill.aspect ?? 1;
  if (fill.kind !== 'radial' || !(aspect > 0) || Math.abs(aspect - 1) < 1e-6) return null;
  const g = gradientGeometry(fill, bounds);
  if (g.radius < 1e-9) return null;
  const cos = (g.x1 - g.x0) / g.radius;
  const sin = (g.y1 - g.y0) / g.radius;
  // 先转到 end 方向，纵向缩放，再转回来：R · S(1, aspect) · Rᵀ
  const a = cos * cos + aspect * sin * sin;
  const b = (1 - aspect) * cos * sin;
  const d = sin * sin + aspect * cos * cos;
  // 圆心保持不动
  return [a, b, b, d, g.x0 - a * g.x0 - b * g.y0, g.y0 - b * g.x0 - d * g.y0];
}

/**
 * 按角度摆线性渐变：角度从水平向右开始顺时针量（画布的 y 轴向下），0° 从左到右，90° 从上到下。
 * 角度按画面上看到的算（不是按外框的相对坐标），色带的长度正好让两头的色标落在外框的对角上，和 CSS 的线性渐变一样
 */
export function linearGradientPoints(
  angle: number,
  width: number,
  height: number,
): Pick<GradientFill, 'start' | 'end'> {
  const w = Math.max(width, 1e-6);
  const h = Math.max(height, 1e-6);
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const half = (w * Math.abs(dx) + h * Math.abs(dy)) / 2;
  const unit = (x: number, y: number) => ({ x: round(x / w), y: round(y / h) });
  return {
    start: unit(w / 2 - dx * half, h / 2 - dy * half),
    end: unit(w / 2 + dx * half, h / 2 + dy * half),
  };
}

/** 线性渐变在画面上的角度，和 linearGradientPoints 相反 */
export function linearGradientAngle(fill: Pick<GradientFill, 'start' | 'end'>, width: number, height: number): number {
  const dx = (fill.end.x - fill.start.x) * width;
  const dy = (fill.end.y - fill.start.y) * height;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return 0;
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return Math.round(((degrees % 360) + 360) % 360);
}

/** 径向渐变的默认摆法：圆心在中间，半径是外框宽度的一半 */
export const RADIAL_DEFAULT: Pick<GradientFill, 'start' | 'end'> = { start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 } };

/** 从一个颜色生成默认的渐变：这个颜色过渡到它的浅色（深色）版本 */
export function defaultGradient(color: Color, kind: GradientKind, width: number, height: number): GradientFill {
  const light = color.r * 0.3 + color.g * 0.59 + color.b * 0.11 > 0.6;
  const mix = (target: number, amount: number) => (c: number) => c + (target - c) * amount;
  const toward = light ? mix(0, 0.55) : mix(1, 0.6);
  const other: Color = { r: toward(color.r), g: toward(color.g), b: toward(color.b), a: color.a };
  return {
    type: 'gradient',
    kind,
    ...(kind === 'linear' ? linearGradientPoints(90, width, height) : RADIAL_DEFAULT),
    stops: [
      { offset: 0, color },
      { offset: 1, color: other },
    ],
  };
}

/** 整理色标：位置限制在 0 到 1、按位置排好；不够两个时补齐 */
export function normalizeStops(stops: readonly GradientStop[]): GradientStop[] {
  const out = stops
    .map((s) => ({ offset: Math.min(1, Math.max(0, s.offset)), color: s.color }))
    .sort((a, b) => a.offset - b.offset)
    .slice(0, MAX_GRADIENT_STOPS);
  if (out.length === 0) return [];
  if (out.length === 1) out.push({ offset: 1, color: out[0]!.color });
  return out;
}

/** 渐变在某个位置的颜色（颜色和透明度各自直线过渡） */
export function gradientColorAt(stops: readonly GradientStop[], t: number): Color {
  const first = stops[0];
  if (!first) return { r: 0, g: 0, b: 0, a: 0 };
  if (t <= first.offset) return first.color;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (t > b.offset) continue;
    const span = b.offset - a.offset;
    const k = span > 0 ? (t - a.offset) / span : 1;
    const lerp = (x: number, y: number) => x + (y - x) * k;
    return {
      r: lerp(a.color.r, b.color.r),
      g: lerp(a.color.g, b.color.g),
      b: lerp(a.color.b, b.color.b),
      a: lerp(a.color.a, b.color.a),
    };
  }
  return stops[stops.length - 1]!.color;
}

/** 渐变的平均色：只能用一种颜色的地方（缩略的色块、不支持渐变的格式）用它 */
export function gradientAverage(stops: readonly GradientStop[]): Color {
  const samples = 32;
  const sum = { r: 0, g: 0, b: 0, a: 0 };
  for (let i = 0; i < samples; i++) {
    const c = gradientColorAt(stops, (i + 0.5) / samples);
    sum.r += c.r;
    sum.g += c.g;
    sum.b += c.b;
    sum.a += c.a;
  }
  return { r: sum.r / samples, g: sum.g / samples, b: sum.b / samples, a: sum.a / samples };
}

/** 色标反过来：起点的颜色到终点去 */
export function reverseStops(stops: readonly GradientStop[]): GradientStop[] {
  return stops.map((s) => ({ offset: round(1 - s.offset), color: s.color })).reverse();
}

function round(value: number): number {
  // || 0 把 -0 变成 0
  return Math.round(value * 10_000) / 10_000 || 0;
}

/**
 * 渐变的 CSS 写法，用于网页里的幻灯片背景。位置都用百分比，和元素实际显示多大无关。
 * CSS 的线性渐变按角度摆、色带长度固定是对角线的投影，所以要把每个色标的位置换算到 CSS 的色带上
 */
export function gradientCss(fill: GradientFill, width: number, height: number): string {
  const stops = normalizeStops(fill.stops);
  if (stops.length === 0) return 'transparent';
  const w = Math.max(width, 1e-6);
  const h = Math.max(height, 1e-6);
  const g = gradientGeometry(fill, { x: 0, y: 0, w, h });
  const pct = (v: number) => `${round(v * 100)}%`;
  const last = stops[stops.length - 1]!.color;
  if (fill.kind === 'radial') {
    if (g.radius < 1e-6) return toCssColor(last);
    const list = stops.map((s) => `${toCssColor(s.color)} ${pct(s.offset)}`).join(', ');
    // CSS 的椭圆只能是横平竖直的：压扁的方向按 end 偏横还是偏竖近似
    const aspect = fill.aspect ?? 1;
    const horizontal = Math.abs(g.x1 - g.x0) >= Math.abs(g.y1 - g.y0);
    const rx = horizontal ? g.radius : g.radius * aspect;
    const ry = horizontal ? g.radius * aspect : g.radius;
    return `radial-gradient(${pct(rx / w)} ${pct(ry / h)} at ${pct(g.x0 / w)} ${pct(g.y0 / h)}, ${list})`;
  }
  const dx = g.x1 - g.x0;
  const dy = g.y1 - g.y0;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return toCssColor(last);
  const ux = dx / length;
  const uy = dy / length;
  // CSS 的角度从正上方开始顺时针量
  const angle = round((Math.atan2(ux, -uy) * 180) / Math.PI);
  const cssLength = Math.abs(w * ux) + Math.abs(h * uy);
  const list = stops
    .map((s) => {
      const px = g.x0 + dx * s.offset - w / 2;
      const py = g.y0 + dy * s.offset - h / 2;
      return `${toCssColor(s.color)} ${pct((px * ux + py * uy) / cssLength + 0.5)}`;
    })
    .join(', ');
  return `linear-gradient(${angle}deg, ${list})`;
}
