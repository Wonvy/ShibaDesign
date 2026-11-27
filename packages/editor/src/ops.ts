import {
  applyToPoint,
  applyToVector,
  invert,
  multiply,
  parentWorldTransform,
  rectCenter,
  rgba,
  translated,
  worldTransform,
  type Color,
  type DocStore,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
  type Transaction,
} from '@shiba/core';
import type { Editor } from './editor';

/** 工具和命令共用的文档操作。都在调用方的事务里执行 */

export const DEFAULT_FILL: Color = rgba(0.851, 0.851, 0.851);
export const DEFAULT_STROKE: Color = rgba(0.1, 0.1, 0.1);

/** 把节点在世界坐标里平移 (dx, dy)，以节点当前状态为起点 */
export function translateNode(tx: Transaction, store: DocStore, id: NodeId, dx: number, dy: number): void {
  const node = tx.get(id);
  if (!node || (dx === 0 && dy === 0)) return;
  const inverse = invert(parentWorldTransform(store, node));
  if (!inverse) return;
  const [lx, ly] = applyToVector(inverse, dx, dy);
  tx.update(id, { transform: translated(node.transform, lx, ly) });
}

/** 以拖动开始时记下的原始状态为起点平移，拖动过程中不累积误差 */
export function translateFromOriginals(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  dx: number,
  dy: number,
): void {
  for (const [id, original] of originals) {
    if (!tx.get(id)) continue;
    const inverse = invert(parentWorldTransform(store, original));
    if (!inverse) continue;
    const [lx, ly] = applyToVector(inverse, dx, dy);
    tx.update(id, { transform: translated(original.transform, lx, ly) });
  }
}

/**
 * 拖动结束后按位置重新归属：对象的中心落在哪个画板里，就成为那个画板的子节点；
 * 落在所有画板之外就归页面。只在自由画布视图里生效。
 */
export function reparentByPosition(editor: Editor, tx: Transaction, ids: Iterable<NodeId>): void {
  if (editor.viewMode !== 'canvas') return;
  const { store } = editor;
  for (const id of ids) {
    const node = tx.get(id);
    if (!node || node.type === 'artboard' || !node.parent) continue;
    const target = editor.containerAt(rectCenter(editor.geometry.worldBounds(node)));
    if (target.id === node.parent) continue;
    const inverse = invert(worldTransform(store, target.id));
    if (!inverse) continue;
    tx.update(id, {
      parent: target.id,
      index: store.indexOnTop(target.id),
      transform: multiply(inverse, worldTransform(store, id)),
    });
  }
}

/** 世界坐标里的一个矩形，换算成某个容器本地坐标下的左上角 */
export function localOrigin(store: DocStore, containerId: NodeId, rect: Rect): Point {
  const inverse = invert(worldTransform(store, containerId));
  if (!inverse) return { x: rect.x, y: rect.y };
  const [x, y] = applyToPoint(inverse, rect.x, rect.y);
  return { x, y };
}
