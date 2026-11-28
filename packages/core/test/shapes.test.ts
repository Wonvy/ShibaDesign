import { describe, expect, it } from 'vitest';
import {
  DocStore,
  arrowGeometry,
  arrowMetrics,
  createNode,
  hasBoxCorners,
  isEnterable,
  polygonOutline,
  polygonPoints,
  validateDocument,
  type Anchor,
  type Subpath,
} from '../src';

const corner = (x: number, y: number): Anchor => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const line = (x0: number, y0: number, x1: number, y1: number): Subpath => ({
  closed: false,
  anchors: [corner(x0, y0), corner(x1, y1)],
});

describe('箭头的几何', () => {
  it('终点的箭头：尖在端点、方向朝外；实心箭头下面的线缩回去，开口的箭头不缩', () => {
    const triangle = arrowGeometry([line(0, 0, 100, 0)], { width: 2, arrowEnd: 'triangle' })!;
    expect(triangle.arrows).toEqual([{ head: 'triangle', tip: { x: 100, y: 0 }, dir: { x: 1, y: 0 }, width: 2 }]);
    const { trim } = arrowMetrics('triangle', 2);
    expect(trim).toBeGreaterThan(0);
    const end = triangle.line[0]!.anchors[1]!;
    expect(end.x).toBeCloseTo(100 - trim, 1);
    expect(end.y).toBeCloseTo(0, 9);

    const open = arrowGeometry([line(0, 0, 100, 0)], { width: 2, arrowEnd: 'arrow' })!;
    expect(open.line[0]!.anchors[1]!.x).toBe(100);
  });

  it('起点的箭头朝反方向；两头都有时各缩各的', () => {
    const both = arrowGeometry([line(0, 0, 0, 100)], { width: 4, arrowStart: 'circle', arrowEnd: 'square' })!;
    const [end, start] = both.arrows;
    expect(end).toMatchObject({ head: 'square', tip: { x: 0, y: 100 } });
    expect(end!.dir.y).toBeCloseTo(1, 9);
    expect(start).toMatchObject({ head: 'circle', tip: { x: 0, y: 0 } });
    expect(start!.dir.y).toBeCloseTo(-1, 9);
    const [a, b] = both.line[0]!.anchors;
    expect(a!.y).toBeCloseTo(arrowMetrics('circle', 4).trim, 1);
    expect(b!.y).toBeCloseTo(100 - arrowMetrics('square', 4).trim, 1);
  });

  it('曲线的端点按控制柄的方向；缩短后的线还在原来的曲线上', () => {
    // 从 (0,0) 出发，终点 (100,100) 的入控制柄在正上方：箭头朝下
    const curve: Subpath = {
      closed: false,
      anchors: [
        { x: 0, y: 0, inX: 0, inY: 0, outX: 60, outY: 0 },
        { x: 100, y: 100, inX: 100, inY: 40, outX: 100, outY: 100 },
      ],
    };
    const result = arrowGeometry([curve], { width: 2, arrowEnd: 'triangle' })!;
    expect(result.arrows[0]!.dir.x).toBeCloseTo(0, 9);
    expect(result.arrows[0]!.dir.y).toBeCloseTo(1, 9);
    const end = result.line[0]!.anchors[1]!;
    // 缩回去的点离原来的端点大约 trim 远（按弧长量）
    const { trim } = arrowMetrics('triangle', 2);
    expect(Math.hypot(end.x - 100, end.y - 100)).toBeCloseTo(trim, 0);
    expect(end.x).toBeCloseTo(100, 0);
  });

  it('闭合的子路径、或者描边上没有箭头时没有箭头', () => {
    const closed: Subpath = { closed: true, anchors: [corner(0, 0), corner(10, 0), corner(10, 10)] };
    expect(arrowGeometry([closed], { width: 2, arrowEnd: 'arrow' })).toBeNull();
    expect(arrowGeometry([line(0, 0, 10, 0)], { width: 2 })).toBeNull();
  });

  it('箭头大小随线宽变化', () => {
    expect(arrowMetrics('arrow', 4).length).toBeGreaterThan(arrowMetrics('arrow', 1).length);
    expect(arrowMetrics('circle', 4).half).toBeGreaterThan(arrowMetrics('circle', 1).half);
  });
});

