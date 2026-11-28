import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssetStore, DocStore, createNode, validateDocument, type ImageFill } from '@shiba/core';
import {
  GeometryCache,
  ImageCache,
  NodeTypeRegistry,
  Renderer,
  loadCanvasKit,
  lookPlan,
  registerBuiltinNodeTypes,
  type Bitmap,
  type CanvasKit,
} from '../src';
import { bakeImage } from '../src/bake';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

const p = (x: number, y: number) => ({ x, y });

/** 按每一列的颜色造一张图：columns[i] 是第 i 列（宽 width 像素）的 RGB，0–255 */
function makePng(columns: [number, number, number][], width = 1, height = 4): Uint8Array {
  const surface = ck.MakeSurface(columns.length * width, height)!;
  const canvas = surface.getCanvas();
  const paint = new ck.Paint();
  columns.forEach(([r, g, b], i) => {
    paint.setColor(ck.Color4f(r / 255, g / 255, b / 255, 1));
    canvas.drawRect(ck.XYWHRect(i * width, 0, width, height), paint);
  });
  const image = surface.makeImageSnapshot();
  const bytes = image.encodeToBytes()!.slice();
  image.delete();
  paint.delete();
  surface.delete();
  return bytes;
}

async function setup(png: Uint8Array, size: [number, number], fill: Partial<ImageFill>) {
  const store = DocStore.create();
  const assets = new AssetStore();
  const registry = registerBuiltinNodeTypes(new NodeTypeRegistry());
  const geometry = new GeometryCache(ck, store, registry);
  const images = new ImageCache(ck, assets);
  const renderer = new Renderer(ck, {} as HTMLCanvasElement, store, registry, geometry, images);
  const meta = await assets.add(png, { mime: 'image/png', width: size[0], height: size[1] });
  const imageFill: ImageFill = { type: 'image', assetId: meta.id, fit: 'stretch', ...fill };
  const node = store.transact('rect', (tx) =>
    tx.create(
      createNode('rect', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size,
        fill: imageFill,
        stroke: null,
        cornerRadius: 0,
      }),
    ),
  );
  return { renderer, images, node, fill: imageFill, meta };
}

/** 图片按 1:1 铺进同样大小的矩形，画出来 */
async function render(png: Uint8Array, size: [number, number], fill: Partial<ImageFill>): Promise<Bitmap> {
  const { renderer, node } = await setup(png, size, fill);
  return renderer.renderToBitmap(node.id, size[0], size[1])!;
}

function pixel(bitmap: Bitmap, x: number, y = 1): number[] {
  const i = (y * bitmap.width + x) * 4;
  return [...bitmap.data.slice(i, i + 3)];
}

function expectNear(actual: number[], expected: number[], tolerance = 2): void {
  actual.forEach((value, i) =>
    expect(Math.abs(value - expected[i]!), `通道 ${i}：${value}`).toBeLessThanOrEqual(tolerance),
  );
}

const GRAYS: [number, number, number][] = [
  [0, 0, 0],
  [64, 64, 64],
  [128, 128, 128],
  [255, 255, 255],
];

describe('曲线', () => {
  it('总曲线作用于三个通道：反相的曲线把黑变白、白变黑', async () => {
    const bitmap = await render(makePng(GRAYS), [4, 4], { curves: { rgb: [p(0, 1), p(1, 0)] } });
    expectNear(pixel(bitmap, 0), [255, 255, 255]);
    expectNear(pixel(bitmap, 1), [191, 191, 191]);
    expectNear(pixel(bitmap, 2), [127, 127, 127]);
    expectNear(pixel(bitmap, 3), [0, 0, 0]);
  });

  it('通道曲线只改那个通道；先过通道曲线再过总曲线', async () => {
    const bitmap = await render(makePng([[128, 128, 128]]), [1, 4], {
      curves: { red: [p(0, 0), p(0.5, 1), p(1, 1)], rgb: [p(0, 0), p(1, 0.5)] },
    });
    // 红：0.5 → 1 → 0.5；绿、蓝：0.5 → 0.25
    expectNear(pixel(bitmap, 0), [128, 64, 64]);
  });

  it('曲线在调色之后：先把亮度压到一半，再用曲线把 0.25 以下拉成黑', async () => {
    const bitmap = await render(makePng([[128, 128, 128]]), [1, 4], {
      adjust: { brightness: -50, contrast: 0, saturation: 0, temperature: 0, tint: 0, hue: 0, blur: 0 },
      curves: { rgb: [p(0, 0), p(0.3, 0), p(1, 1)] },
    });
    expectNear(pixel(bitmap, 0), [0, 0, 0]);
  });
});

