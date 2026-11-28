import type { Anchor, Subpath } from './model';
import type { Point } from './rect';

/**
 * 动作路径的几何：对象沿一条贝塞尔路径移动。路径用钢笔路径的锚点模型（一个子路径），
 * 坐标是幻灯片坐标里相对对象中心的位移，起点通常就是 (0, 0)。
 *
 * 播放时把路径按弧长等分取点，排成一串 translate 关键帧：每一小段走的距离一样，速度就是匀的，
 * 再由整条动画的缓动决定起步和停下的快慢。用 translate 而不是 CSS 的 offset-path，
 * 是因为导出视频时按计算出来的样式逐帧读画面，translate 一定读得到。
 */

/** 每段曲线拆成多少小段来量长度 */
const FLATTEN = 32;
/** 关键帧最少、最多几个点 */
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 240;
/** 大约每隔多远（幻灯片坐标）取一个点 */
const SAMPLE_SPACING = 6;

/** 路径的每一段：从一个锚点到下一个锚点（闭合时还有最后一段回到起点） */
function segments(path: Subpath): [Anchor, Anchor][] {
  const anchors = path.anchors;
  const out: [Anchor, Anchor][] = [];
  for (let i = 1; i < anchors.length; i++) out.push([anchors[i - 1]!, anchors[i]!]);
  if (path.closed && anchors.length > 1) out.push([anchors[anchors.length - 1]!, anchors[0]!]);
  return out;
}

function cubic(a: Anchor, b: Anchor, t: number): Point {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * a.x + w1 * a.outX + w2 * b.inX + w3 * b.x,
    y: w0 * a.y + w1 * a.outY + w2 * b.inY + w3 * b.y,
  };
}

/** 把路径拆成折线：依次的点，以及从起点量过来的长度 */
function flatten(path: Subpath): { points: Point[]; lengths: number[] } {
  const first = path.anchors[0];
  if (!first) return { points: [], lengths: [] };
  const points: Point[] = [{ x: first.x, y: first.y }];
  const lengths = [0];
  for (const [a, b] of segments(path)) {
    for (let k = 1; k <= FLATTEN; k++) {
      const p = cubic(a, b, k / FLATTEN);
      const last = points[points.length - 1]!;
      points.push(p);
      lengths.push(lengths[lengths.length - 1]! + Math.hypot(p.x - last.x, p.y - last.y));
    }
  }
  return { points, lengths };
}

/** 路径的总长度 */
export function motionPathLength(path: Subpath): number {
  const { lengths } = flatten(path);
  return lengths[lengths.length - 1] ?? 0;
}

/** 路径的起点和终点（闭合路径的终点就是起点）。没有锚点时都是原点 */
export function motionPathEnds(path: Subpath | undefined): { start: Point; end: Point } {
  const first = path?.anchors[0];
  const last = path?.anchors[path.anchors.length - 1];
  if (!path || !first || !last) return { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } };
  const start = { x: first.x, y: first.y };
  return { start, end: path.closed ? start : { x: last.x, y: last.y } };
}

/**
 * 沿路径按弧长等分取点，包括起点和终点。count 不给时按长度定（大约每 6 个单位一个点，8 到 240 个）。
 * 路径没有长度时只有起点
 */
export function sampleMotionPath(path: Subpath, count?: number): Point[] {
  const { points, lengths } = flatten(path);
  const total = lengths[lengths.length - 1] ?? 0;
  if (points.length === 0) return [];
  if (total <= 1e-9) return [points[0]!];
  const n = count ?? Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(total / SAMPLE_SPACING)));
  const out: Point[] = [];
  let k = 1;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (k < lengths.length - 1 && lengths[k]! < target) k++;
    const l0 = lengths[k - 1]!;
    const l1 = lengths[k]!;
    const t = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
    const a = points[k - 1]!;
    const b = points[k]!;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/** 把路径整体平移 */
export function offsetMotionPath(path: Subpath, dx: number, dy: number): Subpath {
  return {
    closed: path.closed,
    anchors: path.anchors.map((a) => ({
      x: a.x + dx,
      y: a.y + dy,
      inX: a.inX + dx,
      inY: a.inY + dy,
      outX: a.outX + dx,
      outY: a.outY + dy,
    })),
  };
}

/** 反过来走：锚点倒序，每个锚点的两根控制柄对调 */
export function reverseMotionPath(path: Subpath): Subpath {
  const anchors = [...path.anchors]
    .reverse()
    .map((a) => ({ ...a, inX: a.outX, inY: a.outY, outX: a.inX, outY: a.inY }));
  return { closed: path.closed, anchors };
}

const corner = (x: number, y: number): Anchor => ({ x, y, inX: x, inY: y, outX: x, outY: y });

/** 圆弧用三次曲线近似时控制柄的长度（四分之一圆，半径为 1） */
const KAPPA = 0.5522847498;

/** 几种预设路径，按幻灯片大小定尺寸。都从 (0, 0)——对象中心——出发 */
export const MOTION_PRESETS = {
  /** 向右的直线，幻灯片宽度的四分之一 */
  line(slide: { width: number; height: number }): Subpath {
    return { closed: false, anchors: [corner(0, 0), corner(slide.width / 4, 0)] };
  },
  /** 向右的弧线，往下鼓 */
  arc(slide: { width: number; height: number }): Subpath {
    const w = slide.width / 4;
    const h = slide.height / 6;
    return {
      closed: false,
      anchors: [
        { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: h * 0.75 },
        { x: w / 2, y: h, inX: w * 0.2, inY: h, outX: w * 0.8, outY: h },
        { x: w, y: 0, inX: w, inY: h * 0.75, outX: w, outY: 0 },
      ],
    };
  },
  /** 绕一圈回到原处：圆心在对象下方，顺时针 */
  circle(slide: { width: number; height: number }): Subpath {
    const r = Math.min(slide.width, slide.height) / 8;
    const k = r * KAPPA;
    return {
      closed: true,
      anchors: [
        { x: 0, y: 0, inX: -k, inY: 0, outX: k, outY: 0 },
        { x: r, y: r, inX: r, inY: r - k, outX: r, outY: r + k },
        { x: 0, y: 2 * r, inX: k, inY: 2 * r, outX: -k, outY: 2 * r },
        { x: -r, y: r, inX: -r, inY: r + k, outX: -r, outY: r - k },
      ],
    };
  },
};
