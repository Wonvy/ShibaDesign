import {
  createNode,
  invert,
  keysBetween,
  multiply,
  nextSeq,
  sortByZOrder,
  topLevelOnly,
  worldTransform,
  type GroupNode,
  type NodeId,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '../editor';
import type { Command } from './command';

/** 可以编进组里的对象：除了画板和页面之外的一切，从下到上排好 */
export function groupMembers(editor: Editor): SceneNode[] {
  const ids = topLevelOnly(editor.store, editor.selection);
  return sortByZOrder(editor.store, ids).filter((n) => n.type !== 'artboard' && n.type !== 'page');
}

/**
 * 把一些对象编成一组，返回新组的 id。对象在画布上的位置和样子都不变，
 * 组放在最上面那个成员原来的层位，成员之间的上下顺序保持不变。
 * @param extra 新组的其他属性（比如蒙版）
 */
export function groupNodes(editor: Editor, nodes: readonly SceneNode[], extra: Partial<GroupNode> = {}): NodeId | null {
  const { store } = editor;
  const bottom = nodes[0];
  if (!bottom?.parent) return null;
  const parentId = bottom.parent;
  const parentInverse = invert(worldTransform(store, parentId));
  if (!parentInverse) return null;

  const anchor = [...nodes].reverse().find((n) => n.parent === parentId) ?? bottom;
  const group = createNode('group', { parent: parentId, index: anchor.index, seq: nextSeq(store, 'group'), ...extra });
  const indices = keysBetween(null, null, nodes.length);

  store.transact('group', (tx) => {
    // 先算好每个成员相对新父节点的变换，再统一改父节点，避免中途读到半成品
    const moves = nodes.map((node, i) => ({
      id: node.id,
      transform: multiply(parentInverse, worldTransform(store, node.id)),
      index: indices[i]!,
    }));
    tx.create(group);
    for (const move of moves) tx.update(move.id, { parent: group.id, index: move.index, transform: move.transform });
  });
  store.sealHistory();
  return group.id;
}

/** 把选中的对象编成一组 */
export const createGroup: Command = {
  id: 'group.create',
  enabled: (editor) => groupMembers(editor).length >= 1,
  run(editor) {
    const id = groupNodes(editor, groupMembers(editor));
    if (id) editor.select([id]);
  },
};

/** 取消编组：成员回到组原来所在的层级，位置和样子不变（组的旋转会留在每个成员身上） */
export const releaseGroup: Command = {
  id: 'group.release',
  enabled: (editor) => editor.selectedNodes().some((n) => n.type === 'group'),
  run(editor) {
    const { store } = editor;
    const released: NodeId[] = [];
    store.transact('ungroup', (tx) => {
      for (const group of editor.selectedNodes()) {
        if (group.type !== 'group' || !group.parent) continue;
        const siblings = store.children(group.parent);
        const above = siblings[siblings.findIndex((s) => s.id === group.id) + 1];
        const children = store.children(group.id);
        const indices = keysBetween(group.index, above?.index ?? null, children.length);
        children.forEach((child, i) => {
          tx.update(child.id, {
            parent: group.parent,
            index: indices[i]!,
            transform: multiply(group.transform, child.transform),
          });
          released.push(child.id);
        });
        tx.remove(group.id);
      }
    });
    store.sealHistory();
    editor.select(released);
  },
};
