import { describe, expect, it } from 'vitest';
import { DocStore, constrainAxis, createNode, isConstraints, validateDocument } from '../src';

describe('约束', () => {
  // 容器从 100 变成 160，对象在 20 的位置、长 30（右边距 50，中心比容器中心偏左 15）
  it('靠起点不动，靠终点保持右边距，两头都靠保持两边的距离，居中保持离中心的距离，按比例一起乘', () => {
    expect(constrainAxis('left', 20, 30, 100, 160)).toEqual({ start: 20, length: 30 });
    expect(constrainAxis('right', 20, 30, 100, 160)).toEqual({ start: 80, length: 30 });
    expect(constrainAxis('leftRight', 20, 30, 100, 160)).toEqual({ start: 20, length: 90 });
    expect(constrainAxis('center', 20, 30, 100, 160)).toEqual({ start: 50, length: 30 });
    expect(constrainAxis('scale', 20, 30, 100, 160)).toEqual({ start: 32, length: 48 });
    expect(constrainAxis('bottom', 20, 30, 100, 160)).toEqual({ start: 80, length: 30 });
    expect(constrainAxis('topBottom', 20, 30, 100, 160)).toEqual({ start: 20, length: 90 });
  });

  it('两头都靠时容器缩得比两边的距离还小，长度至少 1', () => {
    expect(constrainAxis('leftRight', 20, 30, 100, 40).length).toBe(1);
  });

  it('文件校验：两个方向都要是认识的值', () => {
    expect(isConstraints({ h: 'right', v: 'center' })).toBe(true);
    expect(isConstraints({ h: 'top', v: 'center' })).toBe(false);
    expect(isConstraints({ h: 'left' })).toBe(false);
    const store = DocStore.create();
    const rect = store.transact('add', (tx) =>
      tx.create(
        createNode('rect', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [10, 10],
          cornerRadius: 0,
          fill: null,
          stroke: null,
          constraints: { h: 'scale', v: 'bottom' },
        }),
      ),
    );
    const good = store.toJSON();
    expect(() => validateDocument(good)).not.toThrow();
    const bad = { ...good, nodes: { ...good.nodes, [rect.id]: { ...rect, constraints: { h: 'up', v: 'top' } } } };
    expect(() => validateDocument(bad)).toThrow();
  });
});
