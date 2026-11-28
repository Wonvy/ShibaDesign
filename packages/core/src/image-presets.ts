import type { ImageAdjustments, ImageCurves } from './model';

/**
 * 滤镜预设：一组调色参数加上曲线，作用在原图上，再按强度和原图混合（见渲染器的 image-look.ts）。
 * 文件里只记预设的 id 和强度，所以预设一旦发布就不能再改，否则用户以前做的图会变样；
 * 要调整效果就加一个新的 id。预设的名字在界面的语言包里（imagePreset.<id>）。
 */
export interface ImagePreset {
  id: string;
  /** 调色参数，同图片调整；省略的项是 0。模糊、锐化不在预设里 */
  adjust?: Partial<Omit<ImageAdjustments, 'blur' | 'sharpen' | 'sharpenRadius'>>;
  /** 在调色之后再过的曲线 */
  curves?: ImageCurves;
}

const p = (x: number, y: number) => ({ x, y });

export const IMAGE_PRESETS: readonly ImagePreset[] = [
  // 黑白
  { id: 'mono', adjust: { saturation: -100, contrast: 10 } },
  // 高反差黑白：去色后加一条陡的 S 曲线
  {
    id: 'noir',
    adjust: { saturation: -100 },
    curves: { rgb: [p(0, 0), p(0.25, 0.12), p(0.75, 0.9), p(1, 1)] },
  },
  // 深褐：去色后用通道曲线染成暖褐色，暗部微微抬起
  {
    id: 'sepia',
    adjust: { saturation: -100 },
    curves: {
      red: [p(0, 0.08), p(0.5, 0.6), p(1, 1)],
      green: [p(0, 0.04), p(0.5, 0.5), p(1, 0.95)],
      blue: [p(0, 0), p(0.5, 0.36), p(1, 0.8)],
    },
  },
  // 复古：偏暖、低饱和，黑色发灰，亮部压暗一点
  {
    id: 'vintage',
    adjust: { saturation: -25, temperature: 20 },
    curves: { rgb: [p(0, 0.1), p(0.5, 0.52), p(1, 0.92)], blue: [p(0, 0.08), p(1, 0.9)] },
  },
  // 胶片：柔和的 S 曲线，暗部偏青、亮部偏暖
  {
    id: 'film',
    adjust: { saturation: -10 },
    curves: {
      rgb: [p(0, 0.05), p(0.25, 0.2), p(0.75, 0.82), p(1, 0.97)],
      red: [p(0, 0), p(0.75, 0.8), p(1, 1)],
      blue: [p(0, 0.06), p(0.5, 0.5), p(1, 0.94)],
    },
  },
  // 褪色：黑色抬起、白色压下，低饱和
  { id: 'fade', adjust: { saturation: -30, contrast: -10 }, curves: { rgb: [p(0, 0.15), p(1, 0.9)] } },
  // 冷调
  { id: 'cool', adjust: { temperature: -35, tint: -5, contrast: 5 } },
  // 暖调
  { id: 'warm', adjust: { temperature: 35, saturation: 10 } },
  // 鲜艳
  { id: 'vivid', adjust: { saturation: 40, contrast: 15 } },
];

/** 按 id 找预设；不认识的（比如更新的版本加的）返回 undefined，当作没有滤镜 */
export function imagePreset(id: string): ImagePreset | undefined {
  return IMAGE_PRESETS.find((preset) => preset.id === id);
}
