import type { Anchor, Stroke, Subpath } from './model';
import type { Point } from './rect';
import { arrowMetrics, type ArrowHead } from './stroke';

/**
 * 开放路径两头的箭头：算出每个箭头的尖在哪、朝哪个方向，以及缩短过的线（实心箭头下面的线缩回去一点，
 * 免得平头的线从箭头的尖两边露出来）。纯几何，三个渲染后端按它画
 */

export interface ArrowPlacement {
  head: ArrowHead;
  /** 箭头的尖（路径的端点） */
  tip: Point;
  /** 朝外的方向（单位向量） */
  dir: Point;
  width: number;
}

const unit = (x: number, y: number): Point => {
  const l = Math.hypot(x, y);
  return l > 1e-12 ? { x: x / l, y: y / l } : { x: 1, y: 0 };
};

function cubicAt(a: Anchor, b: Anchor, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * a.outX + 3 * u * t * t * b.inX + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * a.outY + 3 * u * t * t * b.inY + t * t * t * b.y,
  };
}

/** 从 b 往回量 distance 的地方在这段曲线上的参数（按 64 段折线近似弧长） */
function paramFromEnd(a: Anchor, b: Anchor, distance: number): number {
  const steps = 64;
  let travelled = 0;
  let previous = cubicAt(a, b, 1);
  for (let i = steps - 1; i >= 0; i--) {
    const t = i / steps;
    const p = cubicAt(a, b, t);
    const step = Math.hypot(p.x - previous.x, p.y - previous.y);
    if (travelled + step >= distance) return t + ((travelled + step - distance) / (step || 1)) * (1 / steps);
    travelled += step;
    previous = p;
  }
  return 0;
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** 把 a→b 这段曲线在 t 处拆开，返回前半段的两个锚点（b 换成拆开的点） */
function keepStart(a: Anchor, b: Anchor, t: number): [Anchor, Anchor] {
  const p1 = { x: a.outX, y: a.outY };
  const p2 = { x: b.inX, y: b.inY };
  const q0 = lerp(a, p1, t);
  const q1 = lerp(p1, p2, t);
  const q2 = lerp(p2, b, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const m = lerp(r0, r1, t);
  return [
    { ...a, outX: q0.x, outY: q0.y },
    { ...b, x: m.x, y: m.y, inX: r0.x, inY: r0.y, outX: m.x, outY: m.y },
  ];
}

/** 反过来：一段曲线倒着走（起点终点、控制柄互换） */
function reverse(a: Anchor): Anchor {
  return { ...a, inX: a.outX, inY: a.outY, outX: a.inX, outY: a.inY };
}

/** 端点 b（从 a 过来）的朝外方向：b 的入控制柄、a 的出控制柄、a 本身，取第一个和 b 不重合的 */
function endDirection(a: Anchor, b: Anchor): Point {
  if (b.inX !== b.x || b.inY !== b.y) return unit(b.x - b.inX, b.y - b.inY);
  if (a.outX !== b.x || a.outY !== b.y) return unit(b.x - a.outX, b.y - a.outY);
  return unit(b.x - a.x, b.y - a.y);
}

/** 箭头的位置和缩短过的线；描边上没有箭头、或者没有开放的子路径时返回 null */
export function arrowGeometry(
  subpaths: readonly Subpath[],
  stroke: Pick<Stroke, 'width' | 'arrowStart' | 'arrowEnd'>,
): { line: Subpath[]; arrows: ArrowPlacement[] } | null {
  if (!stroke.arrowStart && !stroke.arrowEnd) return null;
  const arrows: ArrowPlacement[] = [];
  let any = false;
  const line = subpaths.map((sub) => {
    const n = sub.anchors.length;
    if (sub.closed || n < 2) return sub;
    any = true;
    const anchors = [...sub.anchors];
    if (stroke.arrowEnd) {
      const a = anchors[n - 2]!;
      const b = anchors[n - 1]!;
      arrows.push({ head: stroke.arrowEnd, tip: { x: b.x, y: b.y }, dir: endDirection(a, b), width: stroke.width });
      const { trim } = arrowMetrics(stroke.arrowEnd, stroke.width);
      if (trim > 0) [anchors[n - 2], anchors[n - 1]] = keepStart(a, b, paramFromEnd(a, b, trim));
    }
    if (stroke.arrowStart) {
      // 起点：把第一段倒过来当成"终点"处理
      const a = reverse(anchors[1]!);
      const b = reverse(anchors[0]!);
      arrows.push({ head: stroke.arrowStart, tip: { x: b.x, y: b.y }, dir: endDirection(a, b), width: stroke.width });
      const { trim } = arrowMetrics(stroke.arrowStart, stroke.width);
      if (trim > 0) {
        const [na, nb] = keepStart(a, b, paramFromEnd(a, b, trim));
        anchors[1] = reverse(na);
        anchors[0] = reverse(nb);
      }
    }
    return { closed: false, anchors };
  });
  return any ? { line, arrows } : null;
}
