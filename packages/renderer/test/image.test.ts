import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssetStore, DocStore, createNode, type ImageFit, type SceneNode } from '@shiba/core';
import {
  GeometryCache,
  ImageCache,
  NodeTypeRegistry,
  Renderer,
  loadCanvasKit,
  registerBuiltinNodeTypes,
  type Bitmap,
  type CanvasKit,
} from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;
/** 一张 40×20 的测试图：左半红，右半蓝 */
let png: Uint8Array;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
  const surface = ck.MakeSurface(40, 20)!;
  const canvas = surface.getCanvas();
  const paint = new ck.Paint();
  paint.setColor(ck.Color4f(1, 0, 0, 1));
  canvas.drawRect(ck.XYWHRect(0, 0, 20, 20), paint);
  paint.setColor(ck.Color4f(0, 0, 1, 1));
  canvas.drawRect(ck.XYWHRect(20, 0, 20, 20), paint);
  const image = surface.makeImageSnapshot();
  png = image.encodeToBytes()!.slice();
  image.delete();
  paint.delete();
  surface.delete();
});

async function setup() {
  const store = DocStore.create();
  const assets = new AssetStore();
  const registry = registerBuiltinNodeTypes(new NodeTypeRegistry());
  const geometry = new GeometryCache(ck, store, registry);
  const images = new ImageCache(ck, assets);
  // 离屏渲染用不到真正的 canvas 元素
  const renderer = new Renderer(ck, {} as HTMLCanvasElement, store, registry, geometry, images);
  const meta = await assets.add(png, { mime: 'image/png', width: 40, height: 20 });
  return { store, assets, images, renderer, meta };
}

function addShape(
  store: DocStore,
  type: 'rect' | 'ellipse',
  size: [number, number],
  assetId: string,
  fit: ImageFit,
): SceneNode {
  return store.transact('shape', (tx) =>
    tx.create(
      type === 'rect'
        ? createNode('rect', {
            parent: store.root.id,
            index: store.indexOnTop(store.root.id),
            seq: 1,
            size,
            fill: { type: 'image', assetId, fit },
            stroke: null,
            cornerRadius: 0,
          })
        : createNode('ellipse', {
            parent: store.root.id,
            index: store.indexOnTop(store.root.id),
            seq: 1,
            size,
            fill: { type: 'image', assetId, fit },
            stroke: null,
          }),
    ),
  );
}

