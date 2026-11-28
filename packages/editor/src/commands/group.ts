import {
  breaksComponentRules,
  createNode,
  transformRect,
  translation,
  unionRects,
  detachInstance,
  invert,
  isInstance,
  isInstanceCopy,
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

/**
 * 可以编进组里的对象：除了画板和页面之外的一切，从下到上排好。
 * 实例里的东西不能编组（实例的结构由主组件决定）；编组会把对象挪进最下面那个对象所在的容器，
 * 挪进去违反组件规则的（比如把主组件自己的实例挪进主组件）也不行，这两种情况返回空列表
 */
export function groupMembers(editor: Editor): SceneNode[] {
  const ids = topLevelOnly(editor.store, editor.selection);
  const nodes = sortByZOrder(editor.store, ids).filter((n) => n.type !== 'artboard' && n.type !== 'page');
  return structureEditable(editor, nodes) ? nodes : [];
}

/**
 * 能不能把这些对象挪到最下面那个对象所在的容器里，再改它们的结构（编组、布尔运算、蒙版）
 */
export function structureEditable(editor: Editor, nodes: readonly SceneNode[]): boolean {
  if (nodes.some(isInstanceCopy)) return false;
  const parent = nodes[0]?.parent;
  if (!parent) return true;
  const movers = nodes.filter((n) => n.parent !== parent).map((n) => n.id);
  return movers.length === 0 || !breaksComponentRules(editor.store, movers, parent);
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

/**
 * 用画框把一些对象包起来，返回新画框的 id。画框正好框住它们（几何范围，不含描边），放在最上面那个对象原来的层位；
 * 画框没有填充、不裁剪，所以包起来之后画布上的样子不变（描边伸出画框也不会被切掉）
 */
export function frameNodes(editor: Editor, nodes: readonly SceneNode[]): NodeId | null {
  const { store } = editor;
  const bottom = nodes[0];
  if (!bottom?.parent) return null;
  const parentId = bottom.parent;
  const parentInverse = invert(worldTransform(store, parentId));
  if (!parentInverse) return null;
  // 每个对象在父节点坐标里的变换和范围
  const inParent = nodes.map((node) => multiply(parentInverse, worldTransform(store, node.id)));
  const box = unionRects(nodes.map((node, i) => transformRect(inParent[i]!, editor.geometry.localBounds(node))));
  if (!box) return null;
  const anchor = [...nodes].reverse().find((n) => n.parent === parentId) ?? bottom;
  const frame = createNode('frame', {
    parent: parentId,
    index: anchor.index,
    seq: nextSeq(store, 'frame'),
    transform: translation(box.x, box.y),
    size: [box.w, box.h],
    fill: null,
    stroke: null,
    cornerRadius: 0,
    clip: false,
  });
  const indices = keysBetween(null, null, nodes.length);
  store.transact('frame', (tx) => {
    tx.create(frame);
    nodes.forEach((node, i) => {
      const t = inParent[i]!;
      tx.update(node.id, {
        parent: frame.id,
        index: indices[i]!,
        transform: [t[0], t[1], t[2], t[3], t[4] - box.x, t[5] - box.y],
      });
    });
  });
  store.sealHistory();
  return frame.id;
}

/** 用画框把选中的对象包起来（⌥⌘G） */
export const wrapInFrame: Command = {
  id: 'frame.wrap',
  enabled: (editor) => groupMembers(editor).length >= 1,
  run(editor) {
    const id = frameNodes(editor, groupMembers(editor));
    if (id) editor.select([id]);
  },
};

/** 把选中的对象编成一组 */
export const createGroup: Command = {
  id: 'group.create',
  enabled: (editor) => groupMembers(editor).length >= 1,
  run(editor) {
    const id = groupNodes(editor, groupMembers(editor));
    if (id) editor.select([id]);
  },
};

/**
 * 取消编组：成员回到组原来所在的层级，位置和样子不变（组的旋转会留在每个成员身上）。
 * 对画框也一样：去掉画框，里面的东西留下（画框自己的填充、描边、裁剪没了）
 */
export const releaseGroup: Command = {
  id: 'group.release',
  enabled: (editor) =>
    editor.selectedNodes().some((n) => (n.type === 'group' || n.type === 'frame') && !isInstanceCopy(n)),
  run(editor) {
    const { store } = editor;
    const released: NodeId[] = [];
    store.transact('ungroup', (tx) => {
      for (const selected of editor.selectedNodes()) {
        if ((selected.type !== 'group' && selected.type !== 'frame') || !selected.parent) continue;
        if (isInstanceCopy(selected)) continue;
        // 取消实例的编组：先分离成普通编组，里面的东西才能变成普通对象
        if (isInstance(selected)) detachInstance(tx, store, selected.id);
        const group = tx.get(selected.id)!;
        const parentId = selected.parent;
        const siblings = store.children(parentId);
        const above = siblings[siblings.findIndex((s) => s.id === group.id) + 1];
        const children = store.children(group.id);
        const indices = keysBetween(group.index, above?.index ?? null, children.length);
        children.forEach((child, i) => {
          tx.update(child.id, {
            parent: parentId,
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
