import type { BlendMode as SkBlendMode, BlendModeEnumValues, CanvasKit } from 'canvaskit-wasm';
import type { BlendMode, Color, Matrix } from '@shiba/core';

/** 2×3 仿射矩阵 → Skia 的 3×3 行主序矩阵 */
export function toSkMatrix(m: Matrix): number[] {
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

export function toSkColor(ck: CanvasKit, c: Color, alphaScale = 1): Float32Array {
  return ck.Color4f(c.r, c.g, c.b, c.a * alphaScale);
}

const BLEND_NAMES: Record<BlendMode, keyof Omit<BlendModeEnumValues, 'values'>> = {
  normal: 'SrcOver',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  'color-dodge': 'ColorDodge',
  'color-burn': 'ColorBurn',
  'hard-light': 'HardLight',
  'soft-light': 'SoftLight',
  difference: 'Difference',
  exclusion: 'Exclusion',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
};

export function toSkBlendMode(ck: CanvasKit, mode: BlendMode): SkBlendMode {
  return ck.BlendMode[BLEND_NAMES[mode]] as SkBlendMode;
}
