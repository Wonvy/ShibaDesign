import type { Point, Rect } from '@shiba/core';

/**
 * 吸附：拖动、缩放、画形状时，让边、中线对齐到附近的对象、画板和辅助线，间距对齐到已有的间距。
 * 全是纯函数，坐标是世界坐标。候选在按下鼠标时收集好、排好序，拖动中每一帧只做二分查找，
 * 一万个对象时也不卡（见 snap.test.ts 的性能测试）。
 */

/** 一条可以吸附过去的线：竖线（axis 'x'，在 x = value 处）或横线（axis 'y'） */
interface Edge {
  value: number;
  /** 这条线属于哪个范围（画参考线时从移动的对象画到它） */
  rect: Rect | null;
}

export interface SnapTargets {
  /** 竖线，按 value 排好序 */
  xs: Edge[];
  /** 横线，按 value 排好序 */
  ys: Edge[];
  /** 参与等间距的对象的外框 */
  boxes: Rect[];
}

/** 画出来的参考线（世界坐标）：竖线 x = at，从 from 到 to；横线 y = at */
export interface GuideLine {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

/** 等间距的标记：一段间距（世界坐标），在中间画一个数字 */
export interface SpacingMark {
  axis: 'x' | 'y';
  /** 间距的起止（axis 'x' 时是 x 方向） */
  start: number;
  end: number;
  /** 画在另一个方向的哪个位置 */
  at: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  lines: GuideLine[];
  spacing: SpacingMark[];
}

export interface TargetSource {
  /** 对象的外框（世界坐标） */
  rects: readonly Rect[];
  /** 画板的外框：边和中线都能吸 */
  boards?: readonly Rect[];
  /** 辅助线：竖线的 x、横线的 y；range 是它画在哪个范围里（画板辅助线），页面辅助线为 null */
  guides?: readonly { axis: 'x' | 'y'; value: number; range: Rect | null }[];
}

/** 收集候选：每个对象、画板的左中右、上中下，以及辅助线 */
export function buildTargets(source: TargetSource): SnapTargets {
  const xs: Edge[] = [];
  const ys: Edge[] = [];
  const add = (rect: Rect): void => {
    xs.push({ value: rect.x, rect }, { value: rect.x + rect.w / 2, rect }, { value: rect.x + rect.w, rect });
    ys.push({ value: rect.y, rect }, { value: rect.y + rect.h / 2, rect }, { value: rect.y + rect.h, rect });
  };
  source.rects.forEach(add);
  source.boards?.forEach(add);
  for (const guide of source.guides ?? []) {
    (guide.axis === 'x' ? xs : ys).push({ value: guide.value, rect: guide.range });
  }
  xs.sort((a, b) => a.value - b.value);
  ys.sort((a, b) => a.value - b.value);
  return { xs, ys, boxes: [...source.rects] };
}

/** 有序数组里离 value 最近的那个（二分查找）；没有时 null */
function nearest(edges: readonly Edge[], value: number): Edge | null {
  if (edges.length === 0) return null;
  let lo = 0;
  let hi = edges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid]!.value < value) lo = mid + 1;
    else hi = mid;
  }
  const after = edges[lo]!;
  const before = lo > 0 ? edges[lo - 1]! : null;
  return before && Math.abs(before.value - value) <= Math.abs(after.value - value) ? before : after;
}

/** value 处所有的候选（画参考线时要把对齐到同一条线上的都画出来） */
function edgesAt(edges: readonly Edge[], value: number): Edge[] {
  const out: Edge[] = [];
  for (const edge of edges) {
    if (Math.abs(edge.value - value) < 0.01) out.push(edge);
    else if (edge.value > value + 0.01) break;
  }
  return out;
}

interface AxisHit {
  /** 要挪多少才对上 */
  delta: number;
  /** 对上的那条线 */
  value: number;
  /** 来自等间距 */
  spacing: SpacingMark[] | null;
}

/** 一个方向上：几条要对齐的线（移动对象的左中右）里，哪条离候选最近、在阈值以内 */
function snapAxis(edges: readonly Edge[], values: readonly number[], threshold: number): AxisHit | null {
  let best: AxisHit | null = null;
  for (const value of values) {
    const edge = nearest(edges, value);
    if (!edge) continue;
    const delta = edge.value - value;
    if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
      best = { delta, value: edge.value, spacing: null };
    }
  }
  return best;
}

/**
 * 等间距：在 axis 方向上，和移动的对象在另一个方向上有重叠的那些对象里，找左右（上下）的邻居，
 * 让两边的间距相等，或者等于邻居和它下一个邻居之间已有的间距。返回候选的位置（移动对象的左边 / 上边）
 */
