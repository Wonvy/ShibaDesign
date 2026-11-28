import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssetStore, DocStore, createNode, rgba, solid, translation, type FrameNode } from '@shiba/core';
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

/**
 * 一个 200 × 100 的编组里放一个画框（20,20 起，100 × 60，白底，2 像素黑描边），
 * 画框里一个红色矩形从 (50,10) 起往右伸出画框 80 像素
 */
function scene(frame: Partial<FrameNode> = {}) {
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
  const ids = store.transact('scene', (tx) => {
    const board = tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size: [200, 100],
        fill: solid(rgba(0, 0, 1)),
        deck: null,
      }),
    );
    const node = tx.create(
      createNode('frame', {
        parent: board.id,
        index: 'a0',
        seq: 1,
        transform: translation(20, 20),
        size: [100, 60],
        fill: solid(rgba(1, 1, 1)),
        stroke: { color: rgba(0, 0, 0), width: 2 },
        cornerRadius: 0,
        clip: true,
        ...frame,
      }),
    );
    const child = tx.create(
      createNode('rect', {
        parent: node.id,
        index: 'a0',
        seq: 1,
        transform: translation(50, 10),
        size: [130, 20],
        cornerRadius: 0,
        fill: solid(rgba(1, 0, 0)),
        stroke: null,
      }),
    );
    return { board: board.id, frame: node.id, child: child.id };
  });
  const bitmap = renderer.renderToBitmap(ids.board, 200, 100)!;
  const pixel = (x: number, y: number) => {
    const i = (y * bitmap.width + x) * 4;
    return [bitmap.data[i]!, bitmap.data[i + 1]!, bitmap.data[i + 2]!];
  };
  return { store, geometry, ids, pixel };
}

describe('画框', () => {
  it('先画填充，里面的东西按画框的轮廓裁掉，描边画在里面的东西上面', () => {
    const { pixel } = scene();
    // 画框的白底
    expect(pixel(30, 60)).toEqual([255, 255, 255]);
    // 里面的红色矩形
    expect(pixel(90, 40)).toEqual([255, 0, 0]);
    // 伸出画框的部分被裁掉，露出画板的蓝底
    expect(pixel(160, 40)).toEqual([0, 0, 255]);
    // 画框右边的描边（x = 119..121）盖在红色矩形上面
    expect(pixel(120, 40)).toEqual([0, 0, 0]);
  });

  it('关了裁剪时伸出去的部分也画出来；画出来的范围包括它', () => {
    const { pixel, geometry, store, ids } = scene({ clip: false });
    expect(pixel(160, 40)).toEqual([255, 0, 0]);
    const frame = store.get(ids.frame)!;
    expect(geometry.localBounds(frame)).toEqual({ x: 0, y: 0, w: 100, h: 60 });
    const drawn = geometry.drawnBounds(frame);
    expect(drawn.x + drawn.w).toBeCloseTo(180, 5);
  });

  it('圆角画框按圆角裁剪', () => {
    const { pixel } = scene({ cornerRadius: 20, stroke: null, fill: solid(rgba(0, 1, 0)) });
    // 左上角圆角外面露出画板的蓝底，里面是画框的绿底
    expect(pixel(22, 22)).toEqual([0, 0, 255]);
    expect(pixel(40, 40)).toEqual([0, 255, 0]);
  });

  it('命中：点里面的东西是那个东西，点空白处是画框；裁剪的画框外面点不中伸出去的部分', () => {
    const clipped = scene();
    const roots = [clipped.store.root.id];
    expect(clipped.geometry.hitTest(90, 40, roots, 1)?.id).toBe(clipped.ids.child);
    expect(clipped.geometry.hitTest(30, 60, roots, 1)?.id).toBe(clipped.ids.frame);
    expect(clipped.geometry.hitTest(160, 40, roots, 1)?.id).toBe(clipped.ids.board);

    const open = scene({ clip: false, fill: null });
    expect(open.geometry.hitTest(160, 40, [open.store.root.id], 1)?.id).toBe(open.ids.child);
    // 没有填充也点得中空白处
    expect(open.geometry.hitTest(30, 60, [open.store.root.id], 1)?.id).toBe(open.ids.frame);
  });
});
