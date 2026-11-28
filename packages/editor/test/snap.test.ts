import { describe, expect, it } from 'vitest';
import { buildTargets, measureBetween, snapMove, snapPoint } from '../src/snap';

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe('吸附', () => {
  it('边对边、中线对中线，取最近的那个', () => {
    const targets = buildTargets({ rects: [rect(100, 100, 100, 100)] });
    // 左边 203 离对方的右边 200 差 3
    const hit = snapMove(targets, rect(203, 300, 50, 50), { threshold: 5 });
    expect(hit.dx).toBe(-3);
    expect(hit.dy).toBe(0);
    expect(hit.lines).toEqual([{ axis: 'x', at: 200, from: 100, to: 350 }]);
    // 中线 150 对中线 150
    expect(snapMove(targets, rect(124, 300, 50, 50), { threshold: 5 }).dx).toBe(1);
    // 超出阈值不吸
    expect(snapMove(targets, rect(210, 300, 50, 50), { threshold: 5 }).dx).toBe(0);
  });

  it('只吸允许的方向；取整到像素', () => {
    const targets = buildTargets({ rects: [rect(100, 100, 100, 100)] });
    const hit = snapMove(targets, rect(202, 98, 50, 50), { threshold: 5, axes: { x: false, y: true } });
    expect(hit.dx).toBe(0);
    expect(hit.dy).toBe(2);
    const pixel = snapMove(targets, rect(400.4, 600.6, 10, 10), { threshold: 5, pixels: true });
    expect(pixel.dx).toBeCloseTo(-0.4);
    expect(pixel.dy).toBeCloseTo(0.4);
  });

  it('画板的边、中线和辅助线也能吸', () => {
    const targets = buildTargets({
      rects: [],
      boards: [rect(0, 0, 1000, 600)],
      guides: [{ axis: 'y', value: 250, range: null }],
    });
    const hit = snapMove(targets, rect(473, 252, 50, 40), { threshold: 5 });
    expect(hit.dx).toBe(2); // 中线 500
    expect(hit.dy).toBe(-2); // 辅助线 250
  });

  it('等间距：放在两个邻居正中间，或者接着已有的间距排', () => {
    const targets = buildTargets({ rects: [rect(0, 0, 100, 100), rect(300, 0, 100, 100)] });
    const middle = snapMove(targets, rect(173, 10, 50, 50), { threshold: 5 });
    expect(middle.dx).toBe(2);
    expect(middle.spacing).toHaveLength(2);
    expect(middle.spacing.map((m) => m.end - m.start)).toEqual([75, 75]);

    const row = buildTargets({ rects: [rect(0, 0, 100, 100), rect(140, 0, 100, 100)] });
    // 已有的间距是 40，接着排在 280
    const next = snapMove(row, rect(283, 0, 100, 100), { threshold: 5 });
    expect(next.dx).toBe(-3);
    expect(next.spacing.map((m) => m.end - m.start)).toEqual([40, 40]);
  });

  it('吸一个点：x、y 各自吸', () => {
    const targets = buildTargets({ rects: [rect(100, 100, 100, 100)] });
    const hit = snapPoint(targets, { x: 198, y: 153 }, { threshold: 5 });
    expect(hit.point).toEqual({ x: 200, y: 150 });
    expect(hit.lines).toHaveLength(2);
    expect(snapPoint(targets, { x: 198, y: 153 }, { threshold: 5, axes: { x: true, y: false } }).point).toEqual({
      x: 200,
      y: 153,
    });
  });

  it('一万个对象：收集一次，每次查找很快', () => {
    const rects = Array.from({ length: 10_000 }, (_, i) => rect((i % 100) * 37.3, Math.floor(i / 100) * 41.7, 20, 20));
    const targets = buildTargets({ rects });
    const start = performance.now();
    for (let i = 0; i < 200; i++) snapPoint(targets, { x: i * 13.1, y: i * 7.7 }, { threshold: 2 });
    const perCall = (performance.now() - start) / 200;
    expect(perCall).toBeLessThan(1);
  });
});

describe('测距', () => {
  it('不相交时标出两个方向上的间隔', () => {
    const marks = measureBetween(rect(0, 0, 100, 100), rect(150, 20, 50, 50));
    expect(marks).toEqual([{ axis: 'x', start: 100, end: 150, at: 45 }]);
    const diagonal = measureBetween(rect(0, 0, 100, 100), rect(150, 150, 50, 50));
    expect(diagonal.map((m) => [m.axis, m.end - m.start])).toEqual([
      ['x', 50],
      ['y', 50],
    ]);
  });

  it('在里面时标出到四条边的距离', () => {
    const marks = measureBetween(rect(100, 50, 100, 100), rect(0, 0, 1000, 600));
    expect(marks.map((m) => m.end - m.start)).toEqual([100, 800, 50, 450]);
  });
});
