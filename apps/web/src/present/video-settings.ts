import { slides } from '@shiba/core';
import { playableSlides, type Editor } from '@shiba/editor';

/** 导出视频的设置和可选的档位。对话框只用到这些，录制和编码在 video.ts 里，用到时才加载 */

export type VideoFormat = 'mp4' | 'gif';

export interface VideoSettings {
  format: VideoFormat;
  /**
   * 画面大小的档位。MP4：短边的上限，长边不超过它的 16/9 倍（1080 就是 1920 × 1080 以内）；
   * GIF：长边的上限。都按幻灯片的比例缩放
   */
  size: number;
  fps: number;
  /** 一页的动画都播完以后停多久再翻页，秒 */
  dwell: number;
  /** "单击时"开始的动画在上一步播完后等多久自动开始，秒 */
  clickDelay: number;
}

export const DEFAULT_VIDEO: VideoSettings = { format: 'mp4', size: 1080, fps: 30, dwell: 3, clickDelay: 1 };
export const MP4_SIZES = [1080, 720];
export const GIF_SIZES = [960, 640];
export const MP4_FPS = [30, 60];
export const GIF_FPS = [15, 10];

export class VideoUnsupportedError extends Error {}

/** 浏览器能不能编码视频（Safari 16.4 之前、一些旧浏览器没有 WebCodecs） */
export function canEncodeVideo(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/** 某一档对应的画面大小。H.264 要求宽高是偶数 */
export function videoSize(
  slide: { width: number; height: number },
  format: VideoFormat,
  size: number,
): { width: number; height: number } {
  const long = format === 'mp4' ? Math.round((size * 16) / 9) : size;
  const short = size;
  const landscape = slide.width >= slide.height;
  const maxW = landscape ? long : short;
  const maxH = landscape ? short : long;
  const scale = Math.min(maxW / slide.width, maxH / slide.height);
  const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(slide.width * scale), height: even(slide.height * scale) };
}

/** 第一页幻灯片的大小，视频的画面比例按它定；没有幻灯片时返回 null */
export function firstSlideSize(editor: Editor): { width: number; height: number } | null {
  const first = playableSlides(editor)[0];
  return first ? { width: first.size[0], height: first.size[1] } : null;
}
