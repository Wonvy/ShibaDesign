import { describe, expect, it } from 'vitest';
import {
  DocStore,
  breaksComponentRules,
  canPlaceInstance,
  cloneSubtree,
  createNode,
  descendants,
  detachInstance,
  instanceNodes,
  instancesOf,
  isInstance,
  resetOverrides,
  rgba,
  solid,
  translation,
  validateDocument,
  type GroupNode,
  type NodeId,
  type RectNode,
  type SceneNode,
  type TextNode,
} from '../src';

const RED = rgba(1, 0, 0);
const BLUE = rgba(0, 0, 1);
const GREEN = rgba(0, 1, 0);

function rect(id: string, parent: string, index: string, color = RED): RectNode {
  return createNode('rect', {
    id,
    parent,
    index,
    seq: 1,
    size: [10, 10],
    fill: solid(color),
    stroke: null,
    cornerRadius: 0,
  });
}

function text(id: string, parent: string, index: string, value: string): TextNode {
  return createNode('text', {
    id,
    parent,
    index,
    seq: 1,
    transform: translation(0, 20),
    text: value,
    style: {
      fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.4,
      letterSpacing: 0,
    },
    align: 'left',
    sizing: 'auto',
    fill: solid(BLUE),
  });
}

function component(id: string, parent: string, index: string): GroupNode {
  return createNode('group', { id, parent, index, seq: 1, component: true });
}

/** 放一个实例，返回它的 id */
function place(store: DocStore, componentId: NodeId, parent: NodeId, x = 100): NodeId {
  const nodes = instanceNodes(store, componentId, {
    parent,
    index: store.indexOnTop(parent),
    transform: translation(x, 0),
    seq: 1,
  });
  store.transact('instance', (tx) => nodes.forEach((n) => tx.create(n)));
  store.sealHistory();
  return nodes[0]!.id;
}

/** 实例里对应主组件节点 sourceId 的那个副本（只找一层） */
function copyOf(store: DocStore, parent: NodeId, sourceId: NodeId): SceneNode {
  const found = store.children(parent).find((n) => n.source === sourceId);
  if (!found) throw new Error(`找不到 ${sourceId} 的副本`);
  return found;
}

function setup(): { store: DocStore; instance: NodeId } {
  const store = DocStore.create();
  const root = store.root.id;
  store.transact('setup', (tx) => {
    tx.create(component('C', root, 'a0'));
    tx.create(rect('C.r', 'C', 'a0'));
    tx.create(text('C.t', 'C', 'a1', '按钮'));
  });
  store.sealHistory();
  return { store, instance: place(store, 'C', root) };
}

function fillColor(node: SceneNode): unknown {
  return 'fill' in node && node.fill?.type === 'solid' ? node.fill.color : null;
}

