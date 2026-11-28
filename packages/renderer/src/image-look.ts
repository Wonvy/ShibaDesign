import type { CanvasKit, Image, RuntimeEffect, Shader } from 'canvaskit-wasm';
import { channelTables, hasCurves, imagePreset, type ImageCurves, type ImageFill } from '@shiba/core';
import { adjustmentMatrix } from './adjust';
import { makeImageShader } from './images';

/**
 * 图片的锐化、滤镜预设、曲线：颜色矩阵做不了这几样，用一个 SkSL 着色器包住图片着色器来做。
 * 在 GPU 上逐像素算，拖滑块时实时；导出时用同一个着色器把效果烤进像素（bake.ts），画布和导出一致。
 *
 * 顺序：锐化 → 滤镜（预设的调色、预设的曲线，再按强度和原图混合）→ 自己调的颜色（亮度、对比度等）→ 自己调的曲线。
 * 和 Lightroom 一样，曲线在基本调色之后。只调了颜色、没有这几样时不用这个着色器，颜色还是走颜色矩阵。
 */

/** 着色器要的参数，同样的参数得到同样的 key（导出时用来给烤好的图片去重） */
export interface LookPlan {
  /** 锐化强度：细节的反差加几倍，0 表示不锐化 */
  sharpen: number;
  /** 锐化的半径，文档单位 */
  radius: number;
  /** 滤镜：预设的颜色矩阵和曲线、强度（0–1）；没有滤镜时是 null */
  filter: { amount: number; matrix: number[] | null; curves: ImageCurves | undefined } | null;
  /** 自己调的颜色矩阵 */
  matrix: number[] | null;
  /** 自己调的曲线（起作用的） */
  curves: ImageCurves | undefined;
  key: string;
}

/** 图片填充要不要这个着色器；只有颜色矩阵、模糊时返回 null */
export function lookPlan(fill: ImageFill): LookPlan | null {
  const amount = Math.max(0, Math.min(200, fill.adjust?.sharpen ?? 0)) / 100;
  const radius = Math.max(0.1, Math.min(10, fill.adjust?.sharpenRadius ?? 1));
  const preset = fill.filter ? imagePreset(fill.filter.preset) : undefined;
  const strength = Math.max(0, Math.min(100, fill.filter?.amount ?? 0)) / 100;
  const filter =
    preset && strength > 0
      ? {
          amount: strength,
          matrix: adjustmentMatrix({
            brightness: 0,
            contrast: 0,
            saturation: 0,
            temperature: 0,
            tint: 0,
            hue: 0,
            blur: 0,
            ...preset.adjust,
          }),
          curves: hasCurves(preset.curves) ? preset.curves : undefined,
        }
      : null;
  const curves = hasCurves(fill.curves) ? fill.curves : undefined;
  if (amount === 0 && !filter && !curves) return null;
  const matrix = adjustmentMatrix(fill.adjust);
  const key = JSON.stringify([
    amount,
    amount > 0 ? radius : 0,
    filter ? [fill.filter!.preset, strength] : null,
    matrix,
    curves ?? null,
  ]);
  return { sharpen: amount, radius, filter, matrix, curves, key };
}

const SKSL = `
uniform shader image;
uniform shader lut;
uniform float sharpen;
uniform float spacing;
uniform float filterAmount;
uniform float3x3 filterMatrix;
uniform float3 filterOffset;
uniform float filterCurves;
uniform float useMatrix;
uniform float3x3 userMatrix;
uniform float3 userOffset;
uniform float useCurves;

half3 lookup(half3 c, float row) {
  return half3(
    lut.eval(float2(float(c.r) * 255.0 + 0.5, row)).r,
    lut.eval(float2(float(c.g) * 255.0 + 0.5, row)).g,
    lut.eval(float2(float(c.b) * 255.0 + 0.5, row)).b);
}

half4 main(float2 p) {
  half4 c = image.eval(p);
  if (sharpen > 0.0) {
    half4 sum = half4(0);
    float total = 0.0;
    for (int i = -2; i <= 2; i++) {
      for (int j = -2; j <= 2; j++) {
        float w = exp(-0.5 * float(i * i + j * j));
        sum += image.eval(p + float2(float(i), float(j)) * spacing) * half(w);
        total += w;
      }
    }
    half4 blurred = sum / half(total);
    c = clamp(c + (c - blurred) * half(sharpen), 0.0, 1.0);
    c.rgb = min(c.rgb, half3(c.a));
  }
  half4 u = unpremul(c);
  half3 rgb = u.rgb;
  if (filterAmount > 0.0) {
    half3 f = half3(clamp(filterMatrix * float3(rgb) + filterOffset, 0.0, 1.0));
    if (filterCurves > 0.0) f = lookup(f, 0.5);
    rgb = mix(rgb, f, half(filterAmount));
  }
  if (useMatrix > 0.0) rgb = half3(clamp(userMatrix * float3(rgb) + userOffset, 0.0, 1.0));
  if (useCurves > 0.0) rgb = lookup(rgb, 1.5);
  return half4(rgb * u.a, u.a);
}
`;

