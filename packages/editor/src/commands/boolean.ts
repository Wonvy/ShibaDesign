import {
  createNode,
  hasShapeStyle,
  invert,
  keysBetween,
  multiply,
  nextSeq,
  solid,
  sortByZOrder,
  topLevelOnly,
  worldTransform,
  type BooleanNode,
  type BooleanOp,
  type NodeId,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '../editor';
import { DEFAULT_FILL } from '../ops';
import type { Command } from './command';

/** 可以参与布尔运算的节点：矩形、椭圆、路径，以及别的布尔组 */
function operands(editor: Editor): SceneNode[] {
  const ids = topLevelOnly(editor.store, editor.selection);
  const nodes = sortByZOrder(editor.store, ids);
  return nodes.every(hasShapeStyle) ? nodes : [];
}

/**
 * 把选中的形状编成一个布尔组。运算是非破坏性的：
 * 原来的形状成为布尔组的子节点，位置和样子都不变，之后仍可单独修改。
 * 布尔组的填充和描边取最底层那个形状的。
 */
export const createBoolean: Command<BooleanOp> = {
  id: 'boolean.create',
  enabled: (editor) => operands(editor).length >= 2,
  run(editor, op) {
    const { store } = editor;
    const nodes = operands(editor);
    const bottom = nodes[0];
    if (!bottom?.parent || nodes.length < 2) return;
    const parentId = bottom.parent;
    const parentInverse = invert(worldTransform(store, parentId));
    if (!parentInverse) return;

    // 布尔组放在同一父节点下最上面那个运算对象原来的层位
    const anchor = [...nodes].reverse().find((n) => n.parent === parentId) ?? bottom;
    const style = hasShapeStyle(bottom) ? bottom : null;
    const group = createNode('boolean', {
      parent: parentId,
      index: anchor.index,
      seq: nextSeq(store, 'boolean'),
      op,
      fill: style ? style.fill : solid(DEFAULT_FILL),
      stroke: style ? style.stroke : null,
    });
    const indices = keysBetween(null, null, nodes.length);

    store.transact('boolean', (tx) => {
      // 先算好每个对象相对新父节点的变换，再统一改父节点，避免中途读到半成品
      const moves = nodes.map((node, i) => ({
        id: node.id,
        transform: multiply(parentInverse, worldTransform(store, node.id)),
        index: indices[i]!,
      }));
      tx.create(group);
      for (const move of moves) tx.update(move.id, { parent: group.id, index: move.index, transform: move.transform });
    });
    store.sealHistory();
    editor.select([group.id]);
  },
};

/** 解散布尔组：子节点回到原来的层级，位置不变 */
export const releaseBoolean: Command = {
  id: 'boolean.release',
  enabled: (editor) => editor.selectedNodes().some((n) => n.type === 'boolean'),
  run(editor) {
    const { store } = editor;
    const released: NodeId[] = [];
    store.transact('release', (tx) => {
      for (const group of editor.selectedNodes()) {
        if (group.type !== 'boolean' || !group.parent) continue;
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

/** 修改已有布尔组的运算类型 */
export const setBooleanOp: Command<BooleanOp> = {
  id: 'boolean.setOp',
  enabled: (editor) => editor.selectedNodes().some((n) => n.type === 'boolean'),
  run(editor, op) {
    editor.updateSelection('boolean op', (node) => (node.type === 'boolean' ? { op } : null));
    editor.store.sealHistory();
  },
};

export function isBoolean(node: SceneNode): node is BooleanNode {
  return node.type === 'boolean';
}
