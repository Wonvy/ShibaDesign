import {
  artboards,
  cloneSubtree,
  createId,
  createNode,
  descendants,
  keyBetween,
  nextSeq,
  rgba,
  slides,
  solid,
  translation,
  type ArtboardNode,
  type NodeId,
  type SlideAnimation,
  type SlideDeck,
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
  const originals = [source, ...descendants(store, sourceId)];
  const [root, ...rest] = cloneSubtree(store, sourceId, { keepLineage: true });
  // 复制出来的节点和原节点一一对应、顺序相同，据此把动画的目标换成新节点
  const idMap = new Map(originals.map((node, i) => [node.id, [root, ...rest][i]!.id]));
  const animations = source.deck?.animations?.flatMap((a) => {
    const target = idMap.get(a.target);
    return target ? [{ ...a, id: createId(), target }] : [];
  });
  tx.create({
    ...(root as ArtboardNode),
    index: store.indexOnTop(store.root.id),
    seq: nextSeq(store, 'artboard'),
    transform: translation(position.x, position.y),
    deck: source.deck
      ? copyDeck(source.deck, keyBetween(source.deck.order, next?.deck?.order ?? null), animations)
      : null,
  });
  rest.forEach((node) => tx.create(node));
  return root!.id;
}

/** 复制一页的设置：换上新的顺序，动画换成指向新节点的那一份（原来那份指向的是原页面上的节点） */
function copyDeck(source: SlideDeck, order: string, animations: SlideAnimation[] | undefined): SlideDeck {
  const { animations: _original, ...rest } = source;
  return { ...rest, order, ...(animations && animations.length > 0 ? { animations } : {}) };
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
