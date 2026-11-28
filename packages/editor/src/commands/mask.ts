import { MASK_MODES, isInstance, maskParts, type MaskMode, type SceneNode } from '@shiba/core';
import { isPlainShape } from '@shiba/renderer';
import type { Editor } from '../editor';
import type { Command } from './command';
import { groupMembers, groupNodes } from './group';

/**
 * 蒙版。蒙版组是带 mask 属性的编组：组里最上面的对象当蒙版，遮住其余的对象。
 * 创建时用最上面的那个对象当蒙版——形状盖在图片上面，再点"创建蒙版"，图片就被裁成这个形状，和 Illustrator 的剪切蒙版一样。
 */

/** 选中的蒙版组。实例的蒙版方式跟着主组件，不能单独改，不算在内 */
function maskGroups(editor: Editor): SceneNode[] {
  return editor.selectedNodes().filter((n) => n.type === 'group' && n.mask && !(isInstance(n) && !n.source));
}

/** 新蒙版用什么模式：普通形状按轮廓裁剪（干净、导出时是矢量的）；文字、图片、编组按透明度遮 */
function defaultMode(editor: Editor, mask: SceneNode): MaskMode {
  const plain = isPlainShape(editor.nodeTypes, mask) && !('fill' in mask && mask.fill?.type === 'image');
  return plain ? 'shape' : 'alpha';
}

/** 把选中的对象编成蒙版组，最上面的那个当蒙版。编组和设蒙版是一步撤销 */
export const createMask: Command = {
  id: 'mask.create',
  enabled: (editor) => groupMembers(editor).length >= 2,
  run(editor) {
    const nodes = groupMembers(editor);
    const top = nodes[nodes.length - 1];
    if (!top) return;
    const id = groupNodes(editor, nodes, { mask: defaultMode(editor, top) });
    if (id) editor.select([id]);
  },
};

/** 释放蒙版：组还在，蒙版变回普通对象，重新显示出来 */
export const releaseMask: Command = {
  id: 'mask.release',
  enabled: (editor) => maskGroups(editor).length > 0,
  run(editor) {
    editor.store.transact('release mask', (tx) => {
      for (const group of maskGroups(editor)) tx.update(group.id, { mask: undefined });
    });
    editor.store.sealHistory();
  },
};

/** 创建或释放蒙版（⌥⌘M）：选中的是蒙版组就释放，否则用选中的对象建一个 */
export const toggleMask: Command = {
  id: 'mask.toggle',
  enabled: (editor) => maskGroups(editor).length > 0 || groupMembers(editor).length >= 2,
  run(editor) {
    editor.commands.run(maskGroups(editor).length > 0 ? 'mask.release' : 'mask.create');
  },
};

/** 换蒙版的模式 */
export const setMaskMode: Command<MaskMode> = {
  id: 'mask.setMode',
  enabled: (editor, mode) => MASK_MODES.includes(mode) && maskGroups(editor).length > 0,
  run(editor, mode) {
    editor.store.transact('mask mode', (tx) => {
      for (const group of maskGroups(editor)) tx.update(group.id, { mask: mode });
    });
    editor.store.sealHistory();
  },
};

/** 某个节点是不是所在蒙版组的蒙版。图层列表用它标记 */
export function isMaskNode(editor: Editor, node: SceneNode): boolean {
  const parent = node.parent ? editor.store.get(node.parent) : undefined;
  return !!parent && maskParts(editor.store, parent).mask?.id === node.id;
}
