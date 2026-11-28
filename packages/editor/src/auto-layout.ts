import {
  DEFAULT_ITEM_SIZING,
  applyToPoint,
  computeLayout,
  invert,
  keyBetween,
  transformRect,
  worldTransform,
  type FrameNode,
  type LayoutItem,
  type NodeId,
  type Normalizer,
  type Patch,
  type Point,
  type Rect,
  type SceneNode,
  type TextNode,
  type Transaction,
  type DocStore,
} from '@shiba/core';
import type { Editor } from './editor';
import { captureOriginals, resizeLocal } from './resize';

/**
 * 自动布局的整理器：每次事务的最后，把受影响的自动布局画框重新排一次，结果直接写进子对象的 transform 和 size
 * （算法见 core 的 auto-layout.ts）。排在样式、组件同步之后：实例里的副本先补齐、照主组件同步，再排。
 * 写出来的位置不是用户改的，组件同步不会把它们记成覆盖（覆盖只看事务本身的修改）。
 *
 * 量文字的大小要用排版引擎，所以整理器放在编辑器里，不在 core
 */

const EPSILON = 1e-6;

function isLayoutFrame(node: SceneNode | undefined): node is FrameNode & { layout: NonNullable<FrameNode['layout']> } {
  return node?.type === 'frame' && node.layout !== undefined;
}

/** 参与排列的子对象：看得见、没有标"不参与"的 */
export function flowChildren(store: DocStore, frameId: NodeId): SceneNode[] {
  return store.children(frameId).filter((c) => c.visible && !c.layoutIgnore);
}

/** 子对象在画框坐标里的外框 */
function boxOf(editor: Editor, node: SceneNode): Rect {
  return transformRect(node.transform, editor.geometry.localBounds(node));
}

const sizeChanged = (a: SceneNode, b: SceneNode) =>
  Math.abs(a.size[0] - b.size[0]) > EPSILON || Math.abs(a.size[1] - b.size[1]) > EPSILON;

/**
 * 用户自己改了大小时，把对应方向的尺寸方式改成固定（和设计软件一样）：
 * 拖子对象的控制柄，它不再"填满"；拖包住内容的画框，它不再"包住内容"。
 * 画框跟着改了大小（比如整体缩放）带出来的子对象变化不算；子对象跟着变（等比缩放）时画框照旧包住内容
 */
function pinUserSizes(tx: Transaction, userPatches: readonly Patch[]): void {
  const changed = new Set(
    userPatches.filter((p) => p.before && p.after && sizeChanged(p.before, p.after)).map((p) => p.id),
  );
  for (const patch of userPatches) {
    const before = patch.before;
    const after = tx.get(patch.id);
    if (!before || !after || !changed.has(after.id)) continue;
    const wChanged = Math.abs(after.size[0] - before.size[0]) > EPSILON;
    const hChanged = Math.abs(after.size[1] - before.size[1]) > EPSILON;
    const parent = after.parent ? tx.get(after.parent) : undefined;
    if (isLayoutFrame(parent) && !after.layoutIgnore && after.layoutSizing && !changed.has(parent.id)) {
      const h = wChanged ? 'fixed' : after.layoutSizing.h;
      const v = hChanged ? 'fixed' : after.layoutSizing.v;
      if (h !== after.layoutSizing.h || v !== after.layoutSizing.v) {
        tx.update(after.id, { layoutSizing: h === 'fixed' && v === 'fixed' ? undefined : { h, v } });
      }
    }
    if (isLayoutFrame(after) && before.type === 'frame' && before.layout === after.layout) {
      const kids = [...changed].some((id) => tx.get(id)?.parent === after.id);
      if (kids) continue;
      const { sizing } = after.layout;
      const h = wChanged ? 'fixed' : sizing.h;
      const v = hChanged ? 'fixed' : sizing.v;
      if (h !== sizing.h || v !== sizing.v) tx.update(after.id, { layout: { ...after.layout, sizing: { h, v } } });
    }
  }
}

/** 排一个画框。返回它的大小有没有变（变了的话外层的自动布局画框也要排） */
export function layoutFrame(editor: Editor, tx: Transaction, frameId: NodeId): boolean {
  const { store } = editor;
  const frame = tx.get(frameId);
  if (!isLayoutFrame(frame) || editor.layoutPaused.has(frameId)) return false;
  const children = flowChildren(store, frameId);
  const textWidth = (node: TextNode): number => editor.textLayouts.get(node).width;
  const items: LayoutItem[] = children.map((child) => {
    const box = boxOf(editor, child);
    return { id: child.id, width: box.w, height: box.h, sizing: child.layoutSizing ?? DEFAULT_ITEM_SIZING };
  });
  // 宽度变了的文字重新量高度
  const measure = (item: LayoutItem, width: number): number => {
    const node = tx.get(item.id);
    if (node?.type !== 'text') return item.height;
    return editor.textLayouts.get({ ...node, size: [width, node.size[1]], sizing: 'fixed' }).height;
  };
  const result = computeLayout(frame.size, frame.layout, items, measure);
  const resized = sizeChangedTo(frame.size, result.size);
  if (resized) tx.update(frameId, { size: result.size });

  for (const child of children) {
    const target = result.boxes.get(child.id);
    if (!target) continue;
    const current = tx.get(child.id)!;
    const box = boxOf(editor, current);
    const t = current.transform;
    const dx = target.x - box.x;
    const dy = target.y - box.y;
    const axisAligned = Math.abs(t[1]) < EPSILON && Math.abs(t[2]) < EPSILON && t[0] > 0 && t[3] > 0;
    const resize = axisAligned && (Math.abs(target.w - box.w) > 0.01 || Math.abs(target.h - box.h) > 0.01);
    if (resize) {
      // 改大小：在子对象自己的坐标里把外框换成新的（没转角度时就是平移加缩放），里面的东西照约束、自动布局跟着变
      const local = editor.geometry.localBounds(current);
      const next = {
        x: local.x + dx / t[0],
        y: local.y + dy / t[3],
        w: target.w / t[0],
        h: target.h / t[3],
      };
      resizeLocal(tx, store, captureOriginals(store, [child.id], textWidth), child.id, local, next);
    } else if (Math.abs(dx) > EPSILON || Math.abs(dy) > EPSILON) {
      tx.update(child.id, { transform: [t[0], t[1], t[2], t[3], t[4] + dx, t[5] + dy] });
    }
  }
  return resized;
}

