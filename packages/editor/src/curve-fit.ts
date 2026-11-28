import type { Anchor, Point } from '@shiba/core';

/**
 * 把手画的一串点拟合成几段三次贝塞尔曲线（Philip Schneider 的算法，《Graphics Gems》1990）：
 * 先用一段曲线去拟合，误差超过 maxError 就在误差最大的点那里拆成两半分别拟合，拆开处的切线连续，曲线是平滑的。
 * 先去掉挨得太近的点，再用 Douglas–Peucker 粗简化一遍，点少了拟合快、曲线也干净
 */

type Vec = Point;

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const length = (a: Vec): number => Math.hypot(a.x, a.y);
const normalize = (a: Vec): Vec => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : { x: 0, y: 0 };
};

type Bezier = [Vec, Vec, Vec, Vec];

function bezierAt(b: Bezier, t: number): Vec {
  const u = 1 - t;
  return add(
    add(scale(b[0], u * u * u), scale(b[1], 3 * u * u * t)),
    add(scale(b[2], 3 * u * t * t), scale(b[3], t * t * t)),
  );
}

function bezierPrime(b: Bezier, t: number): Vec {
  const u = 1 - t;
  return add(
    add(scale(sub(b[1], b[0]), 3 * u * u), scale(sub(b[2], b[1]), 6 * u * t)),
    scale(sub(b[3], b[2]), 3 * t * t),
  );
}

function bezierPrime2(b: Bezier, t: number): Vec {
  return add(
    scale(add(sub(b[2], scale(b[1], 2)), b[0]), 6 * (1 - t)),
    scale(add(sub(b[3], scale(b[2], 2)), b[1]), 6 * t),
  );
}

/** 按弧长给每个点一个参数 0 到 1 */
function chordParams(points: readonly Vec[]): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i++) u.push(u[i - 1]! + length(sub(points[i]!, points[i - 1]!)));
  const total = u[u.length - 1]! || 1;
  return u.map((v) => v / total);
}

/** 给定两端的切线方向，用最小二乘求两个控制点 */
function generate(points: readonly Vec[], params: readonly number[], tan1: Vec, tan2: Vec): Bezier {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  params.forEach((t, i) => {
    const u = 1 - t;
    const a1 = scale(tan1, 3 * u * u * t);
    const a2 = scale(tan2, 3 * u * t * t);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(points[i]!, bezierAt([first, first, last, last], t));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  });
  const det = c00 * c11 - c01 * c01;
  let alpha1 = Math.abs(det) > 1e-12 ? (x0 * c11 - x1 * c01) / det : 0;
  let alpha2 = Math.abs(det) > 1e-12 ? (c00 * x1 - c01 * x0) / det : 0;
  const segLength = length(sub(last, first));
  const epsilon = 1e-6 * segLength;
  // 解出来不合理（负的或者太小）时退回经验值：两端各取三分之一长度
  if (alpha1 < epsilon || alpha2 < epsilon) {
    alpha1 = segLength / 3;
    alpha2 = segLength / 3;
  }
  return [first, add(first, scale(tan1, alpha1)), add(last, scale(tan2, alpha2)), last];
}

/** 牛顿迭代改进每个点的参数，让它更靠近曲线上离它最近的点 */
function reparameterize(b: Bezier, points: readonly Vec[], params: readonly number[]): number[] {
  return params.map((t, i) => {
    const d = sub(bezierAt(b, t), points[i]!);
    const p1 = bezierPrime(b, t);
    const p2 = bezierPrime2(b, t);
    const denominator = dot(p1, p1) + dot(d, p2);
    if (Math.abs(denominator) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - dot(d, p1) / denominator));
  });
}

function maxError(b: Bezier, points: readonly Vec[], params: readonly number[]): { error: number; index: number } {
  let error = 0;
  let index = Math.floor(points.length / 2);
  params.forEach((t, i) => {
    const d = length(sub(bezierAt(b, t), points[i]!)) ** 2;
    if (d > error) {
      error = d;
      index = i;
    }
  });
  return { error, index };
}

