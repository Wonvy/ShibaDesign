import { describe, expect, it } from 'vitest';
import {
  DocStore,
  align,
  applyToPoint,
  cloneSubtree,
  createNode,
  distribute,
  invert,
  multiply,
  parseHex,
  rgba,
  slides,
  solid,
  toHex,
  transformRect,
  translation,
  worldTransform,
  type Box,
  type Matrix,
  type RectNode,
} from '../src';

function addRect(store: DocStore, parent: string, x: number, y: number, w = 10, h = 10): RectNode {
  return store.transact('add', (tx) =>
    tx.create(
      createNode('rect', {
        parent,
        index: store.indexOnTop(parent),
        seq: 1,
        transform: translation(x, y),
        size: [w, h],
        fill: solid(rgba(1, 0, 0)),
        stroke: null,
        cornerRadius: 0,
      }),
    ),
  );
}

describe('matrix', () => {
  it('multiply 先应用右边的矩阵', () => {
    const scaleThenMove = multiply(translation(10, 0), [2, 0, 0, 2, 0, 0]);
    expect(applyToPoint(scaleThenMove, 1, 1)).toEqual([12, 2]);
  });

  it('invert 能还原一个点', () => {
    const m: Matrix = [2, 0.5, -0.3, 1.5, 40, -7];
    const inv = invert(m)!;
    const [x, y] = applyToPoint(inv, ...applyToPoint(m, 3, 4));
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(4);
  });

  it('不可逆矩阵返回 null', () => {
    expect(invert([1, 2, 2, 4, 0, 0])).toBeNull();
  });

  it('transformRect 给出旋转后的外接矩形', () => {
    const rot90: Matrix = [0, 1, -1, 0, 0, 0];
    expect(transformRect(rot90, { x: 0, y: 0, w: 10, h: 20 })).toEqual({ x: -20, y: 0, w: 20, h: 10 });
  });
});