describe('组件实例', () => {
  it('新建的实例是主组件内容的副本，位置是自己的', () => {
    const { store, instance } = setup();
    const root = store.get(instance) as GroupNode;
    expect(root.instanceOf).toBe('C');
    expect(root.component).toBeUndefined();
    expect(root.transform).toEqual(translation(100, 0));
    const kids = store.children(instance);
    expect(kids.map((k) => k.source)).toEqual(['C.r', 'C.t']);
    expect(kids.map((k) => k.type)).toEqual(['rect', 'text']);
    expect(instancesOf(store, 'C').map((n) => n.id)).toEqual([instance]);
  });

  it('改主组件时实例跟着改，和这次修改是同一步撤销', () => {
    const { store, instance } = setup();
    store.transact('color', (tx) => tx.update('C.r', { fill: solid(GREEN), size: [20, 30] }));
    store.sealHistory();
    const copy = copyOf(store, instance, 'C.r') as RectNode;
    expect(fillColor(copy)).toEqual(GREEN);
    expect(copy.size).toEqual([20, 30]);
    store.undo();
    expect(fillColor(copyOf(store, instance, 'C.r'))).toEqual(RED);
    store.redo();
    expect(fillColor(copyOf(store, instance, 'C.r'))).toEqual(GREEN);
  });

  it('实例里改过的属性记成覆盖，同步时保留，其余照常同步', () => {
    const { store, instance } = setup();
    const copy = copyOf(store, instance, 'C.r');
    store.transact('override', (tx) => tx.update(copy.id, { fill: solid(BLUE) }));
    expect(store.get(copy.id)!.overrides).toEqual(['fill']);
    store.transact('main', (tx) => tx.update('C.r', { fill: solid(GREEN), cornerRadius: 4 }));
    const after = store.get(copy.id) as RectNode;
    expect(fillColor(after)).toEqual(BLUE);
    expect(after.cornerRadius).toBe(4);
    // 改回和主组件一样，覆盖去掉
    store.transact('revert', (tx) => tx.update(copy.id, { fill: solid(GREEN) }));
    expect(store.get(copy.id)!.overrides).toBeUndefined();
  });

  it('改了实例里的文字，主组件的字符样式不会套到对不上的文字上', () => {
    const { store, instance } = setup();
    const copy = copyOf(store, instance, 'C.t');
    store.transact('type', (tx) => tx.update(copy.id, { text: '好' }));
    store.transact('main spans', (tx) =>
      tx.update('C.t', {
        spans: [{ start: 0, end: 2, style: { fontWeight: 700 } }],
        style: { ...(store.get('C.t') as TextNode).style, fontSize: 30 },
      }),
    );
    const after = store.get(copy.id) as TextNode;
    expect(after.text).toBe('好');
    expect(after.spans).toBeUndefined();
    expect(after.style.fontSize).toBe(30);
    expect(() => validateDocument(JSON.parse(JSON.stringify(store.toJSON())))).not.toThrow();
  });

  it('主组件加、删、调换子节点，实例跟着变', () => {
    const { store, instance } = setup();
    store.transact('add', (tx) => tx.create(rect('C.r2', 'C', 'a2', GREEN)));
    expect(store.children(instance).map((k) => k.source)).toEqual(['C.r', 'C.t', 'C.r2']);
    store.transact('reorder', (tx) => tx.update('C.r2', { index: 'Zz' }));
    expect(store.children(instance).map((k) => k.source)).toEqual(['C.r2', 'C.r', 'C.t']);
    store.transact('delete', (tx) => tx.remove('C.r'));
    expect(store.children(instance).map((k) => k.source)).toEqual(['C.r2', 'C.t']);
  });

  it('主组件里加的编组连同里面的东西一起补到实例里', () => {
    const { store, instance } = setup();
    store.transact('group', (tx) => {
      tx.create(createNode('group', { id: 'C.g', parent: 'C', index: 'a5', seq: 1 }));
      tx.create(rect('C.g.r', 'C.g', 'a0', GREEN));
    });
    const group = copyOf(store, instance, 'C.g');
    expect(store.children(group.id).map((k) => k.source)).toEqual(['C.g.r']);
    store.transact('inner', (tx) => tx.update('C.g.r', { fill: solid(BLUE) }));
    expect(fillColor(store.children(group.id)[0]!)).toEqual(BLUE);
  });

  it('复制出来的实例照样同步，覆盖也带过去', () => {
    const { store, instance } = setup();
    const copy = copyOf(store, instance, 'C.r');
    store.transact('override', (tx) => tx.update(copy.id, { fill: solid(BLUE) }));
    const clone = cloneSubtree(store, instance, { keepLineage: false });
    store.transact('dup', (tx) => clone.forEach((n, i) => tx.create(i === 0 ? { ...n, index: 'b0' } : n)));
    store.transact('main', (tx) => tx.update('C.r', { cornerRadius: 8, fill: solid(GREEN) }));
    const dupCopy = copyOf(store, clone[0]!.id, 'C.r') as RectNode;
    expect(dupCopy.cornerRadius).toBe(8);
    expect(fillColor(dupCopy)).toEqual(BLUE);
  });

  it('实例的蒙版方式跟着主组件', () => {
    const { store, instance } = setup();
    store.transact('mask', (tx) => tx.update('C', { mask: 'alpha' }));
    expect((store.get(instance) as GroupNode).mask).toBe('alpha');
    store.transact('unmask', (tx) => tx.replace({ ...(store.get('C') as GroupNode), mask: undefined } as GroupNode));
    expect((store.get(instance) as GroupNode).mask).toBeUndefined();
  });

  it('重置实例去掉所有覆盖', () => {
    const { store, instance } = setup();
    const copy = copyOf(store, instance, 'C.r');
    store.transact('override', (tx) => tx.update(copy.id, { fill: solid(BLUE), visible: false }));
    store.transact('reset', (tx) => resetOverrides(tx, store, instance));
    const after = store.get(copy.id)!;
    expect(after.overrides).toBeUndefined();
    expect(after.visible).toBe(true);
    expect(fillColor(after)).toEqual(RED);
  });

  it('分离实例变成普通编组，之后不再同步', () => {
    const { store, instance } = setup();
    store.transact('detach', (tx) => detachInstance(tx, store, instance));
    const group = store.get(instance) as GroupNode;
    expect(group.instanceOf).toBeUndefined();
    expect(store.children(instance).every((k) => k.source === undefined && k.overrides === undefined)).toBe(true);
    store.transact('main', (tx) => tx.update('C.r', { fill: solid(GREEN) }));
    expect(fillColor(store.children(instance)[0]!)).toEqual(RED);
  });
});

