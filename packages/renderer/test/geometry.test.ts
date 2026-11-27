import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { DocStore, createNode, rgba, solid, translation, type BooleanOp, type SceneNode } from '@shiba/core';
import {
  GeometryCache,
  NodeTypeRegistry,
  booleanFailures,
  loadCanvasKit,
  registerBuiltinNodeTypes,
  type CanvasKit,
} from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

function setup(): { store: DocStore; geometry: GeometryCache } {
  const store = DocStore.create();
  const registry = registerBuiltinNodeTypes(new NodeTypeRegistry());
  return { store, geometry: new GeometryCache(ck, store, registry) };
}

function rect(store: DocStore, parent: string, x: number, y: number, w: number, h: number): SceneNode {
  return store.transact('rect', (tx) =>
    tx.create(
      createNode('rect', {
        parent,
        index: store.indexOnTop(parent),
        seq: 1,
        transform: translation(x, y),
        size: [w, h],
        fill: solid(rgba(0, 0, 0)),
        stroke: null,
        cornerRadius: 0,
      }),
    ),
  );
}

function ellipse(store: DocStore, parent: string, x: number, y: number, w: number, h: number): SceneNode {
  return store.transact('ellipse', (tx) =>
    tx.create(
      createNode('ellipse', {
        parent,
        index: store.indexOnTop(parent),
        seq: 1,
        transform: translation(x, y),
        size: [w, h],
        fill: solid(rgba(0, 0, 0)),
        stroke: null,
      }),
    ),
  );
}

function boolean(store: DocStore, op: BooleanOp): SceneNode {
  return store.transact('bool', (tx) =>
    tx.create(
      createNode('boolean', {
        parent: store.root.id,
        index: store.indexOnTop(store.root.id),
        seq: 1,
        op,
        fill: solid(rgba(0, 0, 0)),
        stroke: null,
      }),
    ),
  );
}

describe('布尔运算', () => {
  // 两个 100×100 的正方形，第二个向右下偏移 50
  function twoSquares(op: BooleanOp) {
    const env = setup();
    const group = boolean(env.store, op);
    rect(env.store, group.id, 0, 0, 100, 100);
    rect(env.store, group.id, 50, 50, 100, 100);
    return { ...env, group: env.store.require(group.id) };
  }

  it('联集覆盖两个形状', () => {
    const { geometry, group } = twoSquares('union');
    expect(geometry.localBounds(group)).toEqual({ x: 0, y: 0, w: 150, h: 150 });
    const path = geometry.outlineOf(group);
    expect(path.contains(10, 10)).toBe(true);
    expect(path.contains(140, 140)).toBe(true);
    expect(path.contains(140, 10)).toBe(false);
  });

  it('减去顶层只留下底层没被盖住的部分', () => {
    const { geometry, group } = twoSquares('subtract');
    const path = geometry.outlineOf(group);
    expect(path.contains(10, 10)).toBe(true);
    expect(path.contains(75, 75)).toBe(false);
    expect(path.contains(140, 140)).toBe(false);
  });

  it('交集只留下重叠部分', () => {
    const { geometry, group } = twoSquares('intersect');
    expect(geometry.localBounds(group)).toEqual({ x: 50, y: 50, w: 50, h: 50 });
  });

  it('排除去掉重叠部分', () => {
    const { geometry, group } = twoSquares('exclude');
    const path = geometry.outlineOf(group);
    expect(path.contains(10, 10)).toBe(true);
    expect(path.contains(140, 140)).toBe(true);
    expect(path.contains(75, 75)).toBe(false);
  });

  it('子节点移动后结果自动重算', () => {
    const { store, geometry, group } = twoSquares('intersect');
    const top = store.children(group.id)[1]!;
    store.transact('move', (tx) => tx.update(top.id, { transform: translation(80, 80) }));
    expect(geometry.localBounds(store.require(group.id))).toEqual({ x: 80, y: 80, w: 20, h: 20 });
  });

  it('布尔组可以嵌套', () => {
    const { store, geometry } = setup();
    const outer = boolean(store, 'subtract');
    rect(store, outer.id, 0, 0, 200, 200);
    const inner = store.transact('inner', (tx) =>
      tx.create(
        createNode('boolean', {
          parent: outer.id,
          index: store.indexOnTop(outer.id),
          seq: 2,
          op: 'union',
          fill: null,
          stroke: null,
        }),
      ),
    );
    ellipse(store, inner.id, 50, 50, 40, 40);
    ellipse(store, inner.id, 110, 110, 40, 40);
    const path = geometry.outlineOf(store.require(outer.id));
    expect(path.contains(10, 10)).toBe(true);
    expect(path.contains(70, 70)).toBe(false);
    expect(path.contains(130, 130)).toBe(false);
  });

  it('随机圆与矩形的组合不出现运算失败', () => {
    const { store, geometry } = setup();
    const before = booleanFailures.count;
    let seed = 42;
    const rand = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
    const ops: BooleanOp[] = ['union', 'subtract', 'intersect', 'exclude'];
    for (let i = 0; i < 200; i++) {
      const group = boolean(store, ops[i % 4]!);
      for (let k = 0; k < 3; k++) {
        const make = rand() < 0.5 ? rect : ellipse;
        make(store, group.id, rand() * 100, rand() * 100, 20 + rand() * 120, 20 + rand() * 120);
      }
      geometry.outlineOf(store.require(group.id));
    }
    expect(booleanFailures.count - before).toBe(0);
  });
});

