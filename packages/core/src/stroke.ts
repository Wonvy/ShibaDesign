import type { Stroke } from './model';

/**
 * 描边的端点、拐角和虚线。
 * 这几项都是可选的：省略时是平头端点、尖角拐角、实线，和 Skia、PDF、SVG 的默认值一样（尖角的斜接限制是 4）。
 */

export const STROKE_CAPS = ['butt', 'round', 'square'] as const;
/** 线段两端：butt 平头（到端点为止）、round 圆头、square 方头（伸出半个线宽） */
export type StrokeCap = (typeof STROKE_CAPS)[number];

export const STROKE_JOINS = ['miter', 'round', 'bevel'] as const;
/** 拐角：miter 尖角、round 圆角、bevel 斜角 */
export type StrokeJoin = (typeof STROKE_JOINS)[number];

/** 一个虚线最多几段 */
export const MAX_DASH_SEGMENTS = 16;

/**
 * 实际要画的虚线：实线段和空白交替的长度，个数总是偶数（奇数个时重复一遍，和 SVG、PDF 的规定一样）。
 * 是实线时返回 null：没有设虚线、长度全是 0、有负数或者不是数
 */
export function dashPattern(stroke: Pick<Stroke, 'dash'>): number[] | null {
  const dash = stroke.dash;
  if (!dash || dash.length === 0) return null;
  if (dash.some((v) => !Number.isFinite(v) || v < 0)) return null;
  if (dash.every((v) => v === 0)) return null;
  return dash.length % 2 === 1 ? [...dash, ...dash] : [...dash];
}

/**
 * 常用的几种虚线，按线宽算出来：虚线是 4 倍线宽的实线段、2 倍线宽的空白；
 * 点线是长度为 0 的实线段配圆头端点，空白 2 倍线宽，画出来是一串圆点
 */
export function dashPreset(kind: 'solid' | 'dashed' | 'dotted', width: number): Pick<Stroke, 'dash' | 'cap'> {
  const w = Math.max(width, 0.5);
  if (kind === 'dashed') return { dash: [4 * w, 2 * w], cap: 'butt' };
  if (kind === 'dotted') return { dash: [0, 2 * w], cap: 'round' };
  return { dash: undefined, cap: undefined };
}

/** 描边是哪一种预设（用来在面板上标出当前选的是哪个）；自己设的间隔返回 custom */
export function dashKind(stroke: Stroke): 'solid' | 'dashed' | 'dotted' | 'custom' {
  const dash = dashPattern(stroke);
  if (!dash) return 'solid';
  const w = Math.max(stroke.width, 0.5);
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  if (dash.length === 2 && close(dash[0]!, 4 * w) && close(dash[1]!, 2 * w)) return 'dashed';
  if (dash.length === 2 && close(dash[0]!, 0) && close(dash[1]!, 2 * w) && stroke.cap === 'round') return 'dotted';
  return 'custom';
}

export const ARROW_HEADS = ['arrow', 'triangle', 'circle', 'square', 'bar'] as const;
/**
 * 开放路径两头的箭头：arrow 开口的箭头（两条线）、triangle 实心三角、circle 圆点、square 方块、bar 一道横杠。
 * 都按描边的颜色画，大小跟着线宽
 */
export type ArrowHead = (typeof ARROW_HEADS)[number];

/** 箭头的大小：从端点往回量的长度、半宽，以及线要缩回去多少（免得平头的线从实心箭头的尖上露出来） */
export function arrowMetrics(head: ArrowHead, width: number): { length: number; half: number; trim: number } {
  const w = Math.max(0.5, width);
  const length = w * 4 + 4;
  const half = length * 0.55;
  switch (head) {
    case 'triangle':
      return { length, half, trim: length * 0.6 };
    case 'circle': {
      const r = w * 1.6 + 1.5;
      return { length: r, half: r, trim: r * 0.5 };
    }
    case 'square': {
      const s = w * 1.4 + 1;
      return { length: s, half: s, trim: s * 0.5 };
    }
    default:
      return { length, half, trim: 0 };
  }
}
