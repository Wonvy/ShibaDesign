import { multiply, translation, type Anchor, type Matrix, type PathNode, type Point, type Subpath } from '@shiba/core';
import { buildPath } from '@shiba/renderer';
import type { Editor } from './editor';

/**
 * 改钢笔路径的锚点：挪锚点和控制柄、在线段上加锚点、删锚点、尖角和平滑互相切换。
 * 坐标都是路径节点的本地坐标。改完用 normalizePath 把节点的外框重新对齐到路径的实际范围
 */

/** 锚点的键："子路径:锚点" */
export function anchorKey(sub: number, index: number): string {
  return `${sub}:${index}`;
}

export function parseKey(key: string): [number, number] {
  const [s, i] = key.split(':').map(Number);
  return [s ?? 0, i ?? 0];
}

/** 三次曲线上 t 处的点 */
function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** 一条子路径有几段线段（闭合的最后一个锚点连回第一个） */
function segmentCount(sub: Subpath): number {
  return sub.closed ? sub.anchors.length : sub.anchors.length - 1;
}

/** 离这一点最近的线段，在 tolerance 以内时返回它和曲线参数 t */
export function segmentAt(
  subpaths: readonly Subpath[],
  point: Point,
  tolerance: number,
): { sub: number; index: number; t: number } | null {
  let best: { sub: number; index: number; t: number; distance: number } | null = null;
  subpaths.forEach((sub, s) => {
    const n = sub.anchors.length;
    for (let i = 0; i < segmentCount(sub); i++) {
      const a = sub.anchors[i]!;
      const b = sub.anchors[(i + 1) % n]!;
      const steps = 40;
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const p = cubicAt(a, { x: a.outX, y: a.outY }, { x: b.inX, y: b.inY }, b, t);
        const distance = Math.hypot(p.x - point.x, p.y - point.y);
        if (distance <= tolerance && (!best || distance < best.distance)) best = { sub: s, index: i, t, distance };
      }
    }
  });
  if (!best) return null;
  const { sub, index, t } = best;
  return { sub, index, t };
}

/** 在第 index 段的 t 处加一个锚点（de Casteljau 把曲线拆成两段，形状不变） */
export function splitSegment(subpaths: readonly Subpath[], sub: number, index: number, t: number): Subpath[] {
  return subpaths.map((s, si) => {
    if (si !== sub) return s;
    const n = s.anchors.length;
    const a = s.anchors[index]!;
    const b = s.anchors[(index + 1) % n]!;
    const p0 = { x: a.x, y: a.y };
    const p1 = { x: a.outX, y: a.outY };
    const p2 = { x: b.inX, y: b.inY };
    const p3 = { x: b.x, y: b.y };
    const q0 = lerp(p0, p1, t);
    const q1 = lerp(p1, p2, t);
    const q2 = lerp(p2, p3, t);
    const r0 = lerp(q0, q1, t);
    const r1 = lerp(q1, q2, t);
    const m = lerp(r0, r1, t);
    const anchors = [...s.anchors];
    anchors[index] = { ...a, outX: q0.x, outY: q0.y };
    const bIndex = (index + 1) % n;
    anchors[bIndex] = { ...b, inX: q2.x, inY: q2.y };
    const inserted: Anchor = { x: m.x, y: m.y, inX: r0.x, inY: r0.y, outX: r1.x, outY: r1.y };
    anchors.splice(index + 1, 0, inserted);
    return { closed: s.closed, anchors };
  });
}

/** 删掉一些锚点，路径保持连着；剩不到两个锚点的子路径去掉 */
export function deleteAnchors(subpaths: readonly Subpath[], keys: ReadonlySet<string>): Subpath[] {
  return subpaths
    .map((s, si) => ({ closed: s.closed, anchors: s.anchors.filter((_, i) => !keys.has(anchorKey(si, i))) }))
    .filter((s) => s.anchors.length >= 2);
}

/** 锚点是平滑的（有控制柄） */
export function isSmooth(a: Anchor): boolean {
  return a.inX !== a.x || a.inY !== a.y || a.outX !== a.x || a.outY !== a.y;
}

/**
 * 尖角和平滑互相切换：平滑的去掉两根控制柄；尖角的按前后两个锚点的方向拉出一对对称的控制柄，
 * 长度是到前后锚点距离的三分之一
 */
