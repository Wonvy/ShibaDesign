import type { CanvasKit, Image } from 'canvaskit-wasm';
import type { ImageFill } from '@shiba/core';
import { adjustmentMatrix } from './adjust';
import { lookPlan, makeLookShader, type LookPlan } from './image-look';

/**
 * 把图片填充的调色、锐化、滤镜、曲线和模糊"烤"进像素，导出 PDF、SVG（以及网页、视频，它们用 SVG 图层）时用：
 * 这些格式里没有和画布完全一样的效果，先在像素上做好再放进去，样子和画布上一致。
 */

export interface BakedImage {
  /** 调整后的图片；没有调整时就是原来那张。用完调用 dispose */
  image: Image;
  /** 释放烤出来的图片（没有调整时什么都不做，原图归图片缓存管） */
  dispose(): void;
  /** 加上留白之后的大小（像素） */
  width: number;
  height: number;
  /** 模糊之后图片边缘会向外扩散（"适应"铺放时尤其明显），所以四周留出一圈空白，这是它的宽度（像素） */
  pad: number;
  /** 同样的图片和调整得到同样的值，用来去重 */
  key: string;
}

/** 有没有需要烤进像素的调整，以及烤出来的图片四周要留多宽的空白 */
export function bakePlan(
  fill: ImageFill,
  image: { width(): number; height(): number },
  scale: number,
): { matrix: number[] | null; look: LookPlan | null; sigma: number; pad: number; key: string } {
  const matrix = adjustmentMatrix(fill.adjust);
  const look = lookPlan(fill);
  const sigma = Math.max(0, fill.adjust?.blur ?? 0) / 2 / Math.max(scale, 1e-6);
  const blurred = sigma > 0.01;
  const pad = blurred && fill.fit === 'contain' ? Math.ceil(sigma * 3) : 0;
  // 锐化的半径是文档单位，换算成图片像素之后才是烤出来的样子，所以 key 里带上倍率
  const lookKey = look ? `${look.key}@${look.sharpen > 0 ? scale.toFixed(4) : ''}` : '';
  const key = `${fill.assetId}|${matrix?.join(',') ?? ''}|${blurred ? `${sigma.toFixed(2)}|${fill.fit}` : ''}|${lookKey}`;
  return { matrix, look, sigma: blurred ? sigma : 0, pad, key };
}

/**
 * @param scale 图片的一个像素在本地坐标里有多大，用来把模糊半径换算成像素
 */
export function bakeImage(ck: CanvasKit, fill: ImageFill, image: Image, scale: number): BakedImage | null {
  const { matrix, look, sigma, pad, key } = bakePlan(fill, image, scale);
  const width = image.width() + pad * 2;
  const height = image.height() + pad * 2;
  if (!matrix && !look && sigma === 0) return { image, dispose: () => undefined, width, height, pad, key };

  const surface = ck.MakeSurface(width, height);
  if (!surface) return null;
  const canvas = surface.getCanvas();
  canvas.clear(ck.TRANSPARENT);
  // 和画布上一样用图片着色器填满一个矩形，而不是 drawImage：
  // 实测 drawImage 加模糊时，半透明的边缘颜色会被多乘一次透明度，变成一圈暗边
  const paint = new ck.Paint();
  paint.setColor(ck.Color4f(1, 1, 1, 1));
  const tile = fill.fit === 'contain' ? ck.TileMode.Decal : ck.TileMode.Clamp;
  const shader = image.makeShaderOptions(tile, tile, ck.FilterMode.Linear, ck.MipmapMode.None, [
    1,
    0,
    pad,
    0,
    1,
    pad,
    0,
    0,
    1,
  ]);
  // 锐化、滤镜、曲线和画布上用同一个着色器，取样间隔从文档单位换算成图片像素；调色也在它里面做
  const lookShader = look ? makeLookShader(ck, shader, look, look.radius / Math.max(scale, 1e-6)) : null;
  const colorFilter = matrix && !lookShader ? ck.ColorFilter.MakeMatrix(matrix) : null;
  const blur = sigma > 0 ? ck.ImageFilter.MakeBlur(sigma, sigma, tile, null) : null;
  paint.setShader(lookShader ?? shader);
  paint.setColorFilter(colorFilter);
  paint.setImageFilter(blur);
  canvas.drawRect(ck.LTRBRect(0, 0, width, height), paint);
  paint.delete();
  lookShader?.delete();
  shader.delete();
  colorFilter?.delete();
  blur?.delete();
  const baked = surface.makeImageSnapshot();
  const dispose = (): void => {
    baked.delete();
    surface.delete();
  };
  return { image: baked, dispose, width, height, pad, key };
}
