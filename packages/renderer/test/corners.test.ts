import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { rectOutline } from '@shiba/core';
import { buildPath, loadCanvasKit, type CanvasKit } from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

/** 把一条路径画成黑白图，返回每个像素的灰度 */
function raster(path: ReturnType<CanvasKit['Path']['prototype']['copy']>, w: number, h: number): Uint8Array {
  const surface = ck.MakeSurface(w, h)!;
  const canvas = surface.getCanvas();
  canvas.clear(ck.WHITE);
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  paint.setColor(ck.BLACK);
  canvas.drawPath(path, paint);
  const pixels = canvas.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  })!;
  paint.delete();
  surface.delete();
  return new Uint8Array(pixels);
}

describe('顶点圆角的渲染', () => {
  it('四个角一样的圆角，按 corners.ts 生成的和 Skia 自己的圆角矩形画出来几乎一样', () => {
    const ours = buildPath(ck, [rectOutline(200, 120, [30, 30, 30, 30])], 'nonzero');
    const builder = new ck.PathBuilder();
    builder.addRRect(ck.RRectXY(ck.XYWHRect(0, 0, 200, 120), 30, 30));
    const skia = builder.detach();
    builder.delete();
    const a = raster(ours, 200, 120);
    const b = raster(skia, 200, 120);
    let different = 0;
    let max = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i]! - b[i]!);
      if (d > 8) different++;
      max = Math.max(max, d);
    }
    // 曲线本身离真正的圆弧不到 0.01 像素（见 core 的 corners.test.ts）；这里的差别是 Skia 把圆锥曲线和三次曲线
    // 拆成小线段时的容差不同，只在圆弧边缘的抗锯齿上，最多差四分之一个像素的覆盖率
    expect(different / (200 * 120)).toBeLessThan(0.01);
    expect(max).toBeLessThan(80);
    ours.delete();
    skia.delete();
  });
});
