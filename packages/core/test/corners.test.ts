import { describe, expect, it } from 'vitest';
import {
  canRoundAnchor,
  rectCornerRadii,
  rectNeedsCorners,
  rectOutline,
  roundPolygon,
  roundSubpaths,
  validateDocument,
  DocStore,
  createNode,
  type Anchor,
  type Subpath,
} from '../src';

const square = (r: number) => [
  { x: 0, y: 0, radius: r },
  { x: 100, y: 0, radius: r },
  { x: 100, y: 100, radius: r },
  { x: 0, y: 100, radius: r },
];

function expectPoint(a: { x: number; y: number }, x: number, y: number): void {
  expect(a.x).toBeCloseTo(x, 9);
  expect(a.y).toBeCloseTo(y, 9);
}

/** 一段三次曲线上 t 处的点 */
function bezier(a: Anchor, b: Anchor, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * a.outX + 3 * u * t * t * b.inX + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * a.outY + 3 * u * t * t * b.inY + t * t * t * b.y,
  };
}

describe('顶点圆角', () => {
  it('圆角：每个角两个切点，曲线贴着圆弧（误差很小）', () => {
    const sub = roundPolygon(square(20), true);
    expect(sub.anchors).toHaveLength(8);
    const [t1, t2] = sub.anchors as [Anchor, Anchor];
    // 左上角：切点在两条边上离顶点 20 的地方
    expectPoint(t1, 0, 20);
    expectPoint(t2, 20, 0);
    // 曲线上每个点到圆心 (20, 20) 的距离都接近 20
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const p = bezier(t1, t2, t);
      expect(Math.abs(Math.hypot(p.x - 20, p.y - 20) - 20)).toBeLessThan(0.006);
    }
  });

  it('半径太大时按边长收小；相邻的角按比例分', () => {
    const sub = roundPolygon(square(80), true);
    const [t1, t2] = sub.anchors as [Anchor, Anchor];
    expectPoint(t1, 0, 50);
    expectPoint(t2, 50, 0);
    // 左上 60、右上 20：上边 100 够用，各用各的
    const mixed = rectOutline(100, 100, [60, 20, 0, 0]);
    expectPoint(mixed.anchors[1]!, 60, 0);
    expectPoint(mixed.anchors[2]!, 80, 0);
  });

  it('倒角是直线；反向圆角往里凹；四个角不一样时右下没有圆角', () => {
    const chamfer = roundPolygon(square(20), true, { style: 'chamfer' });
    expect(chamfer.anchors.every((a) => a.inX === a.x && a.outX === a.x && a.inY === a.y && a.outY === a.y)).toBe(true);
    const inverted = roundPolygon(square(20), true, { style: 'inverted' });
    const [i1, i2] = inverted.anchors as [Anchor, Anchor];
    const mid = bezier(i1, i2, 0.5);
    // 凹进去：中点离左上角顶点 (0, 0) 的距离接近 20，比切点连线的中点（约 14.1）远
    expect(Math.hypot(mid.x, mid.y)).toBeCloseTo(20, 1);
    const rect = rectOutline(200, 100, [10, 10, 0, 10]);
    expect(rect.anchors).toHaveLength(7);
  });

  it('平滑度把切点往外推，0 时和普通圆角一样', () => {
    expect(roundPolygon(square(20), true, { smoothing: 0 })).toEqual(roundPolygon(square(20), true));
    const smooth = roundPolygon(square(20), true, { smoothing: 0.6 });
    expectPoint(smooth.anchors[0]!, 0, 32);
  });

  it('矩形什么时候要按这里的算法生成', () => {
    const base = { cornerRadius: 8 };
    expect(rectNeedsCorners(base)).toBe(false);
    expect(rectNeedsCorners({ ...base, cornerRadii: [8, 8, 8, 8] })).toBe(false);
    expect(rectNeedsCorners({ ...base, cornerRadii: [8, 0, 8, 8] })).toBe(true);
    expect(rectNeedsCorners({ ...base, cornerStyle: 'chamfer' })).toBe(true);
    expect(rectNeedsCorners({ ...base, cornerSmoothing: 0.5 })).toBe(true);
    expect(rectNeedsCorners({ cornerRadius: 0, cornerStyle: 'chamfer' })).toBe(false);
    expect(rectCornerRadii({ cornerRadius: 3 })).toEqual([3, 3, 3, 3]);
  });

  it('路径：只有两边都是直线的尖角能圆；带曲线的子路径里其他锚点原样保留', () => {
    const corner = (x: number, y: number, radius?: number): Anchor => ({
      x,
      y,
      inX: x,
      inY: y,
      outX: x,
      outY: y,
      radius,
    });
    const open: Subpath = { closed: false, anchors: [corner(0, 0), corner(100, 0, 10), corner(100, 100)] };
    expect(canRoundAnchor(open, 0)).toBe(false);
    expect(canRoundAnchor(open, 1)).toBe(true);
    const rounded = roundSubpaths([open])[0]!;
    expect(rounded.anchors).toHaveLength(4);
    expectPoint(rounded.anchors[1]!, 90, 0);

    const curvy: Subpath = {
      closed: false,
      anchors: [corner(0, 0), corner(100, 0, 10), { x: 100, y: 100, inX: 150, inY: 50, outX: 100, outY: 100 }],
    };
    // 第二段是曲线：中间那个锚点的后一条边不是直线，不圆
    expect(canRoundAnchor(curvy, 1)).toBe(false);
    expect(roundSubpaths([curvy])[0]!.anchors).toHaveLength(3);
  });

  it('文件校验：圆角的字段', () => {
    const store = DocStore.create();
    store.transact('rect', (tx) =>
      tx.create(
        createNode('rect', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [10, 10],
          cornerRadius: 0,
          cornerRadii: [1, 2, 3, 4],
          cornerStyle: 'inverted',
          cornerSmoothing: 0.5,
          fill: null,
          stroke: null,
        }),
      ),
    );
    const good = store.toJSON();
    expect(() => validateDocument(good)).not.toThrow();
    const rect = Object.values(good.nodes).find((n) => n.type === 'rect')!;
    const bad = (patch: Record<string, unknown>) => ({
      ...good,
      nodes: { ...good.nodes, [rect.id]: { ...rect, ...patch } },
    });
    expect(() => validateDocument(bad({ cornerRadii: [1, 2, 3] }))).toThrow();
    expect(() => validateDocument(bad({ cornerRadii: [1, 2, 3, -1] }))).toThrow();
    expect(() => validateDocument(bad({ cornerStyle: 'wavy' }))).toThrow();
    expect(() => validateDocument(bad({ cornerSmoothing: 2 }))).toThrow();
  });
});