describe('命中测试', () => {
  it('返回最上层被点中的节点', () => {
    const { store, geometry } = setup();
    const bottom = rect(store, store.root.id, 0, 0, 100, 100);
    const top = rect(store, store.root.id, 50, 50, 100, 100);
    const roots = [store.root.id];
    expect(geometry.hitTest(75, 75, roots, 0)?.id).toBe(top.id);
    expect(geometry.hitTest(10, 10, roots, 0)?.id).toBe(bottom.id);
    expect(geometry.hitTest(300, 300, roots, 0)).toBeNull();
  });

  it('椭圆按真实形状命中，而不是外接矩形', () => {
    const { store, geometry } = setup();
    ellipse(store, store.root.id, 0, 0, 100, 100);
    expect(geometry.hitTest(50, 50, [store.root.id], 0)).not.toBeNull();
    expect(geometry.hitTest(3, 3, [store.root.id], 0)).toBeNull();
  });

  it('画板裁剪子节点：超出画板的部分点不中', () => {
    const { store, geometry } = setup();
    const board = store.transact('board', (tx) =>
      tx.create(
        createNode('artboard', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          transform: translation(1000, 0),
          size: [100, 100],
          fill: solid(rgba(1, 1, 1)),
          deck: { order: 'a0', notes: '' },
        }),
      ),
    );
    const child = rect(store, board.id, 50, 50, 200, 200);
    expect(geometry.hitTest(1060, 60, [store.root.id], 0)?.id).toBe(child.id);
    expect(geometry.hitTest(1150, 150, [store.root.id], 0)).toBeNull();
    expect(geometry.hitTest(1010, 10, [store.root.id], 0)?.id).toBe(board.id);
    expect(geometry.worldBounds(store.require(child.id))).toEqual({ x: 1050, y: 50, w: 200, h: 200 });
  });

  it('无填充的形状靠描边和容差命中', () => {
    const { store, geometry } = setup();
    const node = rect(store, store.root.id, 0, 0, 100, 100);
    store.transact('style', (tx) => tx.update(node.id, { fill: null, stroke: { color: rgba(0, 0, 0), width: 2 } }));
    expect(geometry.hitTest(50, 50, [store.root.id], 2)).toBeNull();
    expect(geometry.hitTest(50, 0.5, [store.root.id], 2)?.id).toBe(node.id);
  });

  it('删除节点后缓存被清理，不影响后续查询', () => {
    const { store, geometry } = setup();
    const node = rect(store, store.root.id, 0, 0, 10, 10);
    geometry.outlineOf(node);
    store.transact('rm', (tx) => tx.remove(node.id));
    expect(geometry.hitTest(5, 5, [store.root.id], 0)).toBeNull();
    store.undo();
    expect(geometry.hitTest(5, 5, [store.root.id], 0)?.id).toBe(node.id);
  });
});
