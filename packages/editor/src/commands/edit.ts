import {
  cloneSubtree,
  hasLiveAppearance,
  isInstanceCopy,
  keyBetween,
  nextSeq,
  topLevelOnly,
  translated,
  type NodeId,
  type NodeType,
  type TextNode,
  type Transaction,
} from '@shiba/core';
import type { Editor } from '../editor';
import { translateNode } from '../ops';
import { captureOriginals, resizeLocal } from '../resize';
import { pruneAnimations } from './animation';
import { duplicateArtboard } from './artboard';
import type { Command } from './command';

const DUPLICATE_OFFSET = 16;

/**
 * 上一次创建副本的结果：新节点 id → 它是从哪个节点复制来的。紧接着把副本挪了一段再按 ⌘D，
 * 就按同样的偏移继续复制（Sketch、Figma 都有，排一排等距的东西很方便）；选区换了就不算
 */
const lastDuplicate = new WeakMap<Editor, Map<NodeId, NodeId>>();

/** 选中的正好是上一次复制出来的副本时，副本相对原件挪了多少；否则是默认的错开 */
function repeatOffset(editor: Editor): { dx: number; dy: number } {
  const fallback = { dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET };
  const memory = lastDuplicate.get(editor);
  const selection = editor.selection;
  if (!memory || memory.size !== selection.length || !selection.every((id) => memory.has(id))) return fallback;
  const first = selection[0];
  const copy = first ? editor.store.get(first) : undefined;
  const source = first ? editor.store.get(memory.get(first)!) : undefined;
  if (!copy || !source || copy.parent !== source.parent) return fallback;
  const dx = copy.transform[4] - source.transform[4];
  const dy = copy.transform[5] - source.transform[5];
  return dx === 0 && dy === 0 ? fallback : { dx, dy };
}

const hasSelection = (editor: Editor): boolean => editor.selection.length > 0;

export const undo: Command = {
  id: 'edit.undo',
  enabled: (editor) => editor.store.canUndo,
  run: (editor) => void editor.store.undo(),
};

export const redo: Command = {
  id: 'edit.redo',
  enabled: (editor) => editor.store.canRedo,
  run: (editor) => void editor.store.redo(),
};

/**
 * 删除选中的对象。实例里的东西删不掉（实例的结构由主组件决定），删除等于把它隐藏，
 * 这是一项覆盖，重置实例就回来了
 */
export const deleteSelection: Command = {
  id: 'edit.delete',
  enabled: hasSelection,
  run(editor) {
    const ids = topLevelOnly(editor.store, editor.selection);
    editor.store.transact('delete', (tx) => {
      for (const id of ids) {
        const node = tx.get(id);
        if (!node) continue;
        if (isInstanceCopy(node)) tx.update(id, { visible: false });
        else tx.remove(id);
      }
      pruneAnimations(tx, editor.store);
    });
    editor.store.sealHistory();
  },
};

/**
 * 在调用方的事务里复制一组节点（各自放在原件上面），返回原件 id → 副本 id。
 * 画板整个复制（保留血缘，动画跟着换，见 duplicateArtboard），别的对象挪 (dx, dy)。
 * 实例里的东西不能复制（会往实例里加东西），跳过。创建副本和 Alt 拖动复制共用
 */
export function cloneNodes(
  editor: Editor,
  tx: Transaction,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): Map<NodeId, NodeId> {
  const { store } = editor;
  const out = new Map<NodeId, NodeId>();
  for (const id of topLevelOnly(store, ids)) {
    const source = store.get(id);
    if (!source || !source.parent || isInstanceCopy(source)) continue;
    if (source.type === 'artboard') {
      out.set(id, duplicateArtboard(editor, tx, source.id));
      continue;
    }
    const siblings = store.children(source.parent);
    const above = siblings[siblings.findIndex((s) => s.id === id) + 1];
    const [root, ...rest] = cloneSubtree(store, id, { keepLineage: false });
    tx.create({
      ...root!,
      index: keyBetween(source.index, above?.index ?? null),
      seq: nextSeq(store, source.type as NodeType),
      transform: translated(source.transform, dx, dy),
    });
    rest.forEach((node) => tx.create(node));
    out.set(id, root!.id);
  }
  return out;
}

