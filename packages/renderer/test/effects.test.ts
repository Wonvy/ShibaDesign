import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssetStore, DocStore, createNode, rgba, solid, translation, type Effect } from '@shiba/core';
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
 * 200 × 200 的白色画板，中间 (60,60) 起一个 80 × 80 的矩形（默认红色），带着给定的效果。
 * 画板左半边有一条黑白相间的竖条纹，背景模糊时看它被糊成灰色
 */
function render(effects: Effect[], options: { fill?: [number, number, number, number]; stripes?: boolean } = {}) {
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
        size: [200, 200],
        fill: solid(rgba(1, 1, 1)),
        deck: null,
      }),
    );
    if (options.stripes) {
      for (let i = 0; i < 25; i++) {
        tx.create(
          createNode('rect', {
            parent: board.id,
            index: `a${String(i).padStart(2, '0')}`,
            seq: i + 2,
            transform: translation(i * 8, 0),
            size: [4, 200],
            cornerRadius: 0,
            fill: solid(rgba(0, 0, 0)),
            stroke: null,
          }),
        );
      }
    }
    const [r, g, b, a] = options.fill ?? [1, 0, 0, 1];
    const rect = tx.create(
      createNode('rect', {
        parent: board.id,
        index: 'b0',
        seq: 1,
        transform: translation(60, 60),
        size: [80, 80],
        cornerRadius: 0,
        fill: solid(rgba(r, g, b, a)),
        stroke: null,
        effects,
      }),
    );
    return { board: board.id, rect: rect.id };
  });
  const bitmap = renderer.renderToBitmap(ids.board, 200, 200)!;
  const pixel = (x: number, y: number) => {
    const i = (y * bitmap.width + x) * 4;
    return [bitmap.data[i]!, bitmap.data[i + 1]!, bitmap.data[i + 2]!];
  };
  return { pixel, geometry, store, renderer, ids };
}

const shadow = (patch: Partial<Effect> = {}): Effect =>
  ({ type: 'dropShadow', color: rgba(0, 0, 0, 1), x: 10, y: 10, blur: 0, spread: 0, ...patch }) as Effect;

describe('效果', () => {
  it('投影：在偏移的位置画出阴影，盖在下面，不影响对象本身', () => {
    const { pixel } = render([shadow()]);
    expect(pixel(100, 100)).toEqual([255, 0, 0]);
    // 矩形右下方 10 像素的地方是黑色的阴影
    expect(pixel(145, 145)).toEqual([0, 0, 0]);
    // 左上方没有阴影
    expect(pixel(55, 55)).toEqual([255, 255, 255]);
  });

  it('投影的扩展让阴影变大，模糊让边缘变软', () => {
    const spread = render([shadow({ x: 0, y: 0, spread: 6 })]);
    expect(spread.pixel(144, 100)).toEqual([0, 0, 0]);
    expect(spread.pixel(148, 100)).toEqual([255, 255, 255]);
    const soft = render([shadow({ x: 0, y: 0, blur: 20 })]);
    // 边缘外 5 像素是半灰，外 25 像素基本没有
    const near = soft.pixel(145, 100)[0]!;
    expect(near).toBeGreaterThan(60);
    expect(near).toBeLessThan(250);
    expect(soft.pixel(170, 100)[0]).toBeGreaterThan(245);
  });

  it('内阴影：只画在形状里面，靠偏移那一边的边缘变暗，中间不变', () => {
    const { pixel } = render([{ type: 'innerShadow', color: rgba(0, 0, 0, 1), x: 8, y: 8, blur: 0, spread: 0 }], {
      fill: [1, 1, 0, 1],
    });
    // 左上边缘内侧（离边 4 像素）是阴影
    expect(pixel(64, 100)).toEqual([0, 0, 0]);
    expect(pixel(100, 64)).toEqual([0, 0, 0]);
    // 中间和右下边缘内侧还是黄色
    expect(pixel(100, 100)).toEqual([255, 255, 0]);
    expect(pixel(136, 136)).toEqual([255, 255, 0]);
    // 形状外面不画
    expect(pixel(55, 100)).toEqual([255, 255, 255]);
  });

  it('图层模糊把对象整个糊开', () => {
    const { pixel } = render([{ type: 'layerBlur', radius: 16 }]);
    const edge = pixel(60, 100);
    expect(edge[1]).toBeGreaterThan(40);
    expect(edge[1]).toBeLessThan(220);
    expect(pixel(100, 100)).toEqual([255, 0, 0]);
  });

  it('背景模糊把对象下面的条纹糊成灰色，对象外面的条纹不变', () => {
    const plain = render([], { fill: [1, 1, 1, 0], stripes: true });
    expect(plain.pixel(81, 100)).toEqual([0, 0, 0]);
    const blurred = render([{ type: 'backgroundBlur', radius: 16 }], { fill: [1, 1, 1, 0], stripes: true });
    const gray = blurred.pixel(81, 100)[0]!;
    expect(gray).toBeGreaterThan(80);
    expect(gray).toBeLessThan(200);
    expect(blurred.pixel(41, 100)).toEqual([0, 0, 0]);
  });

  it('关掉的效果不画；画出来的范围包括投影和图层模糊', () => {
    const off = render([shadow({ hidden: true })]);
    expect(off.pixel(145, 145)).toEqual([255, 255, 255]);
    const on = render([shadow({ x: 10, y: 20, blur: 4, spread: 2 })]);
    const bounds = on.geometry.drawnBounds(on.store.get(on.ids.rect)!);
    // 右边：偏移 10 + 扩展 2 + 3σ(=6) = 18
    expect(bounds.x).toBeCloseTo(0, 9);
    expect(bounds.x + bounds.w).toBeCloseTo(98, 9);
    expect(bounds.y + bounds.h).toBeCloseTo(108, 9);
  });

  it('导出 PDF 用的分部分画：below 只有投影，above 只有内阴影，都不含对象本身', () => {
    const { renderer, ids } = render([
      shadow(),
      { type: 'innerShadow', color: rgba(0, 0, 1, 1), x: 8, y: 8, blur: 0, spread: 0 },
    ]);
    const area = { x: -10, y: -10, w: 120, h: 120 };
    const decode = (png: Uint8Array) => {
      const image = ck.MakeImageFromEncoded(png)!;
      const pixels = image.readPixels(0, 0, {
        width: image.width(),
        height: image.height(),
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      }) as Uint8Array;
      const w = image.width();
      image.delete();
      return (x: number, y: number) => [...pixels.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
    };
    const below = decode(renderer.renderEffectsToPng(ids.rect, 'below', 1, area)!);
    // 阴影在 (95,95)（本地坐标 85,85 加上 10 的留边），中间没有对象本身
    expect(below(95, 95)[3]).toBe(255);
    expect(below(50, 50)).toEqual([0, 0, 0, 255]);
    expect(below(12, 12)[3]).toBe(0);
    const above = decode(renderer.renderEffectsToPng(ids.rect, 'above', 1, area)!);
    expect(above(14, 50)).toEqual([0, 0, 255, 255]);
    expect(above(50, 50)[3]).toBe(0);
  });
});
