import {
  applyToPoint,
  around,
  descendants,
  invert,
  multiply,
  parentWorldTransform,
  rotation,
  scaling,
  translation,
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
 * 变换开始时记下的原始状态：选中的节点，以及编组和布尔组内部的所有后代。
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
    if (node.type === 'group' || node.type === 'boolean') descendants(store, id).forEach(add);
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
  scaleContent(tx, store, originals, id, sx, sy);
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
    scaleContent(tx, store, originals, id, fx, fy);
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
): void {
  const orig = originals.get(id);
  if (!orig) return;
  const [w, h] = orig.size;
  switch (orig.type) {
    case 'rect':
    case 'ellipse':
    case 'artboard':
      // 画板只改自己的大小，里面的内容不跟着缩放
      tx.update(id, { size: [w * sx, h * sy] });
      break;
    case 'path':
      tx.update(id, {
        size: [w * sx, h * sy],
        subpaths: orig.subpaths.map((sub) => ({
          closed: sub.closed,
          anchors: sub.anchors.map((a) => ({
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
        scaleContent(tx, store, originals, child.id, cx, cy);
      }
      break;
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
