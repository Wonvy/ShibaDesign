import {
  descendants,
  invert,
  isInstanceCopy,
  keyBetween,
  multiply,
  slides,
  topLevelOnly,
  transformRect,
  translation,
  unionRects,
  worldTransform,
  type ArtboardNode,
  type NodeId,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '../editor';
import { pruneAnimations } from './animation';
import type { Command } from './command';

/**
 * 右键菜单、顶部菜单里用到的整理类命令：搬到别的幻灯片、调幻灯片顺序、设为或取消幻灯片、
 * 画板适应内容、只显示这个、按样式选择、图片恢复原始比例
 */

/** 能搬走的对象：最外层、不是画板、不在实例里 */
function movable(editor: Editor): SceneNode[] {
  const { store } = editor;
  return topLevelOnly(store, editor.selection)
    .map((id) => store.get(id))
    .filter((n): n is SceneNode => n !== undefined && n.type !== 'artboard' && !isInstanceCopy(n));
}

/** 移到幻灯片：搬进另一个画板，保持在画板里的相对位置（和在两页之间复制粘贴一样），原来那一页的动画去掉 */
export const moveToSlide: Command<NodeId> = {
  id: 'arrange.moveToSlide',
  enabled: (editor, slideId) =>
    editor.store.get(slideId)?.type === 'artboard' && movable(editor).some((n) => n.parent !== slideId),
  run(editor, slideId) {
    const { store } = editor;
    const nodes = movable(editor).filter((n) => n.parent !== slideId);
    const target = store.get(slideId);
    if (!target || nodes.length === 0) return;
    store.transact('move to slide', (tx) => {
      let below = store.children(slideId).at(-1)?.index ?? null;
      for (const node of nodes) {
        const board = artboardAncestor(editor, node);
        // 相对原来画板的位置；不在画板里（散落在页面上）时按世界坐标
        const relative = board
          ? multiply(invert(worldTransform(store, board.id)) ?? node.transform, worldTransform(store, node.id))
          : multiply(invert(worldTransform(store, slideId)) ?? node.transform, worldTransform(store, node.id));
        const index = keyBetween(below, null);
        below = index;
        tx.update(node.id, { parent: slideId, index, transform: relative });
      }
      pruneAnimations(tx, store);
    });
    store.sealHistory();
    if (editor.viewMode === 'slides') editor.setActiveArtboard(slideId);
    editor.select(nodes.map((n) => n.id));
  },
};

function artboardAncestor(editor: Editor, node: SceneNode): ArtboardNode | null {
  let current = node.parent ? editor.store.get(node.parent) : undefined;
  while (current) {
    if (current.type === 'artboard') return current;
    current = current.parent ? editor.store.get(current.parent) : undefined;
  }
  return null;
}

export type SlideMove = 'up' | 'down' | 'start' | 'end';

/** 调整幻灯片的顺序：上移、下移、移到开头、移到末尾 */
export const moveSlide: Command<{ id: NodeId; to: SlideMove }> = {
  id: 'artboard.move',
  enabled: (editor, args) => {
    const deck = slides(editor.store);
    const at = deck.findIndex((s) => s.id === args?.id);
    if (at < 0) return false;
    return args.to === 'up' || args.to === 'start' ? at > 0 : at < deck.length - 1;
  },
  run(editor, { id, to }) {
    const { store } = editor;
    const deck = slides(store);
    const at = deck.findIndex((s) => s.id === id);
    const board = deck[at];
    if (!board?.deck) return;
    const others = deck.filter((s) => s.id !== id);
    const target = to === 'start' ? 0 : to === 'end' ? others.length : to === 'up' ? at - 1 : at + 1;
    const before = others[target - 1]?.deck?.order ?? null;
    const after = others[target]?.deck?.order ?? null;
    store.transact('move slide', (tx) => tx.update(id, { deck: { ...board.deck!, order: keyBetween(before, after) } }));
    store.sealHistory();
  },
};

/** 设为幻灯片 / 取消幻灯片：画板有没有 deck。取消时这一页的动画、切换、备注一起去掉（可以撤销） */
export const toggleSlide: Command<NodeId> = {
  id: 'artboard.toggleSlide',
  enabled: (editor, id) => editor.store.get(id)?.type === 'artboard',
  run(editor, id) {
    const { store } = editor;
    const board = store.get(id);
    if (board?.type !== 'artboard') return;
    const last = slides(store).at(-1)?.deck?.order ?? null;
    store.transact('toggle slide', (tx) =>
      tx.update(id, { deck: board.deck ? null : { order: keyBetween(last, null), notes: '' } }),
    );
    store.sealHistory();
  },
};

/** 画板适应内容：大小正好框住里面的对象，对象在画布上的位置不变 */
export const fitArtboard: Command<NodeId> = {
  id: 'artboard.fitContent',
  enabled: (editor, id) => editor.store.get(id)?.type === 'artboard' && editor.store.children(id).length > 0,
  run(editor, id) {
    const { store } = editor;
    const board = store.get(id);
    if (board?.type !== 'artboard') return;
    const toBoard = invert(worldTransform(store, id));
    if (!toBoard) return;
    const children = store.children(id).filter((c) => c.visible);
    const bounds = unionRects(children.map((c) => transformRect(toBoard, editor.geometry.worldBounds(c))));
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return;
    store.transact('fit artboard', (tx) => {
      tx.update(id, {
        size: [bounds.w, bounds.h],
        transform: multiply(board.transform, translation(bounds.x, bounds.y)),
      });
      for (const child of store.children(id)) {
        tx.update(child.id, { transform: multiply(translation(-bounds.x, -bounds.y), child.transform) });
      }
    });
    store.sealHistory();
  },
};

/** 只显示这个：同级的其他对象都隐藏；已经是只显示它时，再点一次全部显示回来 */
export const soloNode: Command<NodeId> = {
  id: 'node.solo',
  enabled: (editor, id) => {
    const node = editor.store.get(id);
    return !!node?.parent && editor.store.children(node.parent).length > 1;
  },
  run(editor, id) {
    const { store } = editor;
    const node = store.get(id);
    if (!node?.parent) return;
    const others = store.children(node.parent).filter((n) => n.id !== id);
    const alreadySolo = node.visible && others.every((n) => !n.visible);
    store.transact('solo', (tx) => {
      if (!node.visible) tx.update(id, { visible: true });
      for (const other of others) tx.update(other.id, { visible: alreadySolo });
    });
    store.sealHistory();
  },
};

/** 选中用了某个颜色样式或文字样式的对象（当前视图里） */
export const selectByStyle: Command<string> = {
  id: 'select.byStyle',
  run(editor, styleId) {
    const ids: NodeId[] = [];
    for (const root of editor.roots()) {
      for (const node of descendants(editor.store, root)) {
        if (!node.visible || node.locked) continue;
        const fill = 'fill' in node ? (node.fill as { colorStyle?: string } | null) : null;
        const stroke = 'stroke' in node ? (node.stroke as { colorStyle?: string } | null) : null;
        const text = node.type === 'text' ? node.textStyle : undefined;
        if (fill?.colorStyle === styleId || stroke?.colorStyle === styleId || text === styleId) ids.push(node.id);
      }
    }
    editor.select(topLevelOnly(editor.store, ids));
  },
};

/** 图片恢复原始比例：宽度不变，高度按图片的宽高比改 */
export const resetImageRatio: Command = {
  id: 'image.resetRatio',
  enabled: (editor) => editor.selectedNodes().some((n) => 'fill' in n && n.fill?.type === 'image'),
  run(editor) {
    editor.updateSelection('image ratio', (node) => {
      if (!('fill' in node) || node.fill?.type !== 'image') return null;
      const meta = editor.assets.meta(node.fill.assetId);
      if (!meta || meta.width <= 0 || meta.height <= 0) return null;
      return { size: [node.size[0], (node.size[0] * meta.height) / meta.width] as const };
    });
    editor.store.sealHistory();
  },
};
