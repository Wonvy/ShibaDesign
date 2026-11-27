import type { Anchor, Matrix, Subpath } from '@shiba/core';
import { CLOSE, CUBIC, LINE, MOVE, QUAD, type Box, type PathData } from './ir';

/** 路径数据相关的几何计算：变换、包围盒、识别矩形和椭圆、转成锚点 */

/** 每条命令后面跟几个坐标值 */
const ARITY = [2, 2, 6, 4, 0];

/** 把一段路径数据变换后追加到 out 里 */
export function appendTransformed(out: PathData, data: ArrayLike<number>, m: Matrix): void {
  const [a, b, c, d, e, f] = m;
  for (let i = 0; i < data.length;) {
    const command = data[i++]!;
    const count = ARITY[command];
    if (count === undefined) return; // 不认识的命令：后面的数据没法解读，到此为止
    out.push(command);
    for (let k = 0; k < count; k += 2) {
      const x = data[i++]!;
      const y = data[i++]!;
      out.push(a * x + c * y + e, b * x + d * y + f);
    }
  }
}

export function transformPath(data: ArrayLike<number>, m: Matrix): PathData {
  const out: PathData = [];
  appendTransformed(out, data, m);
  return out;
}

/** 所有点（含控制点）的包围盒。比曲线的真实边界略大，但算得快，用来做粗略判断 */
export function controlBounds(data: ArrayLike<number>): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < data.length;) {
    const count = ARITY[data[i++]!];
    if (count === undefined) break;
    for (let k = 0; k < count; k += 2) {
      const x = data[i++]!;
      const y = data[i++]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x0 <= x1 && y0 <= y1 ? { x0, y0, x1, y1 } : null;
}

export function intersectBoxes(a: Box, b: Box): Box {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
}

export function isEmptyBox(box: Box): boolean {
  return box.x1 <= box.x0 || box.y1 <= box.y0;
}

/** a 是否完全包住 b，允许一点误差 */
export function boxContains(a: Box, b: Box, tolerance: number): boolean {
  return b.x0 >= a.x0 - tolerance && b.y0 >= a.y0 - tolerance && b.x1 <= a.x1 + tolerance && b.y1 <= a.y1 + tolerance;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** 矩阵对长度的平均缩放倍数，用来换算线宽 */
export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

// ───────────── 识别矩形 ─────────────

export interface RectFrame {
  /** 把本地的 [0, width] × [0, height] 放到页面上的变换，不含缩放和翻转 */
  transform: Matrix;
  width: number;
  height: number;
  /** 没有旋转 */
  axisAligned: boolean;
}

/**
 * 如果路径只有一个由四条直线围成的子路径，返回它的四个顶点。
 * closed 表示路径自己闭合了（有闭合命令，或者最后一个点回到了起点）。
 */
function singleQuad(data: ArrayLike<number>): { points: [number, number][]; closed: boolean } | null {
  const points: [number, number][] = [];
  let closed = false;
  for (let i = 0; i < data.length;) {
    const command = data[i++]!;
    if (command === MOVE) {
      // 第二个子路径：只允许是末尾一个什么都没画的"移动"
      if (points.length > 0) return i + 2 >= data.length ? finishQuad(points, closed) : null;
      points.push([data[i++]!, data[i++]!]);
    } else if (command === LINE) {
      if (closed || points.length === 0) return null;
      points.push([data[i++]!, data[i++]!]);
    } else if (command === CLOSE) {
      closed = true;
    } else {
      return null;
    }
  }
  return finishQuad(points, closed);
}

function finishQuad(
  points: [number, number][],
  closed: boolean,
): { points: [number, number][]; closed: boolean } | null {
  if (points.length === 5) {
    const [first, last] = [points[0]!, points[4]!];
    const size = Math.max(Math.abs(points[2]![0] - first[0]), Math.abs(points[2]![1] - first[1]), 1e-6);
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) > size * 1e-4) return null;
    points = points.slice(0, 4);
    closed = true;
  }
  return points.length === 4 ? { points, closed } : null;
}