function pixel(bitmap: Bitmap, x: number, y: number): number[] {
  const i = (y * bitmap.width + x) * 4;
  return [...bitmap.data.slice(i, i + 4)];
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

describe('ImageCache', () => {
  it('能识别图片并读出尺寸；不是图片的字节返回 null', async () => {
    const { images } = await setup();
    expect(images.probe(png)).toEqual({ width: 40, height: 20 });
    expect(images.probe(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });

  it('同一张图只解码一次', async () => {
    const { images, meta } = await setup();
    const first = images.get(meta.id);
    expect(first).not.toBeNull();
    expect(images.get(meta.id)).toBe(first);
    expect(images.get('does-not-exist')).toBeNull();
  });
});

describe('图片填充', () => {
  it('拉伸：图片正好填满形状', async () => {
    const { store, renderer, meta } = await setup();
    const node = addShape(store, 'rect', [80, 80], meta.id, 'stretch');
    const bitmap = renderer.renderToBitmap(node.id, 80, 80)!;
    expect(pixel(bitmap, 20, 40)).toEqual(RED);
    expect(pixel(bitmap, 60, 40)).toEqual(BLUE);
    expect(pixel(bitmap, 20, 5)).toEqual(RED);
    expect(pixel(bitmap, 60, 75)).toEqual(BLUE);
  });

  it('铺满：保持比例，多出来的部分被裁掉', async () => {
    const { store, renderer, meta } = await setup();
    // 40×20 的图铺进 40×40 的方形：放大 2 倍变成 80×40，左右各裁掉 20
    const node = addShape(store, 'rect', [40, 40], meta.id, 'cover');
    const bitmap = renderer.renderToBitmap(node.id, 40, 40)!;
    expect(pixel(bitmap, 5, 20)).toEqual(RED);
    expect(pixel(bitmap, 35, 20)).toEqual(BLUE);
    expect(pixel(bitmap, 5, 2)).toEqual(RED);
    expect(pixel(bitmap, 35, 38)).toEqual(BLUE);
  });

  it('适应：完整显示，留空的地方是透明的', async () => {
    const { store, renderer, meta } = await setup();
    // 40×20 的图放进 40×40 的方形：上下各留 10 的空
    const node = addShape(store, 'rect', [40, 40], meta.id, 'contain');
    const bitmap = renderer.renderToBitmap(node.id, 40, 40)!;
    expect(pixel(bitmap, 10, 20)).toEqual(RED);
    expect(pixel(bitmap, 30, 20)).toEqual(BLUE);
    expect(pixel(bitmap, 10, 3)).toEqual(CLEAR);
    expect(pixel(bitmap, 30, 36)).toEqual(CLEAR);
  });

  it('形状就是图片的蒙版：椭圆的四角是透明的', async () => {
    const { store, renderer, meta } = await setup();
    const node = addShape(store, 'ellipse', [80, 80], meta.id, 'stretch');
    const bitmap = renderer.renderToBitmap(node.id, 80, 80)!;
    expect(pixel(bitmap, 20, 40)).toEqual(RED);
    expect(pixel(bitmap, 60, 40)).toEqual(BLUE);
    expect(pixel(bitmap, 2, 2)).toEqual(CLEAR);
    expect(pixel(bitmap, 77, 77)).toEqual(CLEAR);
  });

  it('不透明度作用在图片上', async () => {
    const { store, renderer, meta } = await setup();
    const node = addShape(store, 'rect', [40, 20], meta.id, 'stretch');
    store.transact('fade', (tx) => tx.update(node.id, { opacity: 0.5 }));
    const [r, g, b, a] = pixel(renderer.renderToBitmap(node.id, 40, 20)!, 10, 10);
    expect([r, g, b]).toEqual([255, 0, 0]);
    expect(a).toBeGreaterThan(120);
    expect(a).toBeLessThan(135);
  });

  it('图片缺失时画占位色，而不是报错或留空', async () => {
    const { store, renderer } = await setup();
    const node = addShape(store, 'rect', [20, 20], 'missing-asset', 'cover');
    const [r, g, b, a] = pixel(renderer.renderToBitmap(node.id, 20, 20)!, 10, 10);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(190);
    expect(Math.abs(r! - g!)).toBeLessThan(8);
    expect(Math.abs(g! - b!)).toBeLessThan(8);
  });
});

describe('导出 PNG', () => {
  it('导出的文件能重新解码，尺寸随倍率变化', async () => {
    const { store, renderer, images, meta } = await setup();
    const node = addShape(store, 'rect', [80, 40], meta.id, 'stretch');
    const once = renderer.renderToPng(node.id, 1)!;
    const twice = renderer.renderToPng(node.id, 2)!;
    expect([...once.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(images.probe(once)).toEqual({ width: 80, height: 40 });
    expect(images.probe(twice)).toEqual({ width: 160, height: 80 });
  });

  it('尺寸超过上限或节点不存在时返回 null', async () => {
    const { store, renderer, meta } = await setup();
    const node = addShape(store, 'rect', [80, 40], meta.id, 'stretch');
    expect(renderer.renderToPng(node.id, 500)).toBeNull();
    expect(renderer.renderToPng('nope', 1)).toBeNull();
  });
});

describe('渐变填充', () => {
  it('线性渐变从起点的颜色过渡到终点的颜色；径向渐变从圆心向外', async () => {
    const { store, renderer } = await setup();
    const stops = [
      { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
    ];
    const linear = store.transact('shape', (tx) =>
      tx.create(
        createNode('rect', {
          parent: store.root.id,
          index: store.indexOnTop(store.root.id),
          seq: 1,
          size: [100, 20],
          fill: { type: 'gradient', kind: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, stops },
          stroke: null,
          cornerRadius: 0,
        }),
      ),
    );
    const bitmap = renderer.renderToBitmap(linear.id, 100, 20)!;
    expect(pixel(bitmap, 0, 10)[0]).toBeGreaterThan(245);
    expect(pixel(bitmap, 99, 10)[2]).toBeGreaterThan(245);
    const middle = pixel(bitmap, 50, 10);
    expect(middle[0]).toBeGreaterThan(110);
    expect(middle[0]).toBeLessThan(145);

    const radial = store.transact('shape', (tx) =>
      tx.create(
        createNode('ellipse', {
          parent: store.root.id,
          index: store.indexOnTop(store.root.id),
          seq: 1,
          size: [40, 40],
          fill: { type: 'gradient', kind: 'radial', start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 }, stops },
          stroke: null,
        }),
      ),
    );
    const disc = renderer.renderToBitmap(radial.id, 40, 40)!;
    expect(pixel(disc, 20, 20)[0]).toBeGreaterThan(240);
    expect(pixel(disc, 37, 20)[2]).toBeGreaterThan(200);
  });
});

describe('蒙版', () => {
  /** 一个蒙版组：下面是 100 × 100 的红色方块，最上面是蒙版 */
  async function masked(mode: 'shape' | 'alpha' | 'luminance', mask: SceneNode) {
    const env = await setup();
    const { store } = env;
    const group = store.transact('group', (tx) =>
      tx.create(
        createNode('group', { parent: store.root.id, index: store.indexOnTop(store.root.id), seq: 1, mask: mode }),
      ),
    );
    store.transact('content', (tx) =>
      tx.create(
        createNode('rect', {
          parent: group.id,
          index: 'a0',
          seq: 1,
          size: [100, 100],
          cornerRadius: 0,
          fill: { type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } },
          stroke: null,
        }),
      ),
    );
    store.transact('mask', (tx) => tx.create({ ...mask, parent: group.id, index: 'a1' } as SceneNode));
    return { ...env, group };
  }
  const shape = (fill: unknown, transform = [1, 0, 0, 1, 0, 0]) =>
    createNode('rect', {
      parent: null,
      index: '',
      seq: 2,
      transform: transform as never,
      size: [100, 100],
      cornerRadius: 0,
      fill: fill as never,
      stroke: null,
    });

  it('形状：按蒙版的轮廓裁剪；组的范围就是蒙版的范围，蒙版外面点不中', async () => {
    const circle = createNode('ellipse', {
      parent: null,
      index: '',
      seq: 2,
      transform: [1, 0, 0, 1, 25, 25],
      size: [50, 50],
      fill: { type: 'solid', color: { r: 0, g: 0, b: 1, a: 1 } },
      stroke: null,
    });
    const { renderer, group, store } = await masked('shape', circle);
    const geometry = (
      renderer as unknown as {
        geometry: { localBounds(n: SceneNode): unknown; hitTest(...a: unknown[]): SceneNode | null };
      }
    ).geometry;
    expect(geometry.localBounds(store.require(group.id))).toEqual({ x: 25, y: 25, w: 50, h: 50 });
    const bitmap = renderer.renderToBitmap(group.id, 50, 50)!;
    // 蒙版的颜色不起作用：裁出来的是红色
    expect(pixel(bitmap, 25, 25)).toEqual(RED);
    expect(pixel(bitmap, 1, 1)).toEqual(CLEAR);
    expect(geometry.hitTest(50, 50, [store.root.id], 0)?.type).toBe('rect');
    expect(geometry.hitTest(5, 5, [store.root.id], 0)).toBeNull();
  });

  it('透明度：蒙版透明的地方内容也透明', async () => {
    const fade = {
      type: 'gradient',
      kind: 'linear',
      start: { x: 0, y: 0.5 },
      end: { x: 1, y: 0.5 },
      stops: [
        { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { offset: 1, color: { r: 0, g: 0, b: 0, a: 0 } },
      ],
    };
    const { renderer, group } = await masked('alpha', shape(fade));
    const bitmap = renderer.renderToBitmap(group.id, 100, 100)!;
    expect(pixel(bitmap, 1, 50)[3]).toBeGreaterThan(240);
    expect(pixel(bitmap, 50, 50)[3]).toBeGreaterThan(100);
    expect(pixel(bitmap, 50, 50)[3]).toBeLessThan(155);
    expect(pixel(bitmap, 98, 50)[3]).toBeLessThan(10);
  });

  it('亮度：蒙版白的地方显示，黑的地方隐藏', async () => {
    const half = {
      type: 'gradient',
      kind: 'linear',
      start: { x: 0, y: 0.5 },
      end: { x: 1, y: 0.5 },
      stops: [
        { offset: 0.5, color: { r: 1, g: 1, b: 1, a: 1 } },
        { offset: 0.5, color: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    };
    const { renderer, group } = await masked('luminance', shape(half));
    const bitmap = renderer.renderToBitmap(group.id, 100, 100)!;
    expect(pixel(bitmap, 20, 50)).toEqual(RED);
    expect(pixel(bitmap, 80, 50)[3]).toBe(0);
  });
});
