import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssetStore, DocStore, createNode, rgba, type Stroke } from '@shiba/core';
import {
  GeometryCache,
  ImageCache,
  NodeTypeRegistry,
  Renderer,
  loadCanvasKit,
  registerBuiltinNodeTypes,
  type CanvasKit,
} from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

/** 画一条只有描边的横线（宽 200 的矩形的上边），返回上边那一行像素是不是画上了 */
function topEdge(stroke: Stroke): boolean[] {
  const store = DocStore.create();
  const registry = registerBuiltinNodeTypes(new NodeTypeRegistry());
  const geometry = new GeometryCache(ck, store, registry);
  const renderer = new Renderer(
    ck,
    {} as HTMLCanvasElement,
    store,
    registry,
    geometry,
    new ImageCache(ck, new AssetStore()),
  );
  const node = store.transact('rect', (tx) =>
    tx.create(
      createNode('rect', {
        parent: store.root.id,
        index: store.indexOnTop(store.root.id),
        seq: 1,
        size: [200, 40],
        cornerRadius: 0,
        fill: null,
        stroke,
      }),
    ),
  );
  const bitmap = renderer.renderToBitmap(node.id, 200, 40)!;
  const row: boolean[] = [];
  // 第 1 行在描边里（描边居中，线宽 4，上下各占 2）
  for (let x = 0; x < bitmap.width; x++) row.push(bitmap.data[(1 * bitmap.width + x) * 4 + 3]! > 128);
  return row;
}

describe('虚线描边', () => {
  const black = rgba(0, 0, 0);

  it('按间隔一段画一段不画；实线整行都画', () => {
    const solid = topEdge({ color: black, width: 4 });
    expect(solid.slice(5, 195).every(Boolean)).toBe(true);
    const dashed = topEdge({ color: black, width: 4, dash: [20, 20] });
    expect(dashed[10]).toBe(true);
    expect(dashed[30]).toBe(false);
    expect(dashed[50]).toBe(true);
    // 起始偏移把虚线往前错开
    const shifted = topEdge({ color: black, width: 4, dash: [20, 20], dashOffset: 20 });
    expect(shifted[10]).toBe(false);
    expect(shifted[30]).toBe(true);
  });

  it('点线是长度为 0 的实线段加圆头，画出一串圆点', () => {
    const dots = topEdge({ color: black, width: 4, dash: [0, 10], cap: 'round' });
    expect(dots[10]).toBe(true);
    expect(dots[15]).toBe(false);
    expect(dots[20]).toBe(true);
    // 平头的话，长度为 0 的线段什么都不画
    expect(
      topEdge({ color: black, width: 4, dash: [0, 10] })
        .slice(5, 195)
        .some(Boolean),
    ).toBe(false);
  });
});

describe('箭头', () => {
  /** 一条折线：从 (0,0) 往右到 (200,0)，再往下到 (200,100)；终点朝下 */
  function elbow(stroke: Stroke) {
    const store = DocStore.create();
    const registry = registerBuiltinNodeTypes(new NodeTypeRegistry());
    const geometry = new GeometryCache(ck, store, registry);
    const renderer = new Renderer(
      ck,
      {} as HTMLCanvasElement,
      store,
      registry,
      geometry,
      new ImageCache(ck, new AssetStore()),
    );
    const corner = (x: number, y: number) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
    const node = store.transact('path', (tx) =>
      tx.create(
        createNode('path', {
          parent: store.root.id,
          index: store.indexOnTop(store.root.id),
          seq: 1,
          size: [200, 100],
          subpaths: [{ closed: false, anchors: [corner(0, 0), corner(200, 0), corner(200, 100)] }],
          fillRule: 'nonzero',
          fill: null,
          stroke,
        }),
      ),
    );
    const bitmap = renderer.renderToBitmap(node.id, 200, 100)!;
    const painted = (x: number, y: number) => bitmap.data[(y * bitmap.width + x) * 4 + 3]! > 128;
    return { painted, bounds: geometry.drawnBounds(node) };
  }

  it('实心三角箭头画在终点，比线宽；线在箭头下面缩回去，箭头的尖还在端点上', () => {
    const black = rgba(0, 0, 0);
    // (196, 90)：在线（x 198 到 202）的左边；箭头离尖 10 像素的地方宽到 ±5.5，盖得到
    expect(elbow({ color: black, width: 4 }).painted(196, 90)).toBe(false);
    const arrow = elbow({ color: black, width: 4, arrowEnd: 'triangle' });
    expect(arrow.painted(196, 90)).toBe(true);
    expect(arrow.painted(199, 98)).toBe(true);
    // 起点没有箭头，线还是原来的粗细
    expect(arrow.painted(10, 1)).toBe(true);
    expect(arrow.painted(10, 6)).toBe(false);
  });

  it('画出来的范围包括伸出外框的箭头', () => {
    const black = rgba(0, 0, 0);
    const plain = elbow({ color: black, width: 4 }).bounds;
    const arrow = elbow({ color: black, width: 4, arrowStart: 'circle', arrowEnd: 'triangle' }).bounds;
    // 三角箭头半宽 11，伸到 x = 211；起点的圆半径 7.9，伸到 y = -7.9
    expect(arrow.x + arrow.w).toBeGreaterThan(plain.x + plain.w + 5);
    expect(arrow.y).toBeLessThan(plain.y - 4);
  });
});