describe('DocStore', () => {
  it('创建、修改、删除都能撤销和重做', () => {
    const store = DocStore.create();
    const rect = addRect(store, store.root.id, 5, 5);
    store.transact('move', (tx) => tx.update(rect.id, { transform: translation(50, 60) }));
    store.transact('delete', (tx) => tx.remove(rect.id));
    expect(store.has(rect.id)).toBe(false);

    store.undo();
    expect(store.require(rect.id).transform).toEqual(translation(50, 60));
    store.undo();
    expect(store.require(rect.id).transform).toEqual(translation(5, 5));
    store.undo();
    expect(store.has(rect.id)).toBe(false);
    expect(store.canUndo).toBe(false);

    store.redo();
    store.redo();
    expect(store.require(rect.id).transform).toEqual(translation(50, 60));
  });

  it('放弃一段还没结束的连续操作：撤回、不留在撤销和重做里', () => {
    const store = DocStore.create();
    const rect = addRect(store, store.root.id, 0, 0);
    store.sealHistory();
    for (let i = 1; i <= 3; i++) {
      store.transact('drag', (tx) => tx.update(rect.id, { transform: translation(i * 10, 0) }), { mergeKey: 'drag' });
    }
    const sources: string[] = [];
    store.subscribe((change) => sources.push(change.source));
    expect(store.abandon('drag')).toBe(true);
    expect(store.require(rect.id).transform).toEqual(translation(0, 0));
    expect(store.canRedo).toBe(false);
    expect(sources).toEqual(['abandon']);
    // 撤销的是创建矩形那一步，拖动那一步已经没了
    store.undo();
    expect(store.has(rect.id)).toBe(false);
  });

  it('合并键对不上、或者已经封口时不放弃', () => {
    const store = DocStore.create();
    const rect = addRect(store, store.root.id, 0, 0);
    store.sealHistory();
    store.transact('drag', (tx) => tx.update(rect.id, { transform: translation(10, 0) }), { mergeKey: 'drag' });
    expect(store.abandon('other')).toBe(false);
    store.sealHistory();
    expect(store.abandon('drag')).toBe(false);
    expect(store.require(rect.id).transform).toEqual(translation(10, 0));
  });

  it('相同 mergeKey 的连续事务合并为一步撤销', () => {
    const store = DocStore.create();
    const rect = addRect(store, store.root.id, 0, 0);
    store.sealHistory();
    for (let i = 1; i <= 5; i++) {
      store.transact('drag', (tx) => tx.update(rect.id, { transform: translation(i * 10, 0) }), { mergeKey: 'drag' });
    }
    store.sealHistory();
    store.transact('drag', (tx) => tx.update(rect.id, { transform: translation(99, 0) }), { mergeKey: 'drag' });

    store.undo();
    expect(store.require(rect.id).transform).toEqual(translation(50, 0));
    store.undo();
    expect(store.require(rect.id).transform).toEqual(translation(0, 0));
  });

  it('事务抛错时全部回滚', () => {
    const store = DocStore.create();
    const rect = addRect(store, store.root.id, 0, 0);
    expect(() =>
      store.transact('bad', (tx) => {
        tx.update(rect.id, { opacity: 0.2 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.require(rect.id).opacity).toBe(1);
  });

  it('删除父节点会连带删除后代，撤销后全部回来', () => {
    const store = DocStore.create();
    const board = store.transact('board', (tx) =>
      tx.create(
        createNode('artboard', {
          parent: store.root.id,
          index: store.indexOnTop(store.root.id),
          seq: 1,
          size: [100, 100],
          fill: null,
          deck: { order: 'a0', notes: '' },
        }),
      ),
    );
    const child = addRect(store, board.id, 1, 1);
    store.transact('rm', (tx) => tx.remove(board.id));
    expect(store.has(child.id)).toBe(false);
    store.undo();
    expect(store.children(board.id).map((n) => n.id)).toEqual([child.id]);
  });

  it('children 按索引从下到上排序', () => {
    const store = DocStore.create();
    const a = addRect(store, store.root.id, 0, 0);
    const b = addRect(store, store.root.id, 0, 0);
    const c = addRect(store, store.root.id, 0, 0);
    expect(store.children(store.root.id).map((n) => n.id)).toEqual([a.id, b.id, c.id]);
  });

  it('toJSON / fromJSON 往返后内容一致', () => {
    const store = DocStore.create();
    addRect(store, store.root.id, 3, 4);
    const copy = DocStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
    expect(copy.toJSON()).toEqual(store.toJSON());
  });

  it('拒绝无效文档', () => {
    expect(() => DocStore.fromJSON({ version: 1, rootId: 'x', nodes: {} })).toThrow();
  });
});

describe('tree', () => {
  it('worldTransform 逐级叠加父节点的变换', () => {
    const store = DocStore.create();
    const board = store.transact('board', (tx) =>
      tx.create(
        createNode('artboard', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          transform: translation(100, 200),
          size: [500, 500],
          fill: null,
          deck: { order: 'a1', notes: '' },
        }),
      ),
    );
    const rect = addRect(store, board.id, 10, 20);
    expect(applyToPoint(worldTransform(store, rect.id), 0, 0)).toEqual([110, 220]);
    expect(slides(store).map((s) => s.id)).toEqual([board.id]);
  });

  it('cloneSubtree 换新 id，并按选项保留 lineageId', () => {
    const store = DocStore.create();
    const board = store.transact('board', (tx) =>
      tx.create(
        createNode('artboard', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [10, 10],
          fill: null,
          deck: null,
        }),
      ),
    );
    const rect = addRect(store, board.id, 0, 0);
    const kept = cloneSubtree(store, board.id, { keepLineage: true });
    expect(kept).toHaveLength(2);
    expect(kept[0]!.id).not.toBe(board.id);
    expect(kept[1]!.parent).toBe(kept[0]!.id);
    expect(kept[1]!.lineageId).toBe(rect.lineageId);
    const fresh = cloneSubtree(store, board.id, { keepLineage: false });
    expect(fresh[1]!.lineageId).not.toBe(rect.lineageId);
  });
});

describe('align / distribute', () => {
  const boxes: Box[] = [
    { id: 'a', x: 0, y: 0, w: 10, h: 10 },
    { id: 'b', x: 30, y: 50, w: 20, h: 20 },
    { id: 'c', x: 100, y: 20, w: 10, h: 40 },
  ];
  const ref = { x: 0, y: 0, w: 110, h: 70 };

  it('六种对齐', () => {
    expect(align(boxes, 'left', ref).map((d) => d.dx)).toEqual([0, -30, -100]);
    expect(align(boxes, 'right', ref).map((d) => d.dx)).toEqual([100, 60, 0]);
    expect(align(boxes, 'hcenter', ref).map((d) => d.dx)).toEqual([50, 15, -50]);
    expect(align(boxes, 'top', ref).map((d) => d.dy)).toEqual([0, -50, -20]);
    expect(align(boxes, 'bottom', ref).map((d) => d.dy)).toEqual([60, 0, 10]);
    expect(align(boxes, 'vcenter', ref).map((d) => d.dy)).toEqual([30, -25, -5]);
  });

  it('等间距分布：两端不动，空隙相等', () => {
    const deltas = distribute(boxes, 'hspacing');
    expect(deltas).toEqual([
      { id: 'a', dx: 0, dy: 0 },
      { id: 'b', dx: 15, dy: 0 },
      { id: 'c', dx: 0, dy: 0 },
    ]);
    // 移动后：a 占 0–10，b 占 45–65，c 占 100–110，两段空隙都是 35
  });

  it('按中心分布：中心距相等', () => {
    const deltas = distribute(boxes, 'vcenters');
    // 中心 y 为 5、60、40；排序后是 a(5)、c(40)、b(60)，c 应移到 32.5
    expect(deltas.find((d) => d.id === 'c')!.dy).toBeCloseTo(-7.5);
    expect(deltas.find((d) => d.id === 'a')!.dy).toBe(0);
    expect(deltas.find((d) => d.id === 'b')!.dy).toBe(0);
  });

  it('少于三个对象时不移动', () => {
    expect(distribute(boxes.slice(0, 2), 'hspacing').every((d) => d.dx === 0 && d.dy === 0)).toBe(true);
  });
});

describe('color', () => {
  it('解析并输出十六进制颜色', () => {
    expect(toHex(parseHex('#f80')!)).toBe('#ff8800');
    expect(parseHex('#11223380')!.a).toBeCloseTo(0.5, 1);
    expect(parseHex('nope')).toBeNull();
  });
});

describe('撤销历史的清理', () => {
  it('同一个合并键下新建又删掉，不留下空的撤销步骤', () => {
    const store = DocStore.create();
    const kept = addRect(store, store.root.id, 0, 0);
    store.sealHistory();
    const temp = store.transact(
      'create',
      (tx) =>
        tx.create(
          createNode('rect', {
            parent: store.root.id,
            index: store.indexOnTop(store.root.id),
            seq: 2,
            size: [1, 1],
            fill: null,
            stroke: null,
            cornerRadius: 0,
          }),
        ),
      { mergeKey: 'session' },
    );
    store.transact('remove', (tx) => tx.remove(temp.id), { mergeKey: 'session' });
    expect(store.has(temp.id)).toBe(false);
    // 这一步撤销应该直接撤掉更早的那次创建，而不是一个什么都不做的空步骤
    store.undo();
    expect(store.has(kept.id)).toBe(false);
  });
});