/** 复制选中的对象，错开一点放；紧接着挪过副本的话按挪过的偏移放 */
export const duplicate: Command = {
  id: 'edit.duplicate',
  enabled: (editor) => editor.selectedNodes().some((n) => !isInstanceCopy(n)),
  run(editor) {
    const { store } = editor;
    const { dx, dy } = repeatOffset(editor);
    const map = store.transact('duplicate', (tx) => cloneNodes(editor, tx, editor.selection, dx, dy));
    store.sealHistory();
    const created = [...map.values()];
    editor.select(created);
    // 只记普通对象：画板的副本放在别处，不按偏移重复
    lastDuplicate.set(
      editor,
      new Map([...map].filter(([source]) => store.get(source)?.type !== 'artboard').map(([s, c]) => [c, s])),
    );
  },
};

/** 复制一份并挪一下（⌥ 加方向键，Illustrator 的习惯） */
export const duplicateNudge: Command<{ dx: number; dy: number }> = {
  id: 'edit.duplicateNudge',
  enabled: (editor) => editor.selectedNodes().some((n) => !isInstanceCopy(n) && n.type !== 'artboard'),
  run(editor, { dx, dy }) {
    const { store } = editor;
    const ids = editor
      .selectedNodes()
      .filter((n) => n.type !== 'artboard')
      .map((n) => n.id);
    const map = store.transact('duplicate', (tx) => cloneNodes(editor, tx, ids, dx, dy));
    store.sealHistory();
    editor.select([...map.values()]);
  },
};

/** 用键盘改大小（⌘ 加方向键）：改右边和下边，每个对象沿自己的方向改。连续按是一步撤销 */
export const resizeBy: Command<{ dw: number; dh: number }> = {
  id: 'edit.resize',
  enabled: (editor) => editor.selectedNodes().some((n) => !n.locked),
  run(editor, { dw, dh }) {
    const { store } = editor;
    const ids = topLevelOnly(store, editor.selection);
    const textWidth = (node: TextNode): number =>
      hasLiveAppearance(node) ? node.size[0] : editor.textLayouts.get(node).width;
    const originals = captureOriginals(store, ids, textWidth);
    store.transact(
      'resize',
      (tx) => {
        for (const id of ids) {
          const node = originals.get(id);
          if (!node) continue;
          const box = editor.geometry.localBounds(node);
          const next = { ...box, w: Math.max(1, box.w + dw), h: Math.max(1, box.h + dh) };
          resizeLocal(tx, store, originals, id, box, next);
        }
      },
      { mergeKey: `resize:${editor.selection.join(',')}` },
    );
  },
};

export const selectAll: Command = {
  id: 'edit.selectAll',
  run: (editor) => editor.select(editor.selectableNodes().map((n) => n.id)),
};

export const deselect: Command = {
  id: 'edit.deselect',
  enabled: hasSelection,
  run: (editor) => editor.clearSelection(),
};

export const nudge: Command<{ dx: number; dy: number }> = {
  id: 'edit.nudge',
  enabled: hasSelection,
  run(editor, { dx, dy }) {
    const { store } = editor;
    // 连续按方向键合并成一步撤销
    store.transact(
      'nudge',
      (tx) => topLevelOnly(store, editor.selection).forEach((id) => translateNode(tx, store, id, dx, dy)),
      { mergeKey: `nudge:${editor.selection.join(',')}` },
    );
  },
};

export const setTool: Command<string> = {
  id: 'tool.set',
  run: (editor, id) => editor.setTool(id),
};
