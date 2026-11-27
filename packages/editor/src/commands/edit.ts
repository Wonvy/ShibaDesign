import { cloneSubtree, keyBetween, nextSeq, topLevelOnly, translated, type NodeId, type NodeType } from '@shiba/core';
import type { Editor } from '../editor';
import { translateNode } from '../ops';
import { duplicateArtboard } from './artboard';
import type { Command } from './command';

const DUPLICATE_OFFSET = 16;

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

export const deleteSelection: Command = {
  id: 'edit.delete',
  enabled: hasSelection,
  run(editor) {
    const ids = topLevelOnly(editor.store, editor.selection);
    editor.store.transact('delete', (tx) => ids.forEach((id) => tx.remove(id)));
    editor.store.sealHistory();
  },
};

export const duplicate: Command = {
  id: 'edit.duplicate',
  enabled: hasSelection,
  run(editor) {
    const { store } = editor;
    const created: NodeId[] = [];
    store.transact('duplicate', (tx) => {
      for (const id of topLevelOnly(store, editor.selection)) {
        const source = store.get(id);
        if (!source || !source.parent) continue;
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
          transform: translated(source.transform, DUPLICATE_OFFSET, DUPLICATE_OFFSET),
        });
        rest.forEach((node) => tx.create(node));
        created.push(root!.id);
      }
    });
    store.sealHistory();
    editor.select(created);
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