/**
 * 路径是不是一个矩形（可以是旋转过的）。是的话返回它的位置、大小和朝向。
 * requireClosed 为 true 时，没有闭合的四边形不算——描边时少一条边，看起来不是矩形。
 */
export function asRectangle(data: ArrayLike<number>, requireClosed: boolean): RectFrame | null {
  const quad = singleQuad(data);
  if (!quad || (requireClosed && !quad.closed)) return null;
  const p = quad.points;
  const e0x = p[1]![0] - p[0]![0];
  const e0y = p[1]![1] - p[0]![1];
  const e1x = p[2]![0] - p[1]![0];
  const e1y = p[2]![1] - p[1]![1];
  const l0 = Math.hypot(e0x, e0y);
  const l1 = Math.hypot(e1x, e1y);
  if (l0 < 1e-6 || l1 < 1e-6) return null;
  const tolerance = Math.max(l0, l1) * 1e-4;
  // 第四个点必须在平行四边形的位置上，并且相邻两边垂直
  if (Math.hypot(p[3]![0] - (p[0]![0] + e1x), p[3]![1] - (p[0]![1] + e1y)) > tolerance) return null;
  if (Math.abs(e0x * e1x + e0y * e1y) > l0 * l1 * 1e-4) return null;

  // 四个顶点、两种绕向一共八种放法，选不翻转、旋转角最小的那一种，这样没旋转的矩形得到的就是纯平移
  let best: RectFrame | null = null;
  let bestAngle = Infinity;
  for (let i = 0; i < 4; i++) {
    for (const step of [1, 3]) {
      const origin = p[i]!;
      const ax = p[(i + step) % 4]![0] - origin[0];
      const ay = p[(i + step) % 4]![1] - origin[1];
      const bx = p[(i + 4 - step) % 4]![0] - origin[0];
      const by = p[(i + 4 - step) % 4]![1] - origin[1];
      if (ax * by - ay * bx <= 0) continue;
      const angle = Math.abs(Math.atan2(ay, ax));
      if (angle >= bestAngle) continue;
      const width = Math.hypot(ax, ay);
      const height = Math.hypot(bx, by);
      const axisAligned = Math.abs(ay) <= width * 1e-4 && Math.abs(bx) <= height * 1e-4;
      bestAngle = angle;
      best = {
        transform: axisAligned
          ? [1, 0, 0, 1, origin[0], origin[1]]
          : [ax / width, ay / width, bx / height, by / height, origin[0], origin[1]],
        width,
        height,
        axisAligned,
      };
    }
  }
  return best;
}

/** 路径正好是一个没有旋转的矩形时，返回这个矩形 */
export function asAxisRect(data: ArrayLike<number>): Box | null {
  const frame = asRectangle(data, false);
  if (!frame?.axisAligned) return null;
  const [, , , , x, y] = frame.transform;
  return { x0: x, y0: y, x1: x + frame.width, y1: y + frame.height };
}

// ───────────── 转成锚点 ─────────────

const corner = (x: number, y: number): Anchor => ({ x, y, inX: x, inY: y, outX: x, outY: y });