describe('锐化', () => {
  it('边缘两侧的反差变大，远离边缘的地方不变', async () => {
    const png = makePng(
      [
        [64, 64, 64],
        [192, 192, 192],
      ],
      8,
    );
    const plain = await render(png, [16, 4], {});
    const sharp = await render(png, [16, 4], {
      adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, hue: 0, blur: 0, sharpen: 100 },
    });
    expect(pixel(sharp, 7)[0]!).toBeLessThan(pixel(plain, 7)[0]! - 20);
    expect(pixel(sharp, 8)[0]!).toBeGreaterThan(pixel(plain, 8)[0]! + 20);
    expectNear(pixel(sharp, 1), [64, 64, 64], 1);
    expectNear(pixel(sharp, 14), [192, 192, 192], 1);
  });

  it('半径越大，影响到的范围越宽', async () => {
    const png = makePng(
      [
        [64, 64, 64],
        [192, 192, 192],
      ],
      8,
    );
    const adjust = {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      temperature: 0,
      tint: 0,
      hue: 0,
      blur: 0,
      sharpen: 100,
    };
    const narrow = await render(png, [16, 4], { adjust: { ...adjust, sharpenRadius: 0.5 } });
    const wide = await render(png, [16, 4], { adjust: { ...adjust, sharpenRadius: 2 } });
    expectNear(pixel(narrow, 5), [64, 64, 64], 1);
    expect(pixel(wide, 5)[0]!).toBeLessThan(60);
  });
});

describe('滤镜预设', () => {
  const COLOR: [number, number, number][] = [[200, 80, 40]];

  it('黑白：强度 100 时三个通道相等；强度 50 时在原色和黑白中间；强度 0 和不认识的预设等于没有', async () => {
    const full = pixel(await render(makePng(COLOR), [1, 4], { filter: { preset: 'mono', amount: 100 } }), 0);
    expect(Math.abs(full[0]! - full[1]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(full[1]! - full[2]!)).toBeLessThanOrEqual(1);
    const half = pixel(await render(makePng(COLOR), [1, 4], { filter: { preset: 'mono', amount: 50 } }), 0);
    half.forEach((value, i) => expect(Math.abs(value - (COLOR[0]![i]! + full[i]!) / 2)).toBeLessThanOrEqual(2));
    expect(lookPlan({ type: 'image', assetId: 'x', fit: 'cover', filter: { preset: 'mono', amount: 0 } })).toBeNull();
    expect(
      lookPlan({ type: 'image', assetId: 'x', fit: 'cover', filter: { preset: 'unknown', amount: 80 } }),
    ).toBeNull();
  });

  it('深褐：去色之后染成暖色，红多蓝少', async () => {
    const [r, g, b] = pixel(await render(makePng(COLOR), [1, 4], { filter: { preset: 'sepia', amount: 100 } }), 0);
    expect(r!).toBeGreaterThan(g!);
    expect(g!).toBeGreaterThan(b!);
  });
});

describe('导出时烤进像素', () => {
  it('和画布上画的一样：锐化、滤镜、调色、曲线一起', async () => {
    // 32 × 4 的渐变色条，每列颜色不同
    const columns = Array.from({ length: 32 }, (_, i): [number, number, number] => [
      i * 8,
      255 - i * 6,
      (i * 37) % 256,
    ]);
    const fill: Partial<ImageFill> = {
      adjust: { brightness: 10, contrast: 20, saturation: -30, temperature: 15, tint: 0, hue: 0, blur: 0, sharpen: 80 },
      curves: { rgb: [p(0, 0.05), p(0.5, 0.6), p(1, 0.95)], blue: [p(0, 0), p(1, 0.8)] },
      filter: { preset: 'film', amount: 70 },
    };
    const { renderer, images, node, fill: imageFill } = await setup(makePng(columns), [32, 4], fill);
    const canvas = renderer.renderToBitmap(node.id, 32, 4)!;
    const image = images.get(imageFill.assetId)!;
    const baked = bakeImage(ck, imageFill, image, 1)!;
    const pixels = baked.image.readPixels(0, 0, {
      width: 32,
      height: 4,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    }) as Uint8Array;
    baked.dispose();
    let max = 0;
    for (let i = 0; i < pixels.length; i++) max = Math.max(max, Math.abs(pixels[i]! - canvas.data[i]!));
    expect(max).toBeLessThanOrEqual(1);
  });
});

describe('文档校验', () => {
  function documentWith(fill: unknown) {
    const store = DocStore.create();
    store.transact('rect', (tx) =>
      tx.create(
        createNode('rect', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [10, 10],
          fill: null,
          stroke: null,
          cornerRadius: 0,
        }),
      ),
    );
    const data = JSON.parse(JSON.stringify(store.toJSON()));
    const rect = Object.values(data.nodes).find((n) => (n as { type: string }).type === 'rect') as { fill: unknown };
    rect.fill = fill;
    return data;
  }
  const base = { type: 'image', assetId: 'abc', fit: 'cover' };

  it('接受曲线、锐化、滤镜', () => {
    const fill = {
      ...base,
      adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, hue: 0, blur: 0, sharpen: 50 },
      curves: { rgb: [p(0, 0), p(1, 1)], red: [p(0, 0.1), p(0.5, 0.5), p(1, 1)] },
      filter: { preset: 'film', amount: 60 },
    };
    expect(() => validateDocument(documentWith(fill))).not.toThrow();
  });

  it('拒绝坏的曲线和滤镜', () => {
    const bad = [
      { ...base, curves: { rgb: [p(0, 0)] } },
      { ...base, curves: { red: [{ x: 'a', y: 0 }, p(1, 1)] } },
      { ...base, curves: { rgb: Array.from({ length: 40 }, (_, i) => p(i / 40, i / 40)) } },
      { ...base, curves: [] },
      { ...base, filter: { preset: 3, amount: 50 } },
      { ...base, filter: { preset: 'mono', amount: null } },
    ];
    for (const fill of bad) expect(() => validateDocument(documentWith(fill))).toThrow(/badNode/);
  });
});
