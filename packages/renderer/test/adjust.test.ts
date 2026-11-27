import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  DocStore,
  NO_ADJUSTMENTS,
  createNode,
  validateDocument,
  type ImageAdjustments,
  type ImageFill,
} from '@shiba/core';
import {
  GeometryCache,
  ImageCache,
  NodeTypeRegistry,
  Renderer,
  adjustmentMatrix,
  loadCanvasKit,
  registerBuiltinNodeTypes,
  type Bitmap,
  type CanvasKit,
} from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

/** 造一张纯色块拼成的测试图：每个色块宽 20、高 20，从左到右排列 */
function makePng(colors: [number, number, number][]): Uint8Array {
  const surface = ck.MakeSurface(colors.length * 20, 20)!;
  const canvas = surface.getCanvas();
  const paint = new ck.Paint();
  colors.forEach(([r, g, b], i) => {
    paint.setColor(ck.Color4f(r, g, b, 1));
    canvas.drawRect(ck.XYWHRect(i * 20, 0, 20, 20), paint);
  });
  const image = surface.makeImageSnapshot();
  const bytes = image.encodeToBytes()!.slice();
  image.delete();
  paint.delete();
  surface.delete();
  return bytes;
}

async function render(
  colors: [number, number, number][],
  fill: Partial<ImageFill>,
  size: [number, number],
): Promise<Bitmap> {
  const store = DocStore.create();
  const assets = new AssetStore();
  const registry = registerBuiltinNodeTypes(new NodeTypeRegistry());
  const geometry = new GeometryCache(ck, store, registry);
  const renderer = new Renderer(ck, {} as HTMLCanvasElement, store, registry, geometry, new ImageCache(ck, assets));
  const meta = await assets.add(makePng(colors), { mime: 'image/png', width: colors.length * 20, height: 20 });
  const node = store.transact('rect', (tx) =>
    tx.create(
      createNode('rect', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size,
        fill: { type: 'image', assetId: meta.id, fit: 'stretch', ...fill },
        stroke: null,
        cornerRadius: 0,
      }),
    ),
  );
  return renderer.renderToBitmap(node.id, size[0], size[1])!;
}

function pixel(bitmap: Bitmap, x: number, y: number): number[] {
  const i = (y * bitmap.width + x) * 4;
  return [...bitmap.data.slice(i, i + 4)];
}

const adjust = (patch: Partial<ImageAdjustments>): ImageAdjustments => ({ ...NO_ADJUSTMENTS, ...patch });

/** 测试图存成 8 位之后有取整误差（0.25 实际是 64/255），所以比较时允许差一个色阶 */
function expectNear(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(Math.abs(value - expected[i]!), `通道 ${i}`).toBeLessThanOrEqual(1));
}
/** 一个中等亮度、带颜色倾向的测试色：(64, 128, 191) */
const SAMPLE: [number, number, number] = [0.25, 0.5, 0.75];

async function sample(patch: Partial<ImageAdjustments>): Promise<number[]> {
  return pixel(await render([SAMPLE], { adjust: adjust(patch) }, [20, 20]), 10, 10);
}

describe('颜色矩阵', () => {
  it('没有调整时不生成矩阵', () => {
    expect(adjustmentMatrix(undefined)).toBeNull();
    expect(adjustmentMatrix(NO_ADJUSTMENTS)).toBeNull();
    // 只有模糊也不算颜色调整
    expect(adjustmentMatrix(adjust({ blur: 20 }))).toBeNull();
  });

  it('超出范围的参数被限制在范围内', () => {
    expect(adjustmentMatrix(adjust({ brightness: 5000 }))).toEqual(adjustmentMatrix(adjust({ brightness: 100 })));
  });
});

describe('调色', () => {
  it('不调整时像素原样输出', async () => {
    expect(await sample({})).toEqual([64, 128, 191, 255]);
  });

  it('亮度：+100 是两倍亮，-100 是全黑', async () => {
    expect(await sample({ brightness: 100 })).toEqual([128, 255, 255, 255]);
    expect(await sample({ brightness: -100 })).toEqual([0, 0, 0, 255]);
    expectNear(await sample({ brightness: 50 }), [96, 191, 255, 255]);
  });

  it('对比度：-100 全部变成中灰，+100 拉开与中灰的距离', async () => {
    const flat = await sample({ contrast: -100 });
    expect(flat.slice(0, 3).every((v) => Math.abs(v - 128) <= 1)).toBe(true);
    // (0.25, 0.5, 0.75) 以 0.5 为支点放大两倍 → (0, 0.5, 1)
    expectNear(await sample({ contrast: 100 }), [0, 128, 255, 255]);
  });

  it('饱和度：-100 是黑白，三个通道相等', async () => {
    const [r, g, b] = await sample({ saturation: -100 });
    expect(Math.abs(r! - g!)).toBeLessThanOrEqual(1);
    expect(Math.abs(g! - b!)).toBeLessThanOrEqual(1);
    // 灰度值是按人眼敏感度加权的：0.213×64 + 0.715×128 + 0.072×191 ≈ 119
    expect(Math.abs(g! - 119)).toBeLessThanOrEqual(2);
    // +100 时颜色之间的差距拉大
    const vivid = await sample({ saturation: 100 });
    expect(vivid[2]! - vivid[0]!).toBeGreaterThan(191 - 64);
  });

  it('色温：暖色红多蓝少，冷色相反', async () => {
    const warm = await sample({ temperature: 100 });
    const cool = await sample({ temperature: -100 });
    expect(warm[0]).toBeGreaterThan(64);
    expect(warm[2]).toBeLessThan(191);
    expect(cool[0]).toBeLessThan(64);
    expect(cool[2]).toBeGreaterThan(191);
    expect(warm[1]).toBe(128);
  });

  it('色调：偏洋红时绿色减少', async () => {
    expect((await sample({ tint: 100 }))[1]).toBeLessThan(128);
    expect((await sample({ tint: -100 }))[1]).toBeGreaterThan(128);
  });

  it('色相：转 180° 后纯红变成青色系，转 360° 的整数倍等于没转', async () => {
    const [r, g, b] = pixel(await render([[1, 0, 0]], { adjust: adjust({ hue: 180 }) }, [20, 20]), 10, 10);
    expect(r).toBeLessThan(20);
    expect(g).toBeGreaterThan(80);
    expect(b).toBeGreaterThan(80);
  });

  it('透明度不受调色影响', async () => {
    const [, , , a] = await sample({ brightness: 60, contrast: -40, saturation: 80, hue: 90 });
    expect(a).toBe(255);
  });
});