/** 把路径数据转成文档模型的子路径。二次曲线升成三次曲线，只有一个点的子路径丢弃 */
export function toSubpaths(data: ArrayLike<number>): Subpath[] {
  const result: Subpath[] = [];
  let anchors: Anchor[] = [];
  let closed = false;
  let startX = 0;
  let startY = 0;

  const flush = (): void => {
    if (closed && anchors.length > 1) {
      // 最后一个点回到起点时，把它和起点合成一个锚点，否则闭合处会多出一条零长度的边
      const first = anchors[0]!;
      const last = anchors[anchors.length - 1]!;
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
        anchors[0] = { ...first, inX: last.inX, inY: last.inY };
        anchors.pop();
      }
    }
    if (anchors.length > 1) result.push({ closed, anchors });
    anchors = [];
    closed = false;
  };
  /** 闭合之后接着画，是从这个子路径的起点重新开始 */
  const resume = (): void => {
    if (closed || anchors.length === 0) {
      flush();
      anchors.push(corner(startX, startY));
    }
  };

  for (let i = 0; i < data.length;) {
    const command = data[i++]!;
    if (command === MOVE) {
      flush();
      startX = data[i++]!;
      startY = data[i++]!;
      anchors.push(corner(startX, startY));
    } else if (command === LINE) {
      resume();
      anchors.push(corner(data[i++]!, data[i++]!));
    } else if (command === CUBIC) {
      resume();
      const previous = anchors[anchors.length - 1]!;
      anchors[anchors.length - 1] = { ...previous, outX: data[i++]!, outY: data[i++]! };
      const inX = data[i++]!;
      const inY = data[i++]!;
      const x = data[i++]!;
      const y = data[i++]!;
      anchors.push({ x, y, inX, inY, outX: x, outY: y });
    } else if (command === QUAD) {
      resume();
      const previous = anchors[anchors.length - 1]!;
      const cx = data[i++]!;
      const cy = data[i++]!;
      const x = data[i++]!;
      const y = data[i++]!;
      anchors[anchors.length - 1] = {
        ...previous,
        outX: previous.x + ((cx - previous.x) * 2) / 3,
        outY: previous.y + ((cy - previous.y) * 2) / 3,
      };
      anchors.push({ x, y, inX: x + ((cx - x) * 2) / 3, inY: y + ((cy - y) * 2) / 3, outX: x, outY: y });
    } else if (command === CLOSE) {
      if (anchors.length > 0) closed = true;
    } else {
      break;
    }
  }
  flush();
  return result;
}

/** 一条三次曲线在一个坐标轴上的取值范围 */
function cubicExtent(p0: number, p1: number, p2: number, p3: number, range: [number, number]): void {
  const include = (v: number): void => {
    if (v < range[0]) range[0] = v;
    if (v > range[1]) range[1] = v;
  };
  include(p0);
  include(p3);
  // 导数 3(a·t² + b·t + c) 的根就是极值点
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const at = (t: number): void => {
    if (t <= 0 || t >= 1) return;
    const u = 1 - t;
    include(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3);
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) at(-c / b);
    return;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return;
  const root = Math.sqrt(discriminant);
  at((-b + root) / (2 * a));
  at((-b - root) / (2 * a));
}

/** 曲线的真实边界（不含控制点），和渲染器算出的紧致边界一致 */
export function tightBounds(subpaths: readonly Subpath[]): Box | null {
  const xs: [number, number] = [Infinity, -Infinity];
  const ys: [number, number] = [Infinity, -Infinity];
  for (const sub of subpaths) {
    const count = sub.anchors.length;
    const segments = sub.closed ? count : count - 1;
    for (let i = 0; i < segments; i++) {
      const from = sub.anchors[i]!;
      const to = sub.anchors[(i + 1) % count]!;
      cubicExtent(from.x, from.outX, to.inX, to.x, xs);
      cubicExtent(from.y, from.outY, to.inY, to.y, ys);
    }
  }
  return xs[0] <= xs[1] && ys[0] <= ys[1] ? { x0: xs[0], y0: ys[0], x1: xs[1], y1: ys[1] } : null;
}

/** 平移并四舍五入到千分之一。导入的文档不需要更高的精度，少写很多小数位能让文件小一截 */
export function shiftSubpaths(subpaths: readonly Subpath[], dx: number, dy: number): Subpath[] {
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return subpaths.map((sub) => ({
    closed: sub.closed,
    anchors: sub.anchors.map((a) => ({
      x: r(a.x + dx),
      y: r(a.y + dy),
      inX: r(a.inX + dx),
      inY: r(a.inY + dy),
      outX: r(a.outX + dx),
      outY: r(a.outY + dy),
    })),
  }));
}

