import {
  DEFAULT_CONSTRAINTS,
  applyToPoint,
  around,
  constrainAxis,
  descendants,
  invert,
  multiply,
  parentWorldTransform,
  rotation,
  scaling,
  transformRect,
  translation,
  unionRects,
  type DocStore,
  type Matrix,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
  type TextNode,
  type Transaction,
} from '@shiba/core';

/**
 * 缩放、旋转、翻转的几何运算。都在调用方的事务里执行。
 *
 * 缩放和旋转在拖动过程中每一帧都从"拖动开始时记下的原始状态"重新计算，
 * 而不是在上一帧的结果上累加，这样不会积累误差，拖回原处就是原样。
 */

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type Handle = (typeof HANDLES)[number];

const MIN_SIZE = 1;

/**
 * 画框、画板改大小时里面的东西怎么办：
 * constraints 按各自的约束跟着变（默认靠左靠上，也就是不动）；
 * fixed 都不动（拖控制柄时按住 ⌘）；
 * scale 像编组一样整体按比例缩放（等比缩放工具 K）
 */
export type ContentMode = 'constraints' | 'fixed' | 'scale';

/** 控制柄在外接矩形上的位置，结果是 0–1 的比例 */
export function handleAnchor(handle: Handle): Point {
  return {
    x: handle.includes('w') ? 0 : handle.includes('e') ? 1 : 0.5,
    y: handle.includes('n') ? 0 : handle.includes('s') ? 1 : 0.5,
  };
}

/**
 * 控制柄对应的鼠标指针。
 * @param frameAngle 选区框的旋转角（弧度）：框转了，指针的方向也要跟着转
 */
export function handleCursor(handle: Handle, frameAngle = 0): string {
  const anchor = handleAnchor(handle);
  const direction = Math.atan2(anchor.y - 0.5, anchor.x - 0.5) + frameAngle;
  // 指针只有四种方向，每种覆盖 45°，而且正反方向用同一个
  const step = Math.round(direction / (Math.PI / 4));
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][((step % 4) + 4) % 4]!;
}

