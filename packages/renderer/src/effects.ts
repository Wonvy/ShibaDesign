import type { CanvasKit, ImageFilter } from 'canvaskit-wasm';
import { blurSigma, type Effect, type ShadowEffect } from '@shiba/core';

/**
 * 把投影、内阴影、图层模糊做成一个 Skia 的图像滤镜，画对象时开一个离屏层用它：
 * 层里画的是对象本身（source），滤镜在它下面叠投影、上面叠内阴影，最后整体模糊。
 * 背景模糊不在这里（它模糊的是对象下面已经画好的东西，用 saveLayer 的背景滤镜做，见 renderer.ts）。
 *
 * 只要一部分时（导出 PDF：投影、内阴影烤成图片放在矢量形状的下面和上面）：
 * below 只有投影，above 只有内阴影，都不含对象本身。
 */

export type EffectPart = 'all' | 'below' | 'above';

export interface EffectFilter {
  filter: ImageFilter;
  /** 释放这次建的所有滤镜对象 */
  dispose(): void;
}

export function buildEffectFilter(ck: CanvasKit, effects: readonly Effect[], part: EffectPart): EffectFilter | null {
  const made: ImageFilter[] = [];
  const keep = <T extends ImageFilter>(f: T): T => {
    made.push(f);
    return f;
  };
  // null 表示层里画的内容本身
  const over = (below: ImageFilter | null, above: ImageFilter | null): ImageFilter =>
    keep(ck.ImageFilter.MakeBlend(ck.BlendMode.SrcOver, below, above));

  const drop = (e: ShadowEffect): ImageFilter => {
    const sigma = blurSigma(e.blur);
    // 扩展：先把内容的形状往外扩（负数往里缩），再投影
    const shaped =
      e.spread > 0
        ? keep(ck.ImageFilter.MakeDilate(e.spread, e.spread, null))
        : e.spread < 0
          ? keep(ck.ImageFilter.MakeErode(-e.spread, -e.spread, null))
          : null;
    const { r, g, b, a } = e.color;
    return keep(ck.ImageFilter.MakeDropShadowOnly(e.x, e.y, sigma, sigma, ck.Color4f(r, g, b, a), shaped));
  };

  const inner = (e: ShadowEffect): ImageFilter => {
    const sigma = blurSigma(e.blur);
    // 扩展让阴影往里多伸一些：先把形状往里缩
    const shaped = e.spread > 0 ? keep(ck.ImageFilter.MakeErode(e.spread, e.spread, null)) : null;
    const { r, g, b, a } = e.color;
    // 透明度反过来（形状外面变成不透明），颜色换成阴影的颜色，透明度乘上阴影的透明度
    const matrix = [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, -a, a];
    const colorFilter = ck.ColorFilter.MakeMatrix(matrix);
    const inverted = keep(ck.ImageFilter.MakeColorFilter(colorFilter, shaped));
    colorFilter.delete();
    const moved = keep(ck.ImageFilter.MakeOffset(e.x, e.y, inverted));
    const blurred = sigma > 0 ? keep(ck.ImageFilter.MakeBlur(sigma, sigma, ck.TileMode.Clamp, moved)) : moved;
    // 只留下形状里面的部分
    return keep(ck.ImageFilter.MakeBlend(ck.BlendMode.SrcIn, null, blurred));
  };

  const drops = effects.filter((e): e is ShadowEffect => e.type === 'dropShadow');
  const inners = effects.filter((e): e is ShadowEffect => e.type === 'innerShadow');
  const layerBlur = effects.find((e) => e.type === 'layerBlur');

  let below: ImageFilter | null = null;
  for (const e of drops) below = below ? over(below, drop(e)) : drop(e);
  let above: ImageFilter | null = null;
  for (const e of inners) above = above ? over(above, inner(e)) : inner(e);

  let result: ImageFilter | null;
  if (part === 'below') result = below;
  else if (part === 'above') result = above;
  else {
    // 内容加上面的内阴影，再垫上投影
    let content: ImageFilter | null = above ? over(null, above) : null;
    if (below) content = over(below, content);
    result = content;
    if (layerBlur && layerBlur.type === 'layerBlur' && layerBlur.radius > 0) {
      const sigma = blurSigma(layerBlur.radius);
      result = keep(ck.ImageFilter.MakeBlur(sigma, sigma, ck.TileMode.Decal, result));
    }
  }
  if (!result) {
    made.forEach((f) => f.delete());
    return null;
  }
  return { filter: result, dispose: () => made.forEach((f) => f.delete()) };
}