function sizeChangedTo(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) > EPSILON || Math.abs(a[1] - b[1]) > EPSILON;
}

/** 节点在树里有多深（页面是 0） */
function depthOf(tx: Transaction, id: NodeId): number {
  let depth = 0;
  for (let node = tx.get(id); node?.parent; node = tx.get(node.parent)) depth++;
  return depth;
}

/** 把一组画框由里到外排好；排完大小变了的，外层的自动布局画框接着排 */
export function layoutFrames(editor: Editor, tx: Transaction, frames: Iterable<NodeId>): void {
  const pending = new Set(frames);
  const done = new Set<NodeId>();
  // 由里到外：每次排最深的那个
  while (pending.size > 0) {
    let deepest: NodeId | null = null;
    let depth = -1;
    for (const id of pending) {
      const d = depthOf(tx, id);
      if (d > depth) {
        depth = d;
        deepest = id;
      }
    }
    const id = deepest!;
    pending.delete(id);
    if (done.has(id)) continue;
    done.add(id);
    const resized = layoutFrame(editor, tx, id);
    const parentId = tx.get(id)?.parent;
    if (resized && parentId && isLayoutFrame(tx.get(parentId))) pending.add(parentId);
  }
}

/** 整理器：找出这次事务碰到的自动布局画框（自己变了、里面的东西变了），排一遍 */
export function autoLayoutNormalizer(editor: Editor): Normalizer {
  return (tx, _store, userPatches) => {
    pinUserSizes(tx, userPatches);
    const dirty = new Set<NodeId>();
    const mark = (id: NodeId | null | undefined): void => {
      if (id && isLayoutFrame(tx.get(id))) dirty.add(id);
    };
    for (const patch of tx.patches.values()) {
      if (patch.before === patch.after) continue;
      mark(patch.id);
      mark(patch.after?.parent);
      mark(patch.before?.parent);
    }
    if (dirty.size > 0) layoutFrames(editor, tx, dirty);
  };
}

/** 把文档里所有自动布局画框重新排一次，不进撤销历史（字体晚到、文字变宽之后用） */
export function relayoutAll(editor: Editor): void {
  const frames = [...editor.store.all()].filter(isLayoutFrame).map((f) => f.id);
  if (frames.length === 0) return;
  editor.store.transact('auto layout', (tx) => layoutFrames(editor, tx, frames), { history: false });
}

/**
 * 把东西拖进自动布局画框、放在 world（世界坐标）这一点时，它排在哪：返回新的分数索引，
 * 以及插入条在画框坐标里的两个端点（画在两个子对象之间的空隙中间）。moving 是正在拖的，不算在排列里
 */
export function layoutInsertion(
  editor: Editor,
  frameId: NodeId,
  world: Point,
  moving: ReadonlySet<NodeId>,
): { index: string; bar: [Point, Point]; before: NodeId | null; after: NodeId | null } | null {
  const { store } = editor;
  const frame = store.get(frameId);
  if (!isLayoutFrame(frame)) return null;
  const inverse = invert(worldTransform(store, frameId));
  if (!inverse) return null;
  const [px, py] = applyToPoint(inverse, world.x, world.y);
  const horizontal = frame.layout.direction === 'horizontal';
  const siblings = flowChildren(store, frameId).filter((c) => !moving.has(c.id));
  const boxes = siblings.map((c) => boxOf(editor, c));
  const main = (b: Rect) => (horizontal ? { start: b.x, end: b.x + b.w } : { start: b.y, end: b.y + b.h });
  const p = horizontal ? px : py;
  let i = boxes.findIndex((b) => (main(b).start + main(b).end) / 2 > p);
  if (i < 0) i = siblings.length;
  const before = siblings[i - 1] ?? null;
  const after = siblings[i] ?? null;
  const index = keyBetween(before?.index ?? null, after?.index ?? null);
  const gap = frame.layout.gap;
  const [top, right, bottom, left] = frame.layout.padding;
  let at: number;
  if (after) at = main(boxes[i]!).start - gap / 2;
  else if (before) at = main(boxes[i - 1]!).end + gap / 2;
  else at = horizontal ? left : top;
  const bar: [Point, Point] = horizontal
    ? [
        { x: at, y: top },
        { x: at, y: frame.size[1] - bottom },
      ]
    : [
        { x: left, y: at },
        { x: frame.size[0] - right, y: at },
      ];
  return { index, bar, before: before?.id ?? null, after: after?.id ?? null };
}

/** 是不是自动布局画框（给别的模块用） */
export function hasAutoLayout(node: SceneNode | undefined): boolean {
  return isLayoutFrame(node);
}