/** 拖动某个控制柄到 pointer 后的新矩形。不允许翻转，最小 1 像素 */
export function resizeBounds(
  start: Rect,
  handle: Handle,
  pointer: Point,
  keepAspect: boolean,
  fromCenter = false,
): Rect {
  if (fromCenter) return resizeFromCenter(start, handle, pointer, keepAspect);
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes('w')) left = Math.min(pointer.x, right - MIN_SIZE);
  if (handle.includes('e')) right = Math.max(pointer.x, left + MIN_SIZE);
  if (handle.includes('n')) top = Math.min(pointer.y, bottom - MIN_SIZE);
  if (handle.includes('s')) bottom = Math.max(pointer.y, top + MIN_SIZE);

  if (keepAspect && handle.length === 2 && start.w > 0 && start.h > 0) {
    const scale = Math.max((right - left) / start.w, (bottom - top) / start.h);
    const w = start.w * scale;
    const h = start.h * scale;
    if (handle.includes('w')) left = right - w;
    else right = left + w;
    if (handle.includes('n')) top = bottom - h;
    else bottom = top + h;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 按住 Alt 缩放：中心不动，拖动的边和对边一起往外或往里 */
function resizeFromCenter(start: Rect, handle: Handle, pointer: Point, keepAspect: boolean): Rect {
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  let halfW = start.w / 2;
  let halfH = start.h / 2;
  if (handle.includes('e')) halfW = Math.max(MIN_SIZE / 2, pointer.x - cx);
  if (handle.includes('w')) halfW = Math.max(MIN_SIZE / 2, cx - pointer.x);
  if (handle.includes('s')) halfH = Math.max(MIN_SIZE / 2, pointer.y - cy);
  if (handle.includes('n')) halfH = Math.max(MIN_SIZE / 2, cy - pointer.y);
  if (keepAspect && handle.length === 2 && start.w > 0 && start.h > 0) {
    const scale = Math.max(halfW / (start.w / 2), halfH / (start.h / 2));
    halfW = (start.w / 2) * scale;
    halfH = (start.h / 2) * scale;
  }
  return { x: cx - halfW, y: cy - halfH, w: halfW * 2, h: halfH * 2 };
}

/**
 * 变换开始时记下的原始状态：选中的节点，以及编组、布尔组、画框、画板内部的所有后代
 * （画框和画板改大小时里面的东西按约束跟着变，也要从原样算）。
 * 自动宽度的文本在文档里不存宽度，所以要靠 textWidth 把排版出来的实际宽度补上。
 */
export function captureOriginals(
  store: DocStore,
  ids: readonly NodeId[],
  textWidth?: (node: TextNode) => number,
): Map<NodeId, SceneNode> {
  const out = new Map<NodeId, SceneNode>();
  const add = (node: SceneNode): void => {
    out.set(node.id, node.type === 'text' && textWidth ? { ...node, size: [textWidth(node), node.size[1]] } : node);
  };
  for (const id of ids) {
    const node = store.get(id);
    if (!node) continue;
    add(node);
    const container =
      node.type === 'group' || node.type === 'boolean' || node.type === 'frame' || node.type === 'artboard';
    if (container) descendants(store, id).forEach(add);
  }
  return out;
}

/**
 * 在节点自己的坐标系里缩放：把它的本地包围盒从 oldBox 变成 newBox。
 * 用于单个对象的控制柄——对象转过角度之后，控制柄也是斜的，拖动是沿对象自己的方向进行的。
 * 对任意旋转角度都是精确的：没被拖动的那一侧在画布上纹丝不动。
 */
export function resizeLocal(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  id: NodeId,
  oldBox: Rect,
  newBox: Rect,
  mode: ContentMode = 'constraints',
): void {
  const orig = originals.get(id);
  if (!orig) return;
  // 文本的高度由排版决定，上下方向拖不动
  const target = orig.type === 'text' ? { ...newBox, y: oldBox.y, h: oldBox.h } : newBox;
  const sx = oldBox.w > 0 ? target.w / oldBox.w : 1;
  const sy = oldBox.h > 0 ? target.h / oldBox.h : 1;
  // 内容相对节点原点缩放后，盒子的左上角会落在 oldBox.x * sx，再平移到 newBox.x
  const dx = target.x - oldBox.x * sx;
  const dy = target.y - oldBox.y * sy;
  tx.update(id, { transform: multiply(orig.transform, translation(dx, dy)) });
  scaleContent(tx, store, originals, id, sx, sy, mode);
}

/**
 * 在世界坐标里缩放：把一组节点的整体外接矩形从 from 变成 to。
 * 用于多选。没有旋转的对象结果是精确的；
 * 转过角度的对象无法在不变形的前提下做非等比缩放，所以按它自己的方向近似换算宽高。
 */
export function resizeInWorld(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  ids: readonly NodeId[],
  from: Rect,
  to: Rect,
  mode: ContentMode = 'constraints',
): void {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  for (const id of ids) {
    const orig = originals.get(id);
    if (!orig) continue;
    const parentWorld = parentWorldTransform(store, orig);
    const inverse = invert(parentWorld);
    if (!inverse) continue;
    const world = multiply(parentWorld, orig.transform);
    const [px, py] = applyToPoint(inverse, to.x + (world[4] - from.x) * sx, to.y + (world[5] - from.y) * sy);
    const t = orig.transform;
    tx.update(id, { transform: [t[0], t[1], t[2], t[3], px, py] });
    const [fx, fy] = localFactors(world, sx, sy);
    scaleContent(tx, store, originals, id, fx, fy, mode);
  }
}

/** 把一组节点绕世界坐标里的一个点旋转。画板不能旋转，会被跳过 */
export function rotateNodes(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  ids: readonly NodeId[],
  pivot: Point,
  radians: number,
): void {
  applyInWorld(tx, store, originals, ids, around(rotation(radians), pivot.x, pivot.y));
}

/** 把一组节点以世界坐标里的一个点为中心做水平或垂直翻转 */
export function flipNodes(
  tx: Transaction,
  store: DocStore,
  ids: readonly NodeId[],
  axis: 'horizontal' | 'vertical',
  pivot: Point,
): void {
  const originals = new Map(ids.flatMap((id) => (store.get(id) ? [[id, store.get(id)!] as const] : [])));
  const mirror = axis === 'horizontal' ? scaling(-1, 1) : scaling(1, -1);
  applyInWorld(tx, store, originals, ids, around(mirror, pivot.x, pivot.y));
}

/** 给节点叠加一个世界坐标里的变换，换算成它在父坐标系里的新变换 */
function applyInWorld(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  ids: readonly NodeId[],
  worldChange: Matrix,
): void {
  for (const id of ids) {
    const orig = originals.get(id);
    if (!orig || orig.type === 'artboard' || orig.type === 'page') continue;
    const parentWorld = parentWorldTransform(store, orig);
    const inverse = invert(parentWorld);
    if (!inverse) continue;
    tx.update(id, { transform: multiply(inverse, multiply(worldChange, multiply(parentWorld, orig.transform))) });
  }
}

/**
 * 把节点的内容相对它自己的原点缩放 (sx, sy)。
 * 只改几何（尺寸、锚点、子节点的位置），不往变换矩阵里塞缩放，这样描边粗细、圆角、字号都不会跟着变形。
 * 组件实例例外，见下面的 group 分支。
 */
function scaleContent(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  id: NodeId,
  sx: number,
  sy: number,
  mode: ContentMode,
): void {
  const orig = originals.get(id);
  if (!orig) return;
  const [w, h] = orig.size;
  switch (orig.type) {
    case 'rect':
    case 'ellipse':
    case 'polygon':
      tx.update(id, { size: [w * sx, h * sy] });
      break;
    case 'artboard':
    case 'frame': {
      // 画板、画框改自己的大小；里面的东西按约束跟着变，或者不动，或者整体按比例缩放
      const size: [number, number] = [w * sx, h * sy];
      tx.update(id, { size });
      if (mode === 'fixed') break;
      for (const child of store.children(id)) {
        const c = originals.get(child.id);
        if (!c) continue;
        if (mode === 'scale') {
          const t = c.transform;
          tx.update(child.id, { transform: [t[0], t[1], t[2], t[3], t[4] * sx, t[5] * sy] });
          const [cx, cy] = localFactors(t, sx, sy);
          scaleContent(tx, store, originals, child.id, cx, cy, mode);
        } else {
          constrainChild(tx, store, originals, c, orig.size, size, mode);
        }
      }
      break;
    }
    case 'path':
      tx.update(id, {
        size: [w * sx, h * sy],
        subpaths: orig.subpaths.map((sub) => ({
          closed: sub.closed,
          anchors: sub.anchors.map((a) => ({
            // 圆角半径留着（缩放只改几何，圆角不变形）
            ...a,
            x: a.x * sx,
            y: a.y * sy,
            inX: a.inX * sx,
            inY: a.inY * sy,
            outX: a.outX * sx,
            outY: a.outY * sy,
          })),
        })),
      });
      break;
    case 'text':
      // 横向拉伸文本框是改折行宽度，字号不变
      if (sx !== 1) tx.update(id, { size: [Math.max(1, w * sx), h], sizing: 'fixed' });
      else tx.update(id, { size: orig.size, sizing: orig.sizing });
      break;
    case 'group':
      // 组件实例整体缩放：写进自己的变换矩阵，描边、圆角、字号按比例变，里面的副本和主组件保持一样，照样同步
      if (orig.instanceOf !== undefined) {
        const current = tx.get(id) ?? orig;
        tx.update(id, { transform: multiply(current.transform, scaling(sx, sy)) });
        break;
      }
    // falls through
    case 'boolean':
      for (const child of store.children(id)) {
        const c = originals.get(child.id);
        if (!c) continue;
        const t = c.transform;
        tx.update(child.id, { transform: [t[0], t[1], t[2], t[3], t[4] * sx, t[5] * sy] });
        const [cx, cy] = localFactors(t, sx, sy);
        scaleContent(tx, store, originals, child.id, cx, cy, mode);
      }
      break;
  }
}

/** 节点在父坐标里的外接框，按原样算：编组、布尔组是里面的东西合起来的范围，其余是自己的盒子 */
function boxInParent(store: DocStore, originals: ReadonlyMap<NodeId, SceneNode>, node: SceneNode): Rect {
  if (node.type === 'group' || node.type === 'boolean') {
    const inner = store
      .children(node.id)
      .filter((c) => c.visible)
      .map((c) => boxInParent(store, originals, originals.get(c.id) ?? c));
    return transformRect(node.transform, unionRects(inner) ?? { x: 0, y: 0, w: 0, h: 0 });
  }
  return transformRect(node.transform, { x: 0, y: 0, w: node.size[0], h: node.size[1] });
}

/**
 * 容器从 oldSize 变成 newSize 时，按子节点的约束挪它、改它的大小（见 core 的 constraints.ts）。
 * 外接框在两个方向上各自按约束算出新的起点和长度，再像多选缩放那样换算到子节点上（转过角度的按自己的方向近似）
 */
function constrainChild(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  child: SceneNode,
  oldSize: readonly [number, number],
  newSize: readonly [number, number],
  mode: ContentMode,
): void {
  const constraints = child.constraints ?? DEFAULT_CONSTRAINTS;
  if (constraints.h === 'left' && constraints.v === 'top') return;
  const box = boxInParent(store, originals, child);
  const h = constrainAxis(constraints.h, box.x, box.w, oldSize[0], newSize[0]);
  const v = constrainAxis(constraints.v, box.y, box.h, oldSize[1], newSize[1]);
  const sx = box.w > 0 ? h.length / box.w : 1;
  const sy = box.h > 0 ? v.length / box.h : 1;
  const t = child.transform;
  tx.update(child.id, {
    transform: [t[0], t[1], t[2], t[3], h.start + (t[4] - box.x) * sx, v.start + (t[5] - box.y) * sy],
  });
  if (sx !== 1 || sy !== 1) {
    const [fx, fy] = localFactors(t, sx, sy);
    scaleContent(tx, store, originals, child.id, fx, fy, mode);
  }
}

/**
 * 外层在自己的两个轴上缩放 (sx, sy) 时，一个带旋转的内层对象沿它自己的两个轴各该缩放多少。
 * 没旋转时就是 (sx, sy)；转了 90° 时两个值对调；中间角度按投影折算。
 */
function localFactors(m: Matrix, sx: number, sy: number): [number, number] {
  const lengthX = Math.hypot(m[0], m[1]) || 1;
  const lengthY = Math.hypot(m[2], m[3]) || 1;
  return [Math.hypot(sx * m[0], sy * m[1]) / lengthX, Math.hypot(sx * m[2], sy * m[3]) / lengthY];
}
