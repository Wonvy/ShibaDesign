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
