import {
  applyToPoint,
  canPlaceInstance,
  componentOf,
  components,
  descendants,
  detachInstance,
  instanceNodes,
  invert,
  isComponent,
  isInstance,
  isInstanceCopy,
  nextSeq,
  rectCenter,
  resetOverrides,
  translation,
  worldTransform,
  type GroupNode,
  type NodeId,
  type Point,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '../editor';
import type { Command } from './command';
import { groupMembers, groupNodes } from './group';

/**
 * 组件：把选中的对象做成主组件、放实例、分离、重置、跳到主组件。数据和同步见 core 的 components.ts。
 */

type Plan = { kind: 'convert'; group: GroupNode } | { kind: 'wrap'; nodes: SceneNode[] };

/**
 * 选区怎么做成组件：只选了一个普通编组时直接把它标成主组件，否则先编组再标。
 * 主组件里不能再做组件，组件里也不能包着主组件；实例里的东西不能做（groupMembers 已经排除了）
 */
function plan(editor: Editor): Plan | null {
  const { store } = editor;
  const nodes = groupMembers(editor);
  const parent = nodes[0]?.parent;
  if (!parent || componentOf(store, parent)) return null;
  if (nodes.some((n) => [n, ...descendants(store, n.id)].some(isComponent))) return null;
  const only = nodes.length === 1 ? nodes[0]! : null;
  if (only?.type === 'group' && !isInstance(only)) return { kind: 'convert', group: only };
  return { kind: 'wrap', nodes };
}

/** 主组件的序号单独数，默认名是"组件 1""组件 2" */
function nextComponentSeq(editor: Editor): number {
  return Math.max(0, ...components(editor.store).map((c) => c.seq)) + 1;
}

/** 把选中的对象做成主组件 */
export const createComponent: Command = {
  id: 'component.create',
  enabled: (editor) => plan(editor) !== null,
  run(editor) {
    const next = plan(editor);
    if (!next) return;
    const seq = nextComponentSeq(editor);
    if (next.kind === 'convert') {
      editor.store.transact('create component', (tx) => tx.update(next.group.id, { component: true, seq }));
      editor.store.sealHistory();
      editor.select([next.group.id]);
      return;
    }
    const id = groupNodes(editor, next.nodes, { component: true, seq });
    if (id) editor.select([id]);
  },
};

export interface PlaceInstanceArgs {
  componentId: NodeId;
  /** 实例的中心放在哪里（世界坐标）。省略时放在视口中间（幻灯片视图里是当前这一页的中间） */
  at?: Point;
}

/** 放一个组件实例，选中它 */
export const placeInstance: Command<PlaceInstanceArgs> = {
  id: 'component.place',
  enabled: (editor, args) => isComponent(editor.store.get(args?.componentId ?? '')),
  run(editor, { componentId, at }) {
    const { store } = editor;
    const main = store.get(componentId);
    if (!isComponent(main)) return;
    const center = at ?? defaultCenter(editor);
    let container = editor.containerAt(center);
    // 比如在主组件所在的画板上放它自己的实例：画板本身不在组件里，照样可以；真要成环时放到页面上
    if (!canPlaceInstance(store, componentId, container.id)) container = store.root;
    const inverse = invert(worldTransform(store, container.id));
    if (!inverse) return;
    const [cx, cy] = applyToPoint(inverse, center.x, center.y);
    const content = rectCenter(editor.geometry.localBounds(main));
    const nodes = instanceNodes(store, componentId, {
      parent: container.id,
      index: store.indexOnTop(container.id),
      transform: translation(cx - content.x, cy - content.y),
      seq: nextSeq(store, 'group'),
    });
    store.transact('place instance', (tx) => nodes.forEach((node) => tx.create(node)));
    store.sealHistory();
    editor.select([nodes[0]!.id]);
  },
};

function defaultCenter(editor: Editor): Point {
  const board = editor.viewMode === 'slides' ? editor.activeArtboard : null;
  if (board) return rectCenter(editor.geometry.worldBounds(board));
  return editor.screenToWorld(editor.viewport.width / 2, editor.viewport.height / 2);
}

/** 选中的最外层实例。嵌套在实例里的实例分离不了：那等于改实例的结构 */
function outerInstances(editor: Editor): GroupNode[] {
  return editor.selectedNodes().filter((n): n is GroupNode => isInstance(n) && !isInstanceCopy(n));
}

/** 分离实例：变成普通编组，以后不再跟着主组件改 */
export const detachInstances: Command = {
  id: 'component.detach',
  enabled: (editor) => outerInstances(editor).length > 0,
  run(editor) {
    const { store } = editor;
    store.transact('detach instance', (tx) => {
      for (const instance of outerInstances(editor)) detachInstance(tx, store, instance.id);
    });
    store.sealHistory();
  },
};

/** 能重置的：实例，或者实例里的东西 */
function resettable(editor: Editor): SceneNode[] {
  return editor.selectedNodes().filter((n) => isInstance(n) || isInstanceCopy(n));
}

/** 重置实例：去掉所有覆盖，恢复成主组件的样子。选中的是实例里的某个对象时只重置它 */
export const resetInstances: Command = {
  id: 'component.reset',
  enabled: (editor) => resettable(editor).length > 0,
  run(editor) {
    const { store } = editor;
    store.transact('reset instance', (tx) => {
      for (const node of resettable(editor)) resetOverrides(tx, store, node.id);
    });
    store.sealHistory();
  },
};

/** 选中的实例对应的主组件；主组件已经删掉了时为 null */
export function mainOf(editor: Editor, node: SceneNode | undefined): GroupNode | null {
  if (!isInstance(node)) return null;
  const main = editor.store.get(node.instanceOf);
  return isComponent(main) ? main : null;
}

/** 跳到主组件：选中它，并让它出现在视口里 */
export const goToMainComponent: Command = {
  id: 'component.goToMain',
  enabled: (editor) => editor.selection.length === 1 && mainOf(editor, editor.selectedNodes()[0]) !== null,
  run(editor) {
    const main = mainOf(editor, editor.selectedNodes()[0]);
    if (main) editor.reveal(main.id);
  },
};
