import {
  breaksComponentRules,
  cloneSubtree,
  descendants,
  invert,
  isDescendantOf,
  isInstance,
  isInstanceCopy,
  keysBetween,
  nextSeq,
  sortByZOrder,
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
  type NodeType,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '../editor';
import { pruneAnimations } from './animation';
import { duplicateArtboard } from './artboard';
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

export interface MoveNodesArgs {
  ids: readonly NodeId[];
  /** 放进哪个父节点 */
  parent: NodeId;
  /** 放在这个同级节点的上面（层序）；null 放在最下面 */
  above: NodeId | null;
  /** 复制过去（Alt 拖动），原来的不动 */
  copy?: boolean;
}

/** 这几个节点能不能放进 parent：画板只能在页面上，别的不能进实例、不能放进自己的子孙，组件的规则不能破 */
function canMoveInto(editor: Editor, ids: readonly NodeId[], parentId: NodeId): boolean {
  const { store } = editor;
  const parent = store.get(parentId);
  if (!parent || isInstance(parent) || isInstanceCopy(parent)) return false;
  if (!['page', 'artboard', 'group', 'boolean'].includes(parent.type)) return false;
  for (const id of ids) {
    const node = store.get(id);
    if (!node || isInstanceCopy(node)) return false;
    if (node.type === 'artboard' && parent.type !== 'page') return false;
    if (id === parentId || isDescendantOf(store, parentId, id)) return false;
  }
  return !breaksComponentRules(store, ids, parentId);
}

/**
 * 图层面板里拖动：把节点挪到（或复制到）别的父节点、别的层序位置，在画布上的位置不变。
 * 几个节点一起挪时保持它们原来的先后
 */
export const moveNodes: Command<MoveNodesArgs> = {
  id: 'node.moveTo',
  enabled: (editor, args) => !!args && args.ids.length > 0 && canMoveInto(editor, args.ids, args.parent),
  run(editor, { ids, parent, above, copy }) {
    const { store } = editor;
    const nodes = sortByZOrder(store, topLevelOnly(store, ids));
    if (
      nodes.length === 0 ||
      !canMoveInto(
        editor,
        nodes.map((n) => n.id),
        parent,
      )
    )
      return;
    const toParent = invert(worldTransform(store, parent));
    if (!toParent) return;
    const moving = new Set(nodes.map((n) => n.id));
    const siblings = store.children(parent).filter((n) => copy || !moving.has(n.id));
    const anchor = above ? siblings.findIndex((n) => n.id === above) : -1;
    const lower = anchor >= 0 ? siblings[anchor]!.index : null;
    const upper = anchor >= 0 ? (siblings[anchor + 1]?.index ?? null) : (siblings[0]?.index ?? null);
    const indices = keysBetween(lower, upper, nodes.length);
    const created: NodeId[] = [];
    store.transact(copy ? 'copy layers' : 'move layers', (tx) => {
      nodes.forEach((node, i) => {
        const transform = multiply(toParent, worldTransform(store, node.id));
        if (copy) {
          const [root, ...rest] = cloneSubtree(store, node.id, { keepLineage: false });
          tx.create({ ...root!, parent, index: indices[i]!, transform, seq: nextSeq(store, node.type as NodeType) });
          rest.forEach((n) => tx.create(n));
          created.push(root!.id);
        } else {
          tx.update(node.id, { parent, index: indices[i]!, transform });
          created.push(node.id);
        }
      });
      pruneAnimations(tx, store);
    });
    store.sealHistory();
    editor.select(created);
  },
};

/** 能玩的幻灯片：看得见、没隐藏的那几页，演示、导出网页和视频只放这些 */
export function playableSlides(editor: Editor): ArtboardNode[] {
  return slides(editor.store).filter((slide) => slide.visible && !slide.deck?.skip);
}

export interface ReorderSlidesArgs {
  ids: readonly NodeId[];
  /** 放到第几页的位置（按去掉这几页之后的顺序数）；复制时按全部的顺序数 */
  index: number;
  /** 复制这几页放过去（Alt 拖动），原来的不动 */
  copy?: boolean;
}

/** 幻灯片条里拖动：把几页挪到（或复制到）某个位置，保持它们原来的先后 */
export const reorderSlides: Command<ReorderSlidesArgs> = {
  id: 'artboard.reorder',
  enabled: (editor, args) => !!args && args.ids.some((id) => editor.store.get(id)?.type === 'artboard'),
  run(editor, { ids, index, copy }) {
    const { store } = editor;
    const deck = slides(store);
    const picked = deck.filter((s) => ids.includes(s.id));
    if (picked.length === 0) return;
    const rest = copy ? deck : deck.filter((s) => !ids.includes(s.id));
    const at = Math.max(0, Math.min(index, rest.length));
    const orders = keysBetween(rest[at - 1]?.deck?.order ?? null, rest[at]?.deck?.order ?? null, picked.length);
    const result: NodeId[] = [];
    store.transact(copy ? 'copy slides' : 'move slides', (tx) => {
      picked.forEach((slide, i) => {
        const id = copy ? duplicateArtboard(editor, tx, slide.id) : slide.id;
        const current = (tx.get(id) as ArtboardNode).deck!;
        tx.update(id, { deck: { ...current, order: orders[i]! } });
        result.push(id);
      });
    });
    store.sealHistory();
    if (copy && result[0]) editor.setActiveArtboard(result[0]);
  },
};

/** 隐藏幻灯片：演示、导出网页和视频时跳过，编辑时照常显示。几页一起切换：有没隐藏的就全隐藏，否则全显示 */
export const toggleSkip: Command<readonly NodeId[]> = {
  id: 'artboard.toggleSkip',
  enabled: (editor, ids) => !!ids && ids.some((id) => (editor.store.get(id) as ArtboardNode | undefined)?.deck),
  run(editor, ids) {
    const { store } = editor;
    const boards = ids.map((id) => store.get(id)).filter((n): n is ArtboardNode => n?.type === 'artboard' && !!n.deck);
    const skip = boards.some((b) => !b.deck!.skip);
    store.transact('hide slide', (tx) => {
      for (const board of boards) {
        const { skip: _old, ...deck } = board.deck!;
        tx.update(board.id, { deck: skip ? { ...deck, skip: true } : deck });
      }
    });
    store.sealHistory();
  },
};