function spacingCandidates(
  boxes: readonly Rect[],
  box: Rect,
  axis: 'x' | 'y',
): { start: number; marks: SpacingMark[] }[] {
  const lo = (r: Rect): number => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect): number => (axis === 'x' ? r.w : r.h);
  const hi = (r: Rect): number => lo(r) + size(r);
  const crossLo = (r: Rect): number => (axis === 'x' ? r.y : r.x);
  const crossHi = (r: Rect): number => crossLo(r) + (axis === 'x' ? r.h : r.w);
  const overlaps = (r: Rect): boolean => crossLo(r) < crossHi(box) && crossHi(r) > crossLo(box);
  const row = boxes.filter(overlaps);
  const center = lo(box) + size(box) / 2;
  const before = row.filter((r) => hi(r) <= center).sort((a, b) => hi(b) - hi(a));
  const after = row.filter((r) => lo(r) >= center).sort((a, b) => lo(a) - lo(b));
  const at = (a: Rect, b: Rect): number => (Math.max(crossLo(a), crossLo(b)) + Math.min(crossHi(a), crossHi(b))) / 2;
  const out: { start: number; marks: SpacingMark[] }[] = [];
  const left = before[0];
  const right = after[0];
  if (left && right) {
    // 放在两个邻居正中间
    const gap = (lo(right) - hi(left) - size(box)) / 2;
    if (gap > 0) {
      const start = hi(left) + gap;
      out.push({
        start,
        marks: [
          { axis, start: hi(left), end: start, at: at(left, box) },
          { axis, start: start + size(box), end: lo(right), at: at(right, box) },
        ],
      });
    }
  }
  if (left && before[1]) {
    // 接着左边已有的间距往右排
    const gap = lo(left) - hi(before[1]);
    if (gap > 0) {
      const start = hi(left) + gap;
      out.push({
        start,
        marks: [
          { axis, start: hi(before[1]), end: lo(left), at: at(before[1], left) },
          { axis, start: hi(left), end: start, at: at(left, box) },
        ],
      });
    }
  }
  if (right && after[1]) {
    const gap = lo(after[1]) - hi(right);
    if (gap > 0) {
      const start = lo(right) - gap - size(box);
      out.push({
        start,
        marks: [
          { axis, start: start + size(box), end: lo(right), at: at(right, box) },
          { axis, start: hi(right), end: lo(after[1]), at: at(right, after[1]) },
        ],
      });
    }
  }
  return out;
}

function snapSpacing(boxes: readonly Rect[], box: Rect, axis: 'x' | 'y', threshold: number): AxisHit | null {
  const current = axis === 'x' ? box.x : box.y;
  let best: AxisHit | null = null;
  for (const candidate of spacingCandidates(boxes, box, axis)) {
    const delta = candidate.start - current;
    if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
      best = { delta, value: candidate.start, spacing: candidate.marks };
    }
  }
  return best;
}

/** 画参考线：从移动的对象延伸到所有对齐在这条线上的东西 */
function linesFor(targets: SnapTargets, axis: 'x' | 'y', value: number, moved: Rect): GuideLine {
  const edges = edgesAt(axis === 'x' ? targets.xs : targets.ys, value);
  let from = axis === 'x' ? moved.y : moved.x;
  let to = axis === 'x' ? moved.y + moved.h : moved.x + moved.w;
  for (const edge of edges) {
    if (!edge.rect) continue;
    const a = axis === 'x' ? edge.rect.y : edge.rect.x;
    const b = axis === 'x' ? edge.rect.y + edge.rect.h : edge.rect.x + edge.rect.w;
    from = Math.min(from, a);
    to = Math.max(to, b);
  }
  return { axis, at: value, from, to };
}

export interface SnapOptions {
  /** 吸附距离，世界单位（屏幕上 5 像素按缩放换算） */
  threshold: number;
  /** 哪个方向可以吸（按着 Shift 锁定在水平方向时只吸 x） */
  axes?: { x: boolean; y: boolean };
  /** 吸到对象和辅助线以后，结果取整到像素 */
  pixels?: boolean;
}

