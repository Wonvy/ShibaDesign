import {
  align,
  artboardOf,
  distribute,
  isInstanceCopy,
  keyBetween,
  sortByZOrder,
  topLevelOnly,
  unionRects,
  type AlignMode,
  type Box,
  type Delta,
  type DistributeMode,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '../editor';
import { translateNode } from '../ops';
import type { Command } from './command';

function targets(editor: Editor): SceneNode[] {
  return topLevelOnly(editor.store, editor.selection).map((id) => editor.store.require(id));
}

function boxesOf(editor: Editor, nodes: readonly SceneNode[]): Box[] {
  return nodes.map((node) => ({ id: node.id, ...editor.geometry.worldBounds(node) }));
}

/** 对象所在的画框或画板（往上找最近的一个） */
function containerOf(editor: Editor, node: SceneNode): SceneNode | null {
  for (let parent = node.parent ? editor.store.get(node.parent) : undefined; parent;) {
    if (parent.type === 'frame' || parent.type === 'artboard') return parent;
    parent = parent.parent ? editor.store.get(parent.parent) : undefined;
  }
  return artboardOf(editor.store, node.id);
}

/**
 * 对齐的参照物：多选时是选区整体（视图选项"对齐到画框"打开时是它们所在的画框或画板）；
 * 只选一个对象时是它所在的画框或画板，也就是幻灯片视图里的"对齐幻灯片"。
 */
function alignReference(editor: Editor, nodes: readonly SceneNode[], boxes: readonly Box[]): Rect | null {
  if (nodes.length > 1 && !editor.view.alignToContainer) return unionRects(boxes);
  const first = nodes[0];
  if (!first || nodes.some((n) => n.type === 'artboard')) return nodes.length > 1 ? unionRects(boxes) : null;
  const container = containerOf(editor, first);
  // 多选时它们得在同一个容器里，不然按选区整体
  if (nodes.length > 1 && nodes.some((n) => containerOf(editor, n)?.id !== container?.id)) return unionRects(boxes);
  return container ? editor.geometry.worldBounds(container) : null;
}

function applyDeltas(editor: Editor, label: string, deltas: readonly Delta[]): void {
  const { store } = editor;
  store.transact(label, (tx) => deltas.forEach((d) => translateNode(tx, store, d.id, d.dx, d.dy)));
  store.sealHistory();
}

export const alignSelection: Command<AlignMode> = {
  id: 'arrange.align',
  enabled(editor) {
    const nodes = targets(editor);
    return alignReference(editor, nodes, boxesOf(editor, nodes)) !== null;
  },
  run(editor, mode) {
    const nodes = targets(editor);
    const boxes = boxesOf(editor, nodes);
    const reference = alignReference(editor, nodes, boxes);
    if (reference) applyDeltas(editor, 'align', align(boxes, mode, reference));
  },
};

export const distributeSelection: Command<DistributeMode> = {
  id: 'arrange.distribute',
  enabled: (editor) => targets(editor).length >= 3,
  run(editor, mode) {
    applyDeltas(editor, 'distribute', distribute(boxesOf(editor, targets(editor)), mode));
  },
};

export type OrderMode = 'front' | 'forward' | 'backward' | 'back';

/** 能调层序的对象：画板以外的；实例里的副本不行，它们的顺序跟着主组件 */
const orderable = (node: SceneNode): boolean => node.type !== 'artboard' && !isInstanceCopy(node);

export const orderSelection: Command<OrderMode> = {
  id: 'arrange.order',
  enabled: (editor) => targets(editor).some(orderable),
  run(editor, mode) {
    const { store } = editor;
    const selected = new Set(editor.selection);
    const ordered = sortByZOrder(
      store,
      targets(editor)
        .filter(orderable)
        .map((n) => n.id),
    );
    // 往上移时从最上面的开始处理，往下移时从最下面的开始，保持选中对象之间的相对顺序
    const queue = mode === 'front' || mode === 'backward' ? ordered : [...ordered].reverse();

    store.transact('order', (tx) => {
      for (const { id } of queue) {
        const node = tx.get(id);
        if (!node?.parent) continue;
        const siblings = store.children(node.parent);
        const i = siblings.findIndex((s) => s.id === id);
        let index: string | null = null;
        if (mode === 'front') {
          if (i < siblings.length - 1) index = keyBetween(siblings.at(-1)!.index, null);
        } else if (mode === 'back') {
          if (i > 0) index = keyBetween(null, siblings[0]!.index);
        } else if (mode === 'forward') {
          const above = siblings[i + 1];
          if (above && !selected.has(above.id)) index = keyBetween(above.index, siblings[i + 2]?.index ?? null);
        } else {
          const below = siblings[i - 1];
          if (below && !selected.has(below.id)) index = keyBetween(siblings[i - 2]?.index ?? null, below.index);
        }
        if (index !== null) tx.update(id, { index });
      }
    });
    store.sealHistory();
  },
};