describe('嵌套的组件', () => {
  /** 组件 A（一个矩形）；组件 M 里放着 A 的实例和一段文字；I 是 M 的实例 */
  function nested(): { store: DocStore; nestedInMain: NodeId; outer: NodeId } {
    const store = DocStore.create();
    const root = store.root.id;
    store.transact('setup', (tx) => {
      tx.create(component('A', root, 'a0'));
      tx.create(rect('A.r', 'A', 'a0'));
      tx.create(text('A.t', 'A', 'a1', '图标'));
      tx.create(component('M', root, 'a1'));
      tx.create(text('M.t', 'M', 'a0', '卡片'));
    });
    store.sealHistory();
    const nestedInMain = place(store, 'A', 'M', 0);
    const outer = place(store, 'M', root, 300);
    return { store, nestedInMain, outer };
  }

  it('改最里层的组件，一层层传到外层的实例', () => {
    const { store, nestedInMain, outer } = nested();
    const nestedCopy = copyOf(store, outer, nestedInMain);
    expect(isInstance(nestedCopy)).toBe(true);
    const deep = copyOf(store, nestedCopy.id, copyOf(store, nestedInMain, 'A.r').id);
    store.transact('color', (tx) => tx.update('A.r', { fill: solid(GREEN) }));
    expect(fillColor(copyOf(store, nestedInMain, 'A.r'))).toEqual(GREEN);
    expect(fillColor(store.get(deep.id)!)).toEqual(GREEN);
  });

  it('主组件里对嵌套实例的覆盖传给外层实例；分离外层实例后，嵌套的实例改成直接跟着 A，覆盖还在', () => {
    const { store, nestedInMain, outer } = nested();
    const textInMain = copyOf(store, nestedInMain, 'A.t');
    store.transact('override in main', (tx) => tx.update(textInMain.id, { text: '星星' }));
    const nestedCopy = copyOf(store, outer, nestedInMain);
    const deepText = copyOf(store, nestedCopy.id, textInMain.id) as TextNode;
    expect(deepText.text).toBe('星星');

    store.transact('detach', (tx) => detachInstance(tx, store, outer));
    const freed = store.get(nestedCopy.id) as GroupNode;
    expect(freed.instanceOf).toBe('A');
    expect(freed.source).toBeUndefined();
    const freedText = store.get(deepText.id) as TextNode;
    expect(freedText.source).toBe('A.t');
    expect(freedText.overrides).toContain('text');

    store.transact('main', (tx) => tx.update('A.t', { fill: solid(GREEN) }));
    const synced = store.get(deepText.id) as TextNode;
    expect(synced.text).toBe('星星');
    expect(synced.fill?.color).toEqual(GREEN);
    // 原来的 M 和它的实例都没受影响
    expect(store.children(freed.id)).toHaveLength(2);
  });

  it('规则：主组件不能进主组件，不能用到自己', () => {
    const { store, outer } = nested();
    expect(canPlaceInstance(store, 'A', 'M')).toBe(true);
    expect(canPlaceInstance(store, 'M', 'M')).toBe(false);
    // A 里放 M 的实例，M 里又有 A 的实例：成环
    expect(canPlaceInstance(store, 'M', 'A')).toBe(false);
    expect(canPlaceInstance(store, 'A', outer)).toBe(false);
    expect(breaksComponentRules(store, ['M'], 'A')).toBe(true);
    expect(breaksComponentRules(store, [outer], 'A')).toBe(true);
    expect(breaksComponentRules(store, ['M.t'], 'A')).toBe(false);
    expect(breaksComponentRules(store, ['A.r'], outer)).toBe(true);
  });

  it('打开文件时拦住主组件套主组件、互相包含', () => {
    const { store, nestedInMain } = nested();
    const data = JSON.parse(JSON.stringify(store.toJSON()));
    expect(() => validateDocument(data)).not.toThrow();

    const inside = JSON.parse(JSON.stringify(data));
    inside.nodes.A.parent = 'M';
    expect(() => validateDocument(inside)).toThrow(/component inside component/);

    // A 里放一个 M 的实例
    const cyclic = JSON.parse(JSON.stringify(data));
    const extra = { ...cyclic.nodes[nestedInMain], id: 'loop', parent: 'A', instanceOf: 'M', index: 'b0' };
    cyclic.nodes.loop = extra;
    expect(() => validateDocument(cyclic)).toThrow();

    const bad = JSON.parse(JSON.stringify(data));
    bad.nodes['M.t'].overrides = 'text';
    expect(() => validateDocument(bad)).toThrow();
  });

  it('副本的血缘由实例的血缘推出来，同一个实例复制几份，后补的副本也配得上', () => {
    const { store, outer } = nested();
    const clone = cloneSubtree(store, outer, { keepLineage: true });
    store.transact('dup', (tx) => clone.forEach((n, i) => tx.create(i === 0 ? { ...n, index: 'c0' } : n)));
    store.transact('add', (tx) => tx.create(rect('M.r', 'M', 'a5')));
    const a = copyOf(store, outer, 'M.r');
    const b = copyOf(store, clone[0]!.id, 'M.r');
    expect(a.lineageId).toBe(b.lineageId);
    expect(a.id).not.toBe(b.id);
    expect(descendants(store, outer).length).toBe(descendants(store, clone[0]!.id).length);
  });
});
