import { topLevelOnly, type Point } from '@shiba/core';
import type { Editor } from '../editor';
import { captureOriginals, flipNodes, rotateNodes } from '../resize';
import type { Command } from './command';

/** 能旋转和翻转的对象：除了画板之外的一切 */
function targets(editor: Editor): string[] {
  return topLevelOnly(editor.store, editor.selection).filter((id) => editor.store.get(id)?.type !== 'artboard');
}

/** 选区框的中心，旋转和翻转都以它为轴 */
function pivotOf(editor: Editor): Point | null {
  const frame = editor.selectionFrame();
  if (!frame) return null;
  const [tl, , br] = frame.corners;
  return { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
}

/** 把选中的对象绕选区中心旋转若干度，正数为顺时针 */
export const rotateSelection: Command<number> = {
  id: 'arrange.rotate',
  enabled: (editor) => targets(editor).length > 0,
  run(editor, degrees) {
    const { store } = editor;
    const ids = targets(editor);
    const pivot = pivotOf(editor);
    if (!pivot || ids.length === 0 || !Number.isFinite(degrees)) return;
    const originals = captureOriginals(store, ids);
    store.transact('rotate', (tx) => rotateNodes(tx, store, originals, ids, pivot, (degrees * Math.PI) / 180));
    store.sealHistory();
  },
};

export const flipSelection: Command<'horizontal' | 'vertical'> = {
  id: 'arrange.flip',
  enabled: (editor) => targets(editor).length > 0,
  run(editor, axis) {
    const { store } = editor;
    const ids = targets(editor);
    const pivot = pivotOf(editor);
    if (!pivot || ids.length === 0) return;
    store.transact('flip', (tx) => flipNodes(tx, store, ids, axis, pivot));
    store.sealHistory();
  },
};