/** 移动：box 是挪了 (dx, dy) 之后的外框。返回修正后的位移和要画的参考线 */
export function snapMove(targets: SnapTargets, box: Rect, options: SnapOptions): SnapResult {
  const axes = options.axes ?? { x: true, y: true };
  const t = options.threshold;
  const xHit = axes.x
    ? pickBetter(
        snapAxis(targets.xs, [box.x, box.x + box.w / 2, box.x + box.w], t),
        snapSpacing(targets.boxes, box, 'x', t),
      )
    : null;
  const yHit = axes.y
    ? pickBetter(
        snapAxis(targets.ys, [box.y, box.y + box.h / 2, box.y + box.h], t),
        snapSpacing(targets.boxes, box, 'y', t),
      )
    : null;
  let dx = xHit?.delta ?? 0;
  let dy = yHit?.delta ?? 0;
  if (options.pixels) {
    if (!xHit && axes.x) dx = Math.round(box.x) - box.x;
    if (!yHit && axes.y) dy = Math.round(box.y) - box.y;
  }
  const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const lines: GuideLine[] = [];
  const spacing: SpacingMark[] = [];
  if (xHit?.spacing) spacing.push(...xHit.spacing.map((m) => shiftMark(m, 0, dy)));
  else if (xHit) lines.push(linesFor(targets, 'x', xHit.value, moved));
  if (yHit?.spacing) spacing.push(...yHit.spacing.map((m) => shiftMark(m, dx, 0)));
  else if (yHit) lines.push(linesFor(targets, 'y', yHit.value, moved));
  return { dx, dy, lines, spacing };
}

function shiftMark(mark: SpacingMark, dx: number, dy: number): SpacingMark {
  return { ...mark, at: mark.at + (mark.axis === 'x' ? dy : dx) };
}

function pickBetter(a: AxisHit | null, b: AxisHit | null): AxisHit | null {
  if (!a) return b;
  if (!b) return a;
  return Math.abs(b.delta) < Math.abs(a.delta) ? b : a;
}

/**
 * 吸一个点（缩放时拖动的那条边、画形状时的鼠标、钢笔放的点）：x、y 各自对齐到最近的候选线。
 * axes 说明哪个方向在动（拖右边的控制柄时只吸 x）
 */
export function snapPoint(
  targets: SnapTargets,
  point: Point,
  options: SnapOptions,
): { point: Point; lines: GuideLine[] } {
  const axes = options.axes ?? { x: true, y: true };
  const t = options.threshold;
  const xHit = axes.x ? snapAxis(targets.xs, [point.x], t) : null;
  const yHit = axes.y ? snapAxis(targets.ys, [point.y], t) : null;
  let x = point.x + (xHit?.delta ?? 0);
  let y = point.y + (yHit?.delta ?? 0);
  if (options.pixels) {
    if (!xHit && axes.x) x = Math.round(x);
    if (!yHit && axes.y) y = Math.round(y);
  }
  const dot = { x, y, w: 0, h: 0 };
  const lines: GuideLine[] = [];
  if (xHit) lines.push(linesFor(targets, 'x', xHit.value, dot));
  if (yHit) lines.push(linesFor(targets, 'y', yHit.value, dot));
  return { point: { x, y }, lines };
}

/**
 * 两个外框之间要标的距离（按住 Alt 测距用）：a 是选中的，b 是鼠标停着的。
 * 不相交时标出两个方向上的间隔；a 在 b 里面时标出 a 到 b 四条边的距离
 */
export function measureBetween(a: Rect, b: Rect): SpacingMark[] {
  const out: SpacingMark[] = [];
  const midY = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2;
  const midX = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
  const aCenter = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const inside = a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  if (inside) {
    out.push({ axis: 'x', start: b.x, end: a.x, at: aCenter.y });
    out.push({ axis: 'x', start: a.x + a.w, end: b.x + b.w, at: aCenter.y });
    out.push({ axis: 'y', start: b.y, end: a.y, at: aCenter.x });
    out.push({ axis: 'y', start: a.y + a.h, end: b.y + b.h, at: aCenter.x });
    return out.filter((m) => m.end - m.start > 0.01);
  }
  const yOverlap = a.y < b.y + b.h && a.y + a.h > b.y;
  const xOverlap = a.x < b.x + b.w && a.x + a.w > b.x;
  if (a.x + a.w <= b.x) out.push({ axis: 'x', start: a.x + a.w, end: b.x, at: yOverlap ? midY : aCenter.y });
  else if (b.x + b.w <= a.x) out.push({ axis: 'x', start: b.x + b.w, end: a.x, at: yOverlap ? midY : aCenter.y });
  if (a.y + a.h <= b.y) out.push({ axis: 'y', start: a.y + a.h, end: b.y, at: xOverlap ? midX : aCenter.x });
  else if (b.y + b.h <= a.y) out.push({ axis: 'y', start: b.y + b.h, end: a.y, at: xOverlap ? midX : aCenter.x });
  return out;
}
