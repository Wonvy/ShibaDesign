import {
  applyToPoint,
  applyToVector,
  breaksComponentRules,
  invert,
  isInstanceCopy,
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
import { flowChildren, layoutInsertion } from './auto-layout';
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
 * 拖动结束后按位置重新归属：对象的中心落在哪个画框里就放进那个画框（最里层的），否则落在哪个画板里
 * 就成为那个画板的子节点，落在所有画板之外就归页面。幻灯片视图里只在这一页和它里面的画框之间换。
 */
export function reparentByPosition(editor: Editor, tx: Transaction, ids: Iterable<NodeId>): void {
  const { store } = editor;
  const list = [...ids];
  // 拖动的画框不能放进自己里面
  const moving = new Set(list);
  for (const id of list) {
    const node = tx.get(id);
    if (!node || node.type === 'artboard' || !node.parent || isInstanceCopy(node)) continue;
    // 只管直接放在画板、画框或页面上的对象。编组（包括蒙版组）、布尔组里的成员挪动以后还留在组里，
    // 否则在组里拖一下成员，它就被拽出组、蒙版也遮不住它了
    const parent = tx.get(node.parent);
    if (parent?.type !== 'artboard' && parent?.type !== 'page' && parent?.type !== 'frame') continue;
    const center = rectCenter(editor.geometry.worldBounds(node));
    const target = editor.containerAt(center, moving);
    // 放进自动布局画框：按位置排在两个子对象之间（在同一个画框里拖就是调整顺序）
    const slot = !node.layoutIgnore ? layoutInsertion(editor, target.id, center, moving) : null;
    if (target.id === node.parent) {
      if (slot && !sameSlot(store, node, slot, moving)) tx.update(id, { index: slot.index });
      continue;
    }
    if (breaksComponentRules(store, [id], target.id)) continue;
    const inverse = invert(worldTransform(store, target.id));
    if (!inverse) continue;
    tx.update(id, {
      parent: target.id,
      index: slot?.index ?? store.indexOnTop(target.id),
      transform: multiply(inverse, worldTransform(store, id)),
    });
  }
}

/** 拖完还在原来那两个子对象之间：顺序没变，不用改索引 */
function sameSlot(
  store: DocStore,
  node: SceneNode,
  slot: { before: NodeId | null; after: NodeId | null },
  moving: ReadonlySet<NodeId>,
): boolean {
  const siblings = flowChildren(store, node.parent!).filter((c) => c.id === node.id || !moving.has(c.id));
  const i = siblings.findIndex((c) => c.id === node.id);
  return (siblings[i - 1]?.id ?? null) === slot.before && (siblings[i + 1]?.id ?? null) === slot.after;
}

/** 世界坐标里的一个矩形，换算成某个容器本地坐标下的左上角 */
export function localOrigin(store: DocStore, containerId: NodeId, rect: Rect): Point {
  const inverse = invert(worldTransform(store, containerId));
  if (!inverse) return { x: rect.x, y: rect.y };
  const [x, y] = applyToPoint(inverse, rect.x, rect.y);
  return { x, y };
}
