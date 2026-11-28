import type { Anchor, FrameNode, RectNode, SceneNode, Subpath } from './model';

/**
 * 顶点圆角：矩形四个角分别设半径、路径的尖角锚点带半径，三种样式（圆角、反向圆角、倒角），以及平滑度。
 *
 * 这里把"带圆角的折线"换成普通的贝塞尔锚点（圆弧用三次曲线近似，误差在万分之三以内）。
 * 渲染、命中、导出 PDF / SVG、轮廓化描边、布尔运算都用换出来的锚点，所以处处一致，不用各自处理。
 */

export const CORNER_STYLES = ['round', 'inverted', 'chamfer'] as const;
export type CornerStyle = (typeof CORNER_STYLES)[number];

export interface CornerOptions {
  /** 省略是圆角 */
  style?: CornerStyle;
  /** 平滑度 0 到 1：越大圆角往两边的直线上铺得越开，曲率变化越连续（像 iOS 图标）。省略是 0 */
  smoothing?: number;
}

interface Corner {
  x: number;
  y: number;
  radius: number;
}

interface Point {
  x: number;
  y: number;
}

/** 有四个角、可以分别圆角的盒子：矩形和画框（字段一样） */
export function hasBoxCorners(node: SceneNode | undefined | null): node is RectNode | FrameNode {
  return node?.type === 'rect' || node?.type === 'frame';
}