// ───────────── 识别椭圆和圆角矩形 ─────────────

/**
 * 沿着一个闭合子路径取一圈采样点：每段曲线取起点和中间三个点。
 * 识别形状时不看路径是怎么构造的（各家软件画圆用的段数、控制柄都不一样），只看这些点落在哪里。
 */
function sampleOutline(sub: Subpath): [number, number][] {
  const points: [number, number][] = [];
  const count = sub.anchors.length;
  for (let i = 0; i < count; i++) {
    const from = sub.anchors[i]!;
    const to = sub.anchors[(i + 1) % count]!;
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      points.push([
        a * from.x + b * from.outX + c * to.inX + d * to.x,
        a * from.y + b * from.outY + c * to.inY + d * to.y,
      ]);
    }
  }
  return points;
}

/** 这一圈点是不是正好绕着中心转了一圈（而不是来回折返，或者绕了好几圈） */
function windsOnce(points: readonly [number, number][], cx: number, cy: number): boolean {
  let total = 0;
  let previous = Math.atan2(points[0]![1] - cy, points[0]![0] - cx);
  for (let i = 1; i <= points.length; i++) {
    const p = points[i % points.length]!;
    const angle = Math.atan2(p[1] - cy, p[0] - cx);
    let delta = angle - previous;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    total += delta;
    previous = angle;
  }
  return Math.abs(Math.abs(total) - 2 * Math.PI) < 0.1;
}

function singleClosed(subpaths: readonly Subpath[]): { sub: Subpath; box: Box } | null {
  if (subpaths.length !== 1) return null;
  const sub = subpaths[0]!;
  if (!sub.closed || sub.anchors.length < 3) return null;
  const box = tightBounds(subpaths);
  return box && box.x1 - box.x0 > 1e-6 && box.y1 - box.y0 > 1e-6 ? { sub, box } : null;
}

/** 路径是不是一个没有旋转的椭圆：轮廓上的点到中心的（归一化）距离都是 1 */
export function asEllipse(subpaths: readonly Subpath[]): Box | null {
  const found = singleClosed(subpaths);
  if (!found) return null;
  const { sub, box } = found;
  const rx = (box.x1 - box.x0) / 2;
  const ry = (box.y1 - box.y0) / 2;
  const cx = box.x0 + rx;
  const cy = box.y0 + ry;
  const points = sampleOutline(sub);
  for (const [x, y] of points) {
    if (Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) > 0.01) return null;
  }
  return windsOnce(points, cx, cy) ? box : null;
}

/**
 * 路径是不是一个没有旋转、四个角半径相同的圆角矩形。是的话返回它的范围和圆角半径。
 * 直角矩形不在这里处理（asRectangle 更严格，也能认出旋转过的）。
 */
export function asRoundedRect(subpaths: readonly Subpath[]): { box: Box; radius: number } | null {
  const found = singleClosed(subpaths);
  if (!found) return null;
  const { sub, box } = found;
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  const tolerance = Math.max(0.01, Math.min(width, height) * 0.005);

  // 圆角半径：贴着上边的锚点里最靠左的那个，离左上角有多远
  let radius = Infinity;
  for (const a of sub.anchors) {
    if (Math.abs(a.y - box.y0) <= tolerance) radius = Math.min(radius, a.x - box.x0);
  }
  if (!(radius > tolerance) || radius > Math.min(width, height) / 2 + tolerance) return null;
  radius = Math.min(radius, width / 2, height / 2);

  const cx = box.x0 + width / 2;
  const cy = box.y0 + height / 2;
  const points = sampleOutline(sub);
  for (const [x, y] of points) {
    // 点到圆角矩形轮廓的有符号距离
    const qx = Math.abs(x - cx) - (width / 2 - radius);
    const qy = Math.abs(y - cy) - (height / 2 - radius);
    const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    if (Math.abs(distance) > tolerance) return null;
  }
  return windsOnce(points, cx, cy) ? { box, radius } : null;
}
