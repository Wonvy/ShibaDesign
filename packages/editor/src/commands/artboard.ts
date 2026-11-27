import {
  artboards,
  cloneSubtree,
  createNode,
  keyBetween,
  nextSeq,
  rgba,
  slides,
  solid,
  translation,
  type ArtboardNode,
  type NodeId,
  type Transaction,
} from '@shiba/core';
import type { Editor } from '../editor';
import type { Command } from './command';

const DEFAULT_SIZE: readonly [number, number] = [1280, 720];
const GAP = 80;

/** 新画板在自由画布上的位置：排在最右边的画板右侧 */
function nextPosition(editor: Editor, alignTo: ArtboardNode | undefined): { x: number; y: number } {
  const boards = artboards(editor.store);
  if (boards.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...boards.map((b) => b.transform[4] + b.size[0]));
  return { x: right + GAP, y: alignTo ? alignTo.transform[5] : boards[0]!.transform[5] };
}

/** 新建一个画板，同时也是幻灯片的最后一页 */
export const addArtboard: Command = {
  id: 'artboard.add',
  run(editor) {
    const { store } = editor;
    const deck = slides(store);
    const last = editor.activeArtboard ?? deck.at(-1);
    const position = nextPosition(editor, last);
    const board = createNode('artboard', {
      parent: store.root.id,
      index: store.indexOnTop(store.root.id),
      seq: nextSeq(store, 'artboard'),
      transform: translation(position.x, position.y),
      size: last?.size ?? DEFAULT_SIZE,
      fill: solid(rgba(1, 1, 1)),
      deck: { order: keyBetween(deck.at(-1)?.deck?.order ?? null, null), notes: '' },
    });
    store.transact('add artboard', (tx) => tx.create(board));
    store.sealHistory();
    editor.select([]);
    editor.setActiveArtboard(board.id);
    if (editor.viewMode === 'canvas') editor.zoomToFit();
  },
};

/**
 * 在调用方的事务里复制一个画板，返回新画板的 id。
 * 子节点的 lineageId 保持不变，这样两页之间的"平滑"切换能自动配对。
 */
export function duplicateArtboard(editor: Editor, tx: Transaction, sourceId: NodeId): NodeId {
  const { store } = editor;
  const source = store.require(sourceId) as ArtboardNode;
  const deck = slides(store);
  const next = deck[deck.findIndex((s) => s.id === sourceId) + 1];
  const position = nextPosition(editor, source);
  const [root, ...rest] = cloneSubtree(store, sourceId, { keepLineage: true });
  tx.create({
    ...(root as ArtboardNode),
    index: store.indexOnTop(store.root.id),
    seq: nextSeq(store, 'artboard'),
    transform: translation(position.x, position.y),
    deck: source.deck ? { ...source.deck, order: keyBetween(source.deck.order, next?.deck?.order ?? null) } : null,
  });
  rest.forEach((node) => tx.create(node));
  return root!.id;
}

export const duplicateActiveArtboard: Command<NodeId | undefined> = {
  id: 'artboard.duplicate',
  enabled: (editor, id) => (id ? editor.store.has(id) : editor.activeArtboard !== null),
  run(editor, id) {
    const sourceId = id ?? editor.activeArtboard?.id;
    if (!sourceId) return;
    const created = editor.store.transact('duplicate artboard', (tx) => duplicateArtboard(editor, tx, sourceId));
    editor.store.sealHistory();
    editor.select([]);
    editor.setActiveArtboard(created);
    if (editor.viewMode === 'canvas') editor.zoomToFit();
  },
};

export const deleteArtboard: Command<NodeId> = {
  id: 'artboard.delete',
  enabled: (editor, id) => editor.store.get(id)?.type === 'artboard',
  run(editor, id) {
    editor.store.transact('delete artboard', (tx) => tx.remove(id));
    editor.store.sealHistory();
    if (editor.viewMode === 'slides') editor.zoomToFit();
  },
};