export function toggleSmooth(subpaths: readonly Subpath[], key: string): Subpath[] {
  const [sub, index] = parseKey(key);
  return subpaths.map((s, si) => {
    if (si !== sub) return s;
    const n = s.anchors.length;
    const a = s.anchors[index]!;
    const anchors = [...s.anchors];
    if (isSmooth(a)) {
      anchors[index] = { ...a, inX: a.x, inY: a.y, outX: a.x, outY: a.y };
    } else {
      const before = s.anchors[(index - 1 + n) % n]!;
      const after = s.anchors[(index + 1) % n]!;
      const hasBefore = s.closed || index > 0;
      const hasAfter = s.closed || index < n - 1;
      const dx = (hasAfter ? after.x : a.x) - (hasBefore ? before.x : a.x);
      const dy = (hasAfter ? after.y : a.y) - (hasBefore ? before.y : a.y);
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const inLength = hasBefore ? Math.hypot(a.x - before.x, a.y - before.y) / 3 : 0;
      const outLength = hasAfter ? Math.hypot(after.x - a.x, after.y - a.y) / 3 : 0;
      const { radius: _r, ...plain } = a;
      anchors[index] = {
        ...plain,
        inX: a.x - ux * inLength,
        inY: a.y - uy * inLength,
        outX: a.x + ux * outLength,
        outY: a.y + uy * outLength,
      };
    }
    return { closed: s.closed, anchors };
  });
}

/** 挪一些锚点（连同它们的控制柄） */
export function moveAnchors(
  subpaths: readonly Subpath[],
  keys: ReadonlySet<string>,
  dx: number,
  dy: number,
): Subpath[] {
  return subpaths.map((s, si) => ({
    closed: s.closed,
    anchors: s.anchors.map((a, i) =>
      keys.has(anchorKey(si, i))
        ? { ...a, x: a.x + dx, y: a.y + dy, inX: a.inX + dx, inY: a.inY + dy, outX: a.outX + dx, outY: a.outY + dy }
        : a,
    ),
  }));
}

/**
 * 拖一根控制柄。另一根原来和它在一条直线上（平滑锚点）时跟着反向转，长度不变；
 * 按着 Alt（breakSymmetry）只动这一根
 */
export function moveHandle(
  subpaths: readonly Subpath[],
  key: string,
  which: 'in' | 'out',
  to: Point,
  breakSymmetry: boolean,
): Subpath[] {
  const [sub, index] = parseKey(key);
  return subpaths.map((s, si) => {
    if (si !== sub) return s;
    const a = s.anchors[index]!;
    const other = which === 'in' ? { x: a.outX, y: a.outY } : { x: a.inX, y: a.inY };
    const moved = which === 'in' ? { x: a.inX, y: a.inY } : { x: a.outX, y: a.outY };
    // 原来的两根控制柄共线（方向相反）就算平滑，要跟着转
    const v1 = { x: moved.x - a.x, y: moved.y - a.y };
    const v2 = { x: other.x - a.x, y: other.y - a.y };
    const cross = v1.x * v2.y - v1.y * v2.x;
    const collinear =
      Math.hypot(v2.x, v2.y) > 1e-9 &&
      Math.abs(cross) < 1e-6 * (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1) &&
      v1.x * v2.x + v1.y * v2.y < 0;
    let next: Anchor = which === 'in' ? { ...a, inX: to.x, inY: to.y } : { ...a, outX: to.x, outY: to.y };
    if (!breakSymmetry && (collinear || Math.hypot(v2.x, v2.y) < 1e-9)) {
      const dx = to.x - a.x;
      const dy = to.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const keep = Math.hypot(v2.x, v2.y) < 1e-9 ? length : Math.hypot(v2.x, v2.y);
      const mirror = { x: a.x - (dx / length) * keep, y: a.y - (dy / length) * keep };
      next = which === 'in' ? { ...next, outX: mirror.x, outY: mirror.y } : { ...next, inX: mirror.x, inY: mirror.y };
    }
    const anchors = [...s.anchors];
    anchors[index] = next;
    return { closed: s.closed, anchors };
  });
}

/**
 * 把节点的外框重新对齐到路径的实际范围：锚点平移到以外框左上角为原点，变换矩阵相应地挪一下，
 * 路径在画布上的位置不变（和钢笔画完时的做法一样）
 */
export function normalizePath(
  editor: Editor,
  node: PathNode,
  subpaths: readonly Subpath[],
): { subpaths: Subpath[]; transform: Matrix; size: readonly [number, number] } {
  const probe = buildPath(editor.ck, subpaths, node.fillRule);
  const [x0, y0, x1, y1] = probe.computeTightBounds();
  probe.delete();
  const ox = Number.isFinite(x0) ? x0! : 0;
  const oy = Number.isFinite(y0) ? y0! : 0;
  const shifted = subpaths.map((s) => ({
    closed: s.closed,
    anchors: s.anchors.map((a) => ({
      ...a,
      x: a.x - ox,
      y: a.y - oy,
      inX: a.inX - ox,
      inY: a.inY - oy,
      outX: a.outX - ox,
      outY: a.outY - oy,
    })),
  }));
  return {
    subpaths: shifted,
    transform: multiply(node.transform, translation(ox, oy)),
    size: [Math.max(0, (x1 ?? 0) - ox), Math.max(0, (y1 ?? 0) - oy)],
  };
}
