import { descendants, isEnterable, sameValue, topLevelOnly, type NodeId, type SceneNode } from '@shiba/core';
import type { Editor } from '../editor';
import type { Command } from './command';

/** 能"进去"选里面东西的容器：编组、布尔组、画框。画板、页面不算（选画板里的东西直接点就行） */
function isContainer(node: SceneNode | undefined): boolean {
  return isEnterable(node);
}

function parentContainer(editor: Editor, node: SceneNode): SceneNode | null {
  const parent = node.parent ? editor.store.get(node.parent) : undefined;
  return parent && isContainer(parent) ? parent : null;
}

/** 选择父级（⇧↵）：选中对象所在的编组 */
export const selectParent: Command = {
  id: 'select.parent',
  enabled: (editor) => editor.selectedNodes().some((n) => parentContainer(editor, n) !== null),
  run(editor) {
    const ids = editor.selectedNodes().map((n) => parentContainer(editor, n)?.id ?? n.id);
    editor.select(topLevelOnly(editor.store, [...new Set(ids)]));
  },
};

/** 选择子级（↵）：选中编组里的东西；选中的是一个文本时开始编辑它，是一条路径时改它的锚点 */
export const selectChildren: Command = {
  id: 'select.children',
  enabled: (editor) => {
    const nodes = editor.selectedNodes();
    const single = nodes.length === 1 ? nodes[0]! : null;
    return single?.type === 'text' || single?.type === 'path' || nodes.some(isContainer);
  },
  run(editor) {
    const nodes = editor.selectedNodes();
    if (nodes.length === 1 && nodes[0]!.type === 'text') {
      editor.commands.run('text.edit', { id: nodes[0]!.id });
      return;
    }
    if (nodes.length === 1 && nodes[0]!.type === 'path') {
      editor.setTool('direct');
      return;
    }
    const ids = nodes.flatMap((n) => (isContainer(n) ? editor.store.children(n.id).map((c) => c.id) : [n.id]));
    editor.select(ids);
  },
};

function siblingStep(editor: Editor, delta: 1 | -1): void {
  const first = editor.selectedNodes()[0];
  if (!first?.parent) return;
  const siblings = editor.store.children(first.parent).filter((n) => n.visible && !n.locked);
  if (siblings.length === 0) return;
  const at = siblings.findIndex((n) => n.id === first.id);
  const next = siblings[(at + delta + siblings.length) % siblings.length]!;
  editor.select([next.id]);
}

/** 下一个同级（⇥）：层序往上一个，到顶了回到最下面 */
export const selectNext: Command = {
  id: 'select.next',
  enabled: (editor) => editor.selection.length > 0,
  run: (editor) => siblingStep(editor, 1),
};

/** 上一个同级（⇧⇥） */
export const selectPrevious: Command = {
  id: 'select.previous',
  enabled: (editor) => editor.selection.length > 0,
  run: (editor) => siblingStep(editor, -1),
};

/** 反选：当前视图里能框选的对象中，没选中的那些 */
export const selectInverse: Command = {
  id: 'select.inverse',
  run(editor) {
    const selected = new Set(editor.selection);
    editor.select(
      editor
        .selectableNodes()
        .filter((n) => !selected.has(n.id))
        .map((n) => n.id),
    );
  },
};

export type SameKind = 'fill' | 'stroke' | 'font' | 'type' | 'instances';

/** 当前视图里（幻灯片视图是这一页，画布视图是整个页面）看得见、没锁定的对象，不含画板 */
function scopeNodes(editor: Editor): SceneNode[] {
  const out: SceneNode[] = [];
  for (const root of editor.roots()) {
    for (const node of descendants(editor.store, root)) {
      if (node.type !== 'artboard' && node.visible && !node.locked) out.push(node);
    }
  }
  return out;
}

function matcher(reference: SceneNode, kind: SameKind): ((node: SceneNode) => boolean) | null {
  switch (kind) {
    case 'fill':
      return 'fill' in reference ? (n) => 'fill' in n && sameValue(n.fill, reference.fill) : null;
    case 'stroke':
      return 'stroke' in reference && reference.stroke
        ? (n) => 'stroke' in n && sameValue(n.stroke, reference.stroke)
        : null;
    case 'font':
      return reference.type === 'text'
        ? (n) => n.type === 'text' && sameValue(n.style.fontFamily, reference.style.fontFamily)
        : null;
    case 'type':
      return (n) => n.type === reference.type;
    case 'instances': {
      const main =
        reference.type === 'group' ? (reference.component ? reference.id : (reference.instanceOf ?? null)) : null;
      return main ? (n) => n.type === 'group' && n.instanceOf === main : null;
    }
  }
}

/** 全选同样填充 / 描边 / 字体 / 类型 / 同一组件的实例，以第一个选中的对象为准 */
export const selectSame: Command<SameKind> = {
  id: 'select.same',
  enabled: (editor, kind) => {
    const reference = editor.selectedNodes()[0];
    return reference !== undefined && matcher(reference, kind) !== null;
  },
  run(editor, kind) {
    const reference = editor.selectedNodes()[0];
    const match = reference ? matcher(reference, kind) : null;
    if (!match) return;
    const ids: NodeId[] = scopeNodes(editor)
      .filter(match)
      .map((n) => n.id);
    editor.select(topLevelOnly(editor.store, ids));
  },
};

/** 锁定 / 解锁（⇧⌘L）：选中的里面有没锁的就全部锁上，否则全部解锁 */
export const toggleLock: Command = {
  id: 'node.toggleLock',
  enabled: (editor) => editor.selection.length > 0,
  run(editor) {
    const nodes = editor.selectedNodes();
    const locked = nodes.some((n) => !n.locked);
    editor.updateSelection(locked ? 'lock' : 'unlock', () => ({ locked }));
    editor.store.sealHistory();
  },
};

/** 隐藏 / 显示（⇧⌘H）：选中的里面有显示着的就全部隐藏，否则全部显示 */
export const toggleVisible: Command = {
  id: 'node.toggleVisible',
  enabled: (editor) => editor.selection.length > 0,
  run(editor) {
    const visible = !editor.selectedNodes().some((n) => n.visible);
    editor.updateSelection(visible ? 'show' : 'hide', () => ({ visible }));
    editor.store.sealHistory();
  },
};

function updateScope(editor: Editor, label: string, test: (n: SceneNode) => boolean, patch: object): void {
  const targets: SceneNode[] = [];
  for (const root of editor.roots()) {
    for (const node of descendants(editor.store, root)) if (test(node)) targets.push(node);
  }
  if (targets.length === 0) return;
  editor.store.transact(label, (tx) => targets.forEach((n) => tx.update(n.id, patch)));
  editor.store.sealHistory();
}

/** 全部解锁：当前视图里锁定的对象 */
export const unlockAll: Command = {
  id: 'node.unlockAll',
  run: (editor) => updateScope(editor, 'unlock all', (n) => n.locked, { locked: false }),
};

/** 全部显示：当前视图里隐藏的对象（实例里被"删掉"的副本也会回来） */
export const showAll: Command = {
  id: 'node.showAll',
  run: (editor) => updateScope(editor, 'show all', (n) => !n.visible, { visible: true }),
};
