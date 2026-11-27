import { applyToPoint } from './matrix';
import type { Matrix } from './model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 由任意两个对角点得到一个宽高非负的矩形 */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 变换后的外接矩形 */
export function transformRect(m: Matrix, r: Rect): Rect {
  const p0 = applyToPoint(m, r.x, r.y);
  const p1 = applyToPoint(m, r.x + r.w, r.y);
  const p2 = applyToPoint(m, r.x + r.w, r.y + r.h);
  const p3 = applyToPoint(m, r.x, r.y + r.h);
  const minX = Math.min(p0[0], p1[0], p2[0], p3[0]);
  const minY = Math.min(p0[1], p1[1], p2[1], p3[1]);
  const maxX = Math.max(p0[0], p1[0], p2[0], p3[0]);
  const maxY = Math.max(p0[1], p1[1], p2[1], p3[1]);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function rectContainsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