/** 矩形四个角的半径：左上、右上、右下、左下。没有分别设时四个角都是 cornerRadius */
export function rectCornerRadii(
  node: Pick<RectNode, 'cornerRadius' | 'cornerRadii'>,
): [number, number, number, number] {
  const r = node.cornerRadii;
  if (r) return [r[0], r[1], r[2], r[3]];
  return [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
}

/** 矩形需不需要按这里的算法生成轮廓（四个角一样的普通圆角用 Skia 自己的圆角矩形就行） */
export function rectNeedsCorners(
  node: Pick<RectNode, 'cornerRadius' | 'cornerRadii' | 'cornerStyle' | 'cornerSmoothing'>,
): boolean {
  const radii = rectCornerRadii(node);
  const uniform = radii.every((r) => r === radii[0]);
  const plain = (node.cornerStyle ?? 'round') === 'round' && !node.cornerSmoothing;
  return !uniform || (!plain && radii.some((r) => r > 0));
}

/** 矩形的轮廓：四个角各按自己的半径 */
export function rectOutline(w: number, h: number, radii: readonly number[], options: CornerOptions = {}): Subpath {
  return roundPolygon(
    [
      { x: 0, y: 0, radius: radii[0] ?? 0 },
      { x: w, y: 0, radius: radii[1] ?? 0 },
      { x: w, y: h, radius: radii[2] ?? 0 },
      { x: 0, y: h, radius: radii[3] ?? 0 },
    ],
    true,
    options,
  );
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const length = (a: Point): number => Math.hypot(a.x, a.y);
const unit = (a: Point): Point => {
  const l = length(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;

function anchor(p: Point, inHandle: Point = p, outHandle: Point = p): Anchor {
  return { x: p.x, y: p.y, inX: inHandle.x, inY: inHandle.y, outX: outHandle.x, outY: outHandle.y };
}

/**
 * 把一条折线（每个顶点带一个半径）换成贝塞尔锚点。
 * 每个角先按半径算出要占用两条边上多长（切点到顶点的距离）；相邻两个角加起来超过边长时按比例缩小，
 * 半径太大时就这样自动收小。开放的折线两头不圆
 */
export function roundPolygon(points: readonly Corner[], closed: boolean, options: CornerOptions = {}): Subpath {
  const n = points.length;
  const style = options.style ?? 'round';
  const smoothing = Math.max(0, Math.min(1, options.smoothing ?? 0));
  if (n < 2) return { closed, anchors: points.map((p) => anchor(p)) };

  const prev = (i: number): number => (i - 1 + n) % n;
  const next = (i: number): number => (i + 1) % n;
  const rounds = (i: number): boolean => (closed || (i > 0 && i < n - 1)) && points[i]!.radius > 0;

  // 每个角：两条边的方向、夹角、想占用的长度
  const info = points.map((p, i) => {
    if (!rounds(i)) return null;
    const u = unit(sub(points[prev(i)]!, p));
    const v = unit(sub(points[next(i)]!, p));
    const cos = Math.max(-1, Math.min(1, dot(u, v)));
    const angle = Math.acos(cos);
    // 几乎是直线（或者折回去）的角没法圆
    if (angle < 1e-3 || Math.PI - angle < 1e-3) return null;
    const half = angle / 2;
    // 圆角：切点到顶点的距离 = r / tan(θ/2)；反向圆角、倒角按半径直接量
    const tangent = style === 'round' ? p.radius / Math.tan(half) : p.radius;
    return { u, v, angle, half, want: tangent * (1 + smoothing) };
  });

  // 一条边两头的角加起来不能超过边长
  const scale = info.map(() => 1);
  const segments = closed ? n : n - 1;
  for (let s = 0; s < segments; s++) {
    const a = s;
    const b = next(s);
    const lengthAB = length(sub(points[b]!, points[a]!));
    const need = (info[a]?.want ?? 0) + (info[b]?.want ?? 0);
    if (need > lengthAB && need > 0) {
      const k = lengthAB / need;
      scale[a] = Math.min(scale[a]!, k);
      scale[b] = Math.min(scale[b]!, k);
    }
  }

  const anchors: Anchor[] = [];
  points.forEach((p, i) => {
    const corner = info[i];
    if (!corner) {
      anchors.push(anchor(p));
      return;
    }
    const { u, v, angle, half } = corner;
    const used = corner.want * scale[i]!;
    const t1 = add(p, u, used);
    const t2 = add(p, v, used);
    if (style === 'chamfer') {
      anchors.push(anchor(t1), anchor(t2));
      return;
    }
    if (style === 'inverted') {
      // 以顶点为圆心的圆弧，往里凹（平滑度不起作用）
      const sweep = angle;
      const k = (4 / 3) * Math.tan(sweep / 4) * used;
      const d1 = unit(sub(v, { x: u.x * dot(u, v), y: u.y * dot(u, v) }));
      const d2 = unit(sub(u, { x: v.x * dot(u, v), y: v.y * dot(u, v) }));
      anchors.push(anchor(t1, t1, add(t1, d1, k)), anchor(t2, add(t2, d2, k), t2));
      return;
    }
    // 圆角：圆弧扫过 π - θ，三次曲线的控制柄长度 (4/3)·tan(φ/4)·r；平滑度越大控制柄越往顶点靠。
    // 平滑度把切点往外推，真正的圆弧部分是 used / (1 + smoothing)
    const radius = (used / (1 + smoothing)) * Math.tan(half);
    const sweep = Math.PI - angle;
    const k = (4 / 3) * Math.tan(sweep / 4) * radius;
    const handle = k + smoothing * (used - k) * 0.6;
    anchors.push(anchor(t1, t1, add(t1, u, -handle)), anchor(t2, add(t2, v, -handle), t2));
  });
  return { closed, anchors };
}

/** 锚点是不是尖角：两根控制柄都和锚点重合 */
function isSharp(a: Anchor): boolean {
  return a.inX === a.x && a.inY === a.y && a.outX === a.x && a.outY === a.y;
}

/**
 * 一个锚点能不能加圆角：自己是尖角，两边的线段都是直线（前一个点的出控制柄、后一个点的入控制柄也和它们的锚点重合）。
 * 开放路径的两头不行。第一步只处理两边都是直线的角
 */
export function canRoundAnchor(sub: Subpath, index: number): boolean {
  const n = sub.anchors.length;
  if (n < 3 && sub.closed) return false;
  if (!sub.closed && (index === 0 || index === n - 1)) return false;
  const a = sub.anchors[index]!;
  const before = sub.anchors[(index - 1 + n) % n]!;
  const after = sub.anchors[(index + 1) % n]!;
  return (
    isSharp(a) && before.outX === before.x && before.outY === before.y && after.inX === after.x && after.inY === after.y
  );
}

/** 路径里有没有带圆角的锚点 */
export function hasRoundedAnchors(subpaths: readonly Subpath[]): boolean {
  return subpaths.some((s) => s.anchors.some((a) => (a.radius ?? 0) > 0));
}

/**
 * 路径的锚点圆角：连续的一段"两边都是直线的尖角"按半径圆掉，别的锚点原样保留。
 * 做法是把整条子路径拆成直线的折线段和曲线段，折线段交给 roundPolygon
 */
export function roundSubpaths(subpaths: readonly Subpath[], options: CornerOptions = {}): Subpath[] {
  return subpaths.map((s) => {
    if (!s.anchors.some((a) => (a.radius ?? 0) > 0)) return s;
    // 全是直线的闭合路径：整个交给 roundPolygon（最常见：多边形、星形、拼合出来的折线）
    const allStraight = s.anchors.every((_, i) => isSharp(s.anchors[i]!));
    if (allStraight) {
      return roundPolygon(
        s.anchors.map((a, i) => ({ x: a.x, y: a.y, radius: canRoundAnchor(s, i) ? (a.radius ?? 0) : 0 })),
        s.closed,
        options,
      );
    }
    // 有曲线的：每个能圆的锚点单独圆，切点长度受两边线段长度的一半限制
    const out: Anchor[] = [];
    const n = s.anchors.length;
    s.anchors.forEach((a, i) => {
      const radius = a.radius ?? 0;
      if (radius <= 0 || !canRoundAnchor(s, i)) {
        const { radius: _r, ...plain } = a;
        out.push(plain);
        return;
      }
      const before = s.anchors[(i - 1 + n) % n]!;
      const after = s.anchors[(i + 1) % n]!;
      const half = (p: Anchor): Point => ({ x: (p.x + a.x) / 2, y: (p.y + a.y) / 2 });
      const piece = roundPolygon(
        [
          { ...half(before), radius: 0 },
          { x: a.x, y: a.y, radius },
          { ...half(after), radius: 0 },
        ],
        false,
        options,
      );
      out.push(...piece.anchors.slice(1, -1));
    });
    return { closed: s.closed, anchors: out };
  });
}

/** 矩形一个角最大能有多大的半径（再大就被收小了），给画布上的控件和属性面板用 */
export function maxRectRadius(w: number, h: number): number {
  return Math.max(0, Math.min(w, h) / 2);
}