function fitCubic(points: readonly Vec[], tan1: Vec, tan2: Vec, error: number, out: Bezier[], depth = 0): void {
  if (points.length === 2) {
    const d = length(sub(points[1]!, points[0]!)) / 3;
    out.push([points[0]!, add(points[0]!, scale(tan1, d)), add(points[1]!, scale(tan2, d)), points[1]!]);
    return;
  }
  let params = chordParams(points);
  let bezier = generate(points, params, tan1, tan2);
  let { error: worst, index } = maxError(bezier, points, params);
  if (worst < error * error) {
    out.push(bezier);
    return;
  }
  // 误差不太大时先试着改进参数
  if (worst < error * error * 4) {
    for (let i = 0; i < 6; i++) {
      params = reparameterize(bezier, points, params);
      bezier = generate(points, params, tan1, tan2);
      ({ error: worst, index } = maxError(bezier, points, params));
      if (worst < error * error) {
        out.push(bezier);
        return;
      }
    }
  }
  if (depth > 24) {
    out.push(bezier);
    return;
  }
  // 在误差最大的点拆开，那里的切线取前后两点连线的方向
  const split = Math.max(1, Math.min(points.length - 2, index));
  const center = normalize(sub(points[split - 1]!, points[split + 1]!));
  fitCubic(points.slice(0, split + 1), tan1, center, error, out, depth + 1);
  fitCubic(points.slice(split), scale(center, -1), tan2, error, out, depth + 1);
}

/** Douglas–Peucker：去掉离折线很近的点 */
function simplify(points: readonly Vec[], tolerance: number): Vec[] {
  if (points.length < 3) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const pa = points[a]!;
    const pb = points[b]!;
    const ab = sub(pb, pa);
    const len = length(ab);
    let worst = 0;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      // 两头重合（画了一圈回到起点）时没有直线可量，改量到端点的距离
      const d =
        len > 1e-9
          ? Math.abs((points[i]!.x - pa.x) * ab.y - (points[i]!.y - pa.y) * ab.x) / len
          : length(sub(points[i]!, pa));
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = true;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * 手画的点 → 钢笔路径的锚点。tolerance 是允许偏离多远（同一个单位），通常是屏幕上两三个像素换算过来的。
 * closed 时把首尾连起来，最后一个锚点和第一个重合，接口两边的切线是同一个方向（接得平滑）。
 * 少于两个不重复的点时返回空数组
 */
export function fitCurve(raw: readonly Point[], tolerance: number, closed = false): Anchor[] {
  const points: Vec[] = [];
  for (const p of raw) {
    const last = points[points.length - 1];
    if (!last || length(sub(p, last)) > tolerance * 0.25) points.push({ x: p.x, y: p.y });
  }
  if (points.length < 2) return [];
  if (closed) points.push({ ...points[0]! });
  const simplified = simplify(points, tolerance * 0.5);
  const curves: Bezier[] = [];
  const n = simplified.length;
  let tan1 = normalize(sub(simplified[1]!, simplified[0]!));
  let tan2 = normalize(sub(simplified[n - 2]!, simplified[n - 1]!));
  if (closed && n > 3) {
    tan1 = normalize(sub(simplified[1]!, simplified[n - 2]!));
    tan2 = scale(tan1, -1);
  }
  fitCubic(simplified, tan1, tan2, tolerance, curves);
  const anchors: Anchor[] = [];
  curves.forEach((c, i) => {
    if (i === 0) anchors.push({ x: c[0].x, y: c[0].y, inX: c[0].x, inY: c[0].y, outX: c[1].x, outY: c[1].y });
    else anchors[anchors.length - 1] = { ...anchors[anchors.length - 1]!, outX: c[1].x, outY: c[1].y };
    anchors.push({ x: c[3].x, y: c[3].y, inX: c[2].x, inY: c[2].y, outX: c[3].x, outY: c[3].y });
  });
  return anchors;
}
