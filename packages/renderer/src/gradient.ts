import type { CanvasKit, Shader } from 'canvaskit-wasm';
import { gradientGeometry, normalizeStops, radialEllipseMatrix, type GradientFill, type Rect } from '@shiba/core';
import type { DrawContext } from './node-types';

/**
 * 渐变填充的着色器。调用方用完要 delete。
 * 渐变超出两头的部分延续首尾的颜色；颜色和透明度分开直线过渡，和 PDF、SVG 一致
 * @param bounds 节点在本地坐标里的外框，渐变的相对位置按它换算
 */
export function makeGradientShader(ck: CanvasKit, fill: GradientFill, bounds: Rect): Shader {
  const stops = normalizeStops(fill.stops);
  const colors = stops.map(({ color }) => ck.Color4f(color.r, color.g, color.b, color.a));
  const positions = stops.map((s) => s.offset);
  const last = stops[stops.length - 1]?.color ?? { r: 0, g: 0, b: 0, a: 0 };
  const g = gradientGeometry(fill, bounds);
  // 起点终点重合（或者半径为 0）时没有方向可言，整个填成最后一个颜色，和 PDF 阅读器的做法一致
  if (stops.length < 2 || (fill.kind === 'radial' ? g.radius < 1e-6 : Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 1e-6)) {
    return ck.Shader.MakeColor(ck.Color4f(last.r, last.g, last.b, last.a), ck.ColorSpace.SRGB);
  }
  if (fill.kind === 'radial') {
    const m = radialEllipseMatrix(fill, bounds);
    const local = m ? [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1] : undefined;
    return ck.Shader.MakeRadialGradient([g.x0, g.y0], g.radius, colors, positions, ck.TileMode.Clamp, local);
  }
  return ck.Shader.MakeLinearGradient([g.x0, g.y0], [g.x1, g.y1], colors, positions, ck.TileMode.Clamp);
}

/** 用渐变填充节点的轮廓。画笔的颜色只贡献不透明度 */
export function drawGradient(fill: GradientFill, ctx: DrawContext): void {
  const { ck, canvas, outline, paint } = ctx;
  const shader = makeGradientShader(ck, fill, ctx.bounds());
  paint.setColor(ck.Color4f(1, 1, 1, ctx.opacity));
  paint.setShader(shader);
  canvas.drawPath(outline, paint);
  paint.setShader(null);
  shader.delete();
}
