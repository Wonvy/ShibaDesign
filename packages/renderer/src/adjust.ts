import type { ImageAdjustments } from '@shiba/core';

/**
 * 把图片调整参数换算成一个颜色矩阵。
 *
 * 颜色矩阵是 4 行 5 列（行主序，共 20 个数），每一行算出一个输出通道：
 *   R' = m0·R + m1·G + m2·B + m3·A + m4
 * 颜色分量和偏移量都在 0–1 的范围里。
 *
 * 亮度、对比度、饱和度、色相的公式照搬 CSS 滤镜规范里的定义；
 * 色温和色调 CSS 里没有，这里用红蓝、绿通道的增益来近似。
 */

/** 人眼对红绿蓝的敏感度，CSS 滤镜规范用的那组系数 */
const LR = 0.213;
const LG = 0.715;
const LB = 0.072;

type ColorMatrix = number[];
type Row = [number, number, number];

const IDENTITY: ColorMatrix = rgb([1, 0, 0], [0, 1, 0], [0, 0, 1]);

/** 由红、绿、蓝三行系数拼出矩阵；三个通道加同一个偏移，透明度原样通过 */
function rgb(r: Row, g: Row, b: Row, offset = 0): ColorMatrix {
  return [...r, 0, offset, ...g, 0, offset, ...b, 0, offset, 0, 0, 0, 1, 0];
}

/** 返回 a∘b：先应用 b，再应用 a */
function compose(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const out = new Array<number>(20).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      let sum = col === 4 ? a[row * 5 + 4]! : 0;
      for (let k = 0; k < 4; k++) sum += a[row * 5 + k]! * b[k * 5 + col]!;
      out[row * 5 + col] = sum;
    }
  }
  return out;
}

function gains(r: number, g: number, b: number): ColorMatrix {
  return rgb([r, 0, 0], [0, g, 0], [0, 0, b]);
}

function saturate(s: number): ColorMatrix {
  return rgb(
    [LR + (1 - LR) * s, LG - LG * s, LB - LB * s],
    [LR - LR * s, LG + (1 - LG) * s, LB - LB * s],
    [LR - LR * s, LG - LG * s, LB + (1 - LB) * s],
  );
}

function hueRotate(degrees: number): ColorMatrix {
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return rgb(
    [LR + c * (1 - LR) - s * LR, LG - c * LG - s * LG, LB - c * LB + s * (1 - LB)],
    [LR - c * LR + s * 0.143, LG + c * (1 - LG) + s * 0.14, LB - c * LB - s * 0.283],
    [LR - c * LR - s * (1 - LR), LG - c * LG + s * LG, LB + c * (1 - LB) + s * LB],
  );
}

/** 是否有任何颜色上的调整（不含模糊） */
export function hasColorAdjustments(adjust: ImageAdjustments | undefined): adjust is ImageAdjustments {
  if (!adjust) return false;
  return (
    adjust.brightness !== 0 ||
    adjust.contrast !== 0 ||
    adjust.saturation !== 0 ||
    adjust.temperature !== 0 ||
    adjust.tint !== 0 ||
    adjust.hue !== 0
  );
}

/**
 * 调整参数对应的颜色矩阵；没有颜色调整时返回 null。
 * 应用顺序：色温色调 → 色相 → 饱和度 → 对比度 → 亮度。
 */
export function adjustmentMatrix(adjust: ImageAdjustments | undefined): number[] | null {
  if (!hasColorAdjustments(adjust)) return null;
  const unit = (value: number): number => Math.max(-1, Math.min(1, value / 100));
  const temperature = unit(adjust.temperature);
  const tint = unit(adjust.tint);
  const contrast = 1 + unit(adjust.contrast);
  const brightness = 1 + unit(adjust.brightness);

  let m = IDENTITY;
  // 暖色：红多蓝少；洋红：绿少
  if (temperature !== 0 || tint !== 0) {
    m = compose(gains(1 + 0.2 * temperature, 1 - 0.2 * tint, 1 - 0.2 * temperature), m);
  }
  if (adjust.hue !== 0) m = compose(hueRotate(adjust.hue), m);
  if (adjust.saturation !== 0) m = compose(saturate(1 + unit(adjust.saturation)), m);
  // 对比度以中灰为支点：比中灰亮的更亮，暗的更暗
  if (contrast !== 1) {
    m = compose(rgb([contrast, 0, 0], [0, contrast, 0], [0, 0, contrast], 0.5 - 0.5 * contrast), m);
  }
  if (brightness !== 1) m = compose(gains(brightness, brightness, brightness), m);
  return m;
}