describe('多边形和星形', () => {
  it('正多边形的顶点在外框的内切椭圆上，第一个朝上', () => {
    const points = polygonPoints(100, 100, 6);
    expect(points).toHaveLength(6);
    expect(points[0]!.x).toBeCloseTo(50, 9);
    expect(points[0]!.y).toBeCloseTo(0, 9);
    for (const p of points) expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(50, 9);
    // 三角形的底边是水平的
    const tri = polygonPoints(100, 80, 3);
    expect(tri[1]!.y).toBeCloseTo(tri[2]!.y, 9);
  });

  it('星形的外顶点和内顶点交替，内顶点到中心的距离是 innerRatio 倍', () => {
    const points = polygonPoints(200, 200, 5, 0.4);
    expect(points).toHaveLength(10);
    points.forEach((p, i) => {
      expect(Math.hypot(p.x - 100, p.y - 100)).toBeCloseTo(i % 2 === 0 ? 100 : 40, 9);
    });
  });

  it('边数限制在 3 到 60 之间', () => {
    expect(polygonPoints(10, 10, 1)).toHaveLength(3);
    expect(polygonPoints(10, 10, 500)).toHaveLength(60);
  });

  it('轮廓是闭合的；有圆角时每个顶点变成两个锚点', () => {
    const sharp = polygonOutline({ size: [100, 100], sides: 5, cornerRadius: 0 });
    expect(sharp.closed).toBe(true);
    expect(sharp.anchors).toHaveLength(5);
    const round = polygonOutline({ size: [100, 100], sides: 5, cornerRadius: 10 });
    expect(round.anchors).toHaveLength(10);
  });

  it('文件校验：边数、内径、圆角、箭头样式不对时报错', () => {
    const store = DocStore.create();
    store.transact('add', (tx) => {
      tx.create(
        createNode('polygon', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [100, 100],
          sides: 5,
          innerRatio: 0.5,
          cornerRadius: 0,
          fill: null,
          stroke: null,
        }),
      );
      tx.create(
        createNode('path', {
          parent: store.root.id,
          index: 'a1',
          seq: 1,
          size: [100, 0],
          subpaths: [line(0, 0, 100, 0)],
          fillRule: 'nonzero',
          fill: null,
          stroke: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 2, arrowStart: 'bar', arrowEnd: 'arrow' },
        }),
      );
    });
    const good = store.toJSON();
    expect(() => validateDocument(good)).not.toThrow();
    const polygon = Object.values(good.nodes).find((n) => n.type === 'polygon')!;
    const path = Object.values(good.nodes).find((n) => n.type === 'path')!;
    const bad = (node: (typeof good.nodes)[string], patch: Record<string, unknown>) => ({
      ...good,
      nodes: { ...good.nodes, [node.id]: { ...node, ...patch } },
    });
    expect(() => validateDocument(bad(polygon, { sides: 2 }))).toThrow();
    expect(() => validateDocument(bad(polygon, { sides: 61 }))).toThrow();
    expect(() => validateDocument(bad(polygon, { innerRatio: 0 }))).toThrow();
    expect(() => validateDocument(bad(polygon, { innerRatio: 1.5 }))).toThrow();
    expect(() => validateDocument(bad(polygon, { cornerRadius: -1 }))).toThrow();
    const stroke = (path as { stroke: object }).stroke;
    expect(() => validateDocument(bad(path, { stroke: { ...stroke, arrowEnd: 'rocket' } }))).toThrow();
  });
});

describe('画框', () => {
  it('和矩形一样有四个角；能进去选里面的东西；文件校验圆角和裁剪开关', () => {
    const store = DocStore.create();
    const frame = store.transact('add', (tx) =>
      tx.create(
        createNode('frame', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [100, 80],
          fill: null,
          stroke: null,
          cornerRadius: 8,
          cornerRadii: [8, 8, 0, 0],
          clip: true,
        }),
      ),
    );
    expect(hasBoxCorners(frame)).toBe(true);
    expect(isEnterable(frame)).toBe(true);
    expect(isEnterable(store.root)).toBe(false);
    const good = store.toJSON();
    expect(() => validateDocument(good)).not.toThrow();
    const bad = (patch: Record<string, unknown>) => ({
      ...good,
      nodes: { ...good.nodes, [frame.id]: { ...good.nodes[frame.id]!, ...patch } },
    });
    expect(() => validateDocument(bad({ clip: 'yes' }))).toThrow();
    expect(() => validateDocument(bad({ cornerRadius: -2 }))).toThrow();
    expect(() => validateDocument(bad({ cornerRadii: [1, 2, 3] }))).toThrow();
  });
});