/** 编译好的着色器，每个 CanvasKit 实例编译一次。编译失败时是 null（不该发生，发生了就不做这几样效果） */
const effects = new WeakMap<CanvasKit, RuntimeEffect | null>();

function effectFor(ck: CanvasKit): RuntimeEffect | null {
  if (!effects.has(ck)) {
    const effect = ck.RuntimeEffect.Make(SKSL, (error) => console.error(`[shiba] 图片着色器编译失败：${error}`));
    effects.set(ck, effect);
  }
  return effects.get(ck) ?? null;
}

/** 4 × 5 的颜色矩阵（行主序）→ 着色器要的 3 × 3 矩阵（列主序）和偏移 */
function splitMatrix(m: number[] | null): number[] {
  if (!m) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  return [m[0]!, m[5]!, m[10]!, m[1]!, m[6]!, m[11]!, m[2]!, m[7]!, m[12]!, m[4]!, m[9]!, m[14]!];
}

/** 256 × 2 的查找表：第 0 行是滤镜的曲线，第 1 行是自己调的曲线；没有的那行是不变的直线 */
function lookupTable(ck: CanvasKit, filter: ImageCurves | undefined, own: ImageCurves | undefined): Image | null {
  const pixels = new Uint8Array(256 * 2 * 4);
  [filter, own].forEach((curves, row) => {
    const tables = channelTables(curves);
    for (let i = 0; i < 256; i++) {
      const at = (row * 256 + i) * 4;
      pixels[at] = tables ? Math.round(tables.red[i]! * 255) : i;
      pixels[at + 1] = tables ? Math.round(tables.green[i]! * 255) : i;
      pixels[at + 2] = tables ? Math.round(tables.blue[i]! * 255) : i;
      pixels[at + 3] = 255;
    }
  });
  return ck.MakeImage(
    {
      width: 256,
      height: 2,
      alphaType: ck.AlphaType.Unpremul,
      colorType: ck.ColorType.RGBA_8888,
      colorSpace: ck.ColorSpace.SRGB,
    },
    pixels,
    256 * 4,
  );
}

/**
 * 包住图片着色器的着色器，调用方用完要 delete（图片着色器还是调用方的）。
 * @param spacing 锐化取样的间隔，着色器所在坐标里的长度：画布上是文档单位（就是半径），烤像素时换算成图片像素
 * @returns 着色器编译失败时返回 null，调用方照常画原图
 */
export function makeLookShader(ck: CanvasKit, image: Shader, plan: LookPlan, spacing: number): Shader | null {
  const effect = effectFor(ck);
  if (!effect) return null;
  const table = lookupTable(ck, plan.filter?.curves, plan.curves);
  if (!table) return null;
  const lut = table.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Linear, ck.MipmapMode.None);
  table.delete();
  const filter = splitMatrix(plan.filter?.matrix ?? null);
  const own = splitMatrix(plan.matrix);
  const uniforms = [
    plan.sharpen,
    spacing,
    plan.filter?.amount ?? 0,
    ...filter.slice(0, 9),
    ...filter.slice(9),
    plan.filter?.curves ? 1 : 0,
    plan.matrix ? 1 : 0,
    ...own.slice(0, 9),
    ...own.slice(9),
    plan.curves ? 1 : 0,
  ];
  const shader = effect.makeShaderWithChildren(uniforms, [image, lut]);
  lut.delete();
  return shader;
}

/**
 * 把一张图片按填充的调整（不含模糊）画成 width × height 的小图，铺满、居中裁切，返回不预乘的 RGBA 像素。
 * 图片面板里滤镜预设的缩略图用它。画不出来时返回 null
 */
export function renderImagePreview(
  ck: CanvasKit,
  image: Image,
  fill: ImageFill,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> | null {
  const surface = ck.MakeSurface(width, height);
  if (!surface) return null;
  const canvas = surface.getCanvas();
  canvas.clear(ck.TRANSPARENT);
  const box = { x: 0, y: 0, w: width, h: height };
  const base = makeImageShader(ck, image, box, { ...fill, fit: 'cover', zoom: undefined, panX: 0, panY: 0 });
  const plan = lookPlan(fill);
  const look = plan ? makeLookShader(ck, base, plan, plan.radius) : null;
  const matrix = look ? null : adjustmentMatrix(fill.adjust);
  const colorFilter = matrix ? ck.ColorFilter.MakeMatrix(matrix) : null;
  const paint = new ck.Paint();
  paint.setShader(look ?? base);
  paint.setColorFilter(colorFilter);
  canvas.drawRect(ck.LTRBRect(0, 0, width, height), paint);
  paint.delete();
  look?.delete();
  base.delete();
  colorFilter?.delete();
  const snapshot = surface.makeImageSnapshot();
  const pixels = snapshot.readPixels(0, 0, {
    width,
    height,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  snapshot.delete();
  surface.delete();
  return pixels ? Uint8ClampedArray.from(pixels) : null;
}
