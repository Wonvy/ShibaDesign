import {
  applyToPoint,
  descendants,
  isTranslationOnly,
  parentWorldTransform,
  type DocStore,
  type Matrix,
  type NodeId,
  type NodePatch,
  type Point,
  type Rect,
  type SceneNode,
  type TextNode,
  type Transaction,
} from '@shiba/core';

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

export function handleCursor(handle: Handle): string {
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
    default:
      return 'nesw-resize';
  }
}

/** 拖动某个控制柄到 pointer 后的新外接矩形。不允许翻转，最小 1 像素 */
export function resizeBounds(start: Rect, handle: Handle, pointer: Point, keepAspect: boolean): Rect {
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

/**
 * 缩放开始时记下的原始状态：选中的节点，以及布尔组内部的所有后代。
 * 自动宽度的文本在文档里不存宽度，所以要靠 textWidth 把排版出来的实际宽度补上。
 */
export function captureOriginals(
  store: DocStore,
  ids: readonly NodeId[],
  textWidth?: (node: TextNode) => number,
): Map<NodeId, SceneNode> {
  const out = new Map<NodeId, SceneNode>();
  for (const id of ids) {
    const node = store.get(id);
    if (!node) continue;
    out.set(id, node.type === 'text' && textWidth ? { ...node, size: [textWidth(node), node.size[1]] } : node);
    if (node.type === 'boolean') for (const d of descendants(store, id)) out.set(d.id, d);
  }
  return out;
}

/**
 * 把一组节点从外接矩形 from 缩放到 to（世界坐标）。
 * 始终从 originals 里的原始状态出发计算，拖动过程中不会累积误差。
 * 目前只处理没有旋转的节点；带旋转的节点保持不变，等旋转功能一起做。
 */
export function scaleNodes(
  tx: Transaction,
  store: DocStore,
  ids: readonly NodeId[],
  originals: ReadonlyMap<NodeId, SceneNode>,
  from: Rect,
  to: Rect,
): void {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  for (const id of ids) {
    const orig = originals.get(id);
    if (!orig) continue;
    const parentWorld = parentWorldTransform(store, orig);
    if (!isTranslationOnly(parentWorld) || !isTranslationOnly(orig.transform)) continue;
    const [wx, wy] = applyToPoint(parentWorld, orig.transform[4], orig.transform[5]);
    const nx = to.x + (wx - from.x) * sx;
    const ny = to.y + (wy - from.y) * sy;
    const transform: Matrix = [1, 0, 0, 1, nx - parentWorld[4], ny - parentWorld[5]];
    tx.update(id, { transform, ...scaledGeometry(orig, sx, sy) });
    if (orig.type === 'boolean') scaleChildren(tx, store, originals, id, sx, sy);
  }
}

/** 节点自身几何的缩放：尺寸，以及路径的锚点 */
function scaledGeometry(node: SceneNode, sx: number, sy: number): NodePatch {
  if (node.type === 'text') {
    // 横向拉伸文本框是改折行宽度，字号不变；高度由排版决定，纵向拉伸不起作用
    return sx === 1 ? {} : { size: [Math.max(1, node.size[0] * sx), node.size[1]], sizing: 'fixed' };
  }
  const patch: NodePatch = { size: [node.size[0] * sx, node.size[1] * sy] };
  if (node.type === 'path') {
    patch.subpaths = node.subpaths.map((sub) => ({
      closed: sub.closed,
      anchors: sub.anchors.map((a) => ({
        x: a.x * sx,
        y: a.y * sy,
        inX: a.inX * sx,
        inY: a.inY * sy,
        outX: a.outX * sx,
        outY: a.outY * sy,
      })),
    }));
  }
  return patch;
}

/** 布尔组的子节点相对组的原点整体缩放 */
function scaleChildren(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  parentId: NodeId,
  sx: number,
  sy: number,
): void {
  for (const child of store.children(parentId)) {
    const orig = originals.get(child.id);
    if (!orig || !isTranslationOnly(orig.transform)) continue;
    const transform: Matrix = [1, 0, 0, 1, orig.transform[4] * sx, orig.transform[5] * sy];
    tx.update(child.id, { transform, ...scaledGeometry(orig, sx, sy) });
    if (orig.type === 'boolean') scaleChildren(tx, store, originals, child.id, sx, sy);
  }
}
