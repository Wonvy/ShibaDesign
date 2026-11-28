import {
  cloneSubtree,
  isInstanceCopy,
  keyBetween,
  nextSeq,
  topLevelOnly,
  translated,
  type NodeId,
  type NodeType,
} from '@shiba/core';
import type { Editor } from '../editor';
import { translateNode } from '../ops';
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

/** 复制选中的对象。实例里的东西不能复制（会往实例里加东西），跳过 */
export const duplicate: Command = {
  id: 'edit.duplicate',
  enabled: (editor) => editor.selectedNodes().some((n) => !isInstanceCopy(n)),
  run(editor) {
    const { store } = editor;
    const created: NodeId[] = [];
    const sources = new Map<NodeId, NodeId>();
    const { dx, dy } = repeatOffset(editor);
    store.transact('duplicate', (tx) => {
      for (const id of topLevelOnly(store, editor.selection)) {
        const source = store.get(id);
        if (!source || !source.parent || isInstanceCopy(source)) continue;
        if (source.type === 'artboard') {
          created.push(duplicateArtboard(editor, tx, source.id));
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
        created.push(root!.id);
        sources.set(root!.id, source.id);
      }
    });
    store.sealHistory();
    editor.select(created);
    lastDuplicate.set(editor, sources);
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