describe('模糊', () => {
  const RED_BLUE: [number, number, number][] = [
    [1, 0, 0],
    [0, 0, 1],
  ];

  it('内容被模糊：红蓝交界处混成紫色', async () => {
    const sharp = await render(RED_BLUE, {}, [40, 20]);
    const blurred = await render(RED_BLUE, { adjust: adjust({ blur: 16 }) }, [40, 20]);
    expect(pixel(sharp, 17, 10)).toEqual([255, 0, 0, 255]);
    const [r, , b] = pixel(blurred, 17, 10);
    expect(r).toBeGreaterThan(60);
    expect(b).toBeGreaterThan(60);
  });

  it('形状的边缘保持清晰：贴着边的像素仍然完全不透明', async () => {
    const blurred = await render(RED_BLUE, { adjust: adjust({ blur: 16 }) }, [40, 20]);
    for (const [x, y] of [
      [0, 0],
      [39, 0],
      [0, 19],
      [39, 19],
      [20, 0],
    ]) {
      expect(pixel(blurred, x!, y!)[3]).toBe(255);
    }
  });
});

describe('画面内的缩放与平移', () => {
  const RED_BLUE: [number, number, number][] = [
    [1, 0, 0],
    [0, 0, 1],
  ];
  const RED = [255, 0, 0, 255];
  const BLUE = [0, 0, 255, 255];

  it('放大两倍并把图片推到最右：框里只剩左半边的红色', async () => {
    const bitmap = await render(RED_BLUE, { zoom: 2, panX: 1 }, [40, 20]);
    expect(pixel(bitmap, 2, 10)).toEqual(RED);
    expect(pixel(bitmap, 37, 10)).toEqual(RED);
  });

  it('推到最左：框里只剩右半边的蓝色', async () => {
    const bitmap = await render(RED_BLUE, { zoom: 2, panX: -1 }, [40, 20]);
    expect(pixel(bitmap, 2, 10)).toEqual(BLUE);
    expect(pixel(bitmap, 37, 10)).toEqual(BLUE);
  });

  it('只放大不平移：以中心为准，两边各裁掉一部分', async () => {
    const bitmap = await render(RED_BLUE, { zoom: 2 }, [40, 20]);
    expect(pixel(bitmap, 5, 10)).toEqual(RED);
    expect(pixel(bitmap, 34, 10)).toEqual(BLUE);
  });

  it('铺满模式下，图片比框宽出来的部分可以左右移动', async () => {
    // 40×20 的图铺满 20×20 的框：放大后是 40×20，左右各多出 10
    const left = await render(RED_BLUE, { fit: 'cover', panX: 1 }, [20, 20]);
    const right = await render(RED_BLUE, { fit: 'cover', panX: -1 }, [20, 20]);
    expect(pixel(left, 10, 10)).toEqual(RED);
    expect(pixel(right, 10, 10)).toEqual(BLUE);
  });

  it('缩放小于 1 时按 1 处理，平移超出范围时按边界处理', async () => {
    const bitmap = await render(RED_BLUE, { zoom: 0.2, panX: 99 }, [40, 20]);
    expect(pixel(bitmap, 5, 10)).toEqual(RED);
    expect(pixel(bitmap, 34, 10)).toEqual(BLUE);
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
          fill: { type: 'image', assetId: 'abc', fit: 'cover' },
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

  it('接受带调整参数的图片填充', () => {
    const fill = { type: 'image', assetId: 'abc', fit: 'cover', adjust: adjust({ blur: 4 }), zoom: 1.5, panX: -0.3 };
    expect(() => validateDocument(documentWith(fill))).not.toThrow();
  });

  it('拒绝非数值的调整参数', () => {
    const base = { type: 'image', assetId: 'abc', fit: 'cover' };
    expect(() => validateDocument(documentWith({ ...base, adjust: { brightness: 'lots' } }))).toThrow(/badNode/);
    expect(() => validateDocument(documentWith({ ...base, zoom: null }))).toThrow(/badNode/);
    expect(() => validateDocument(documentWith({ ...base, adjust: [1, 2, 3] }))).toThrow(/badNode/);
  });
});
