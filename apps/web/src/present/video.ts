import {
  gradientGeometry,
  normalizeStops,
  radialEllipseMatrix,
  slides,
  toCssColor,
  type GradientFill,
} from '@shiba/core';
import { playableSlides, type Editor } from '@shiba/editor';
import { GifWriter, Mp4Writer } from '@shiba/io';
import { recordPresentation, type FrameCanvas, type PresentationData, type RecordOptions } from '@shiba/player';
import { compilePresentation } from './compile';
import { VideoUnsupportedError, canEncodeVideo, videoSize, type VideoSettings } from './video-settings';

/**
 * 把演示稿导出成视频（MP4）或动图（GIF）。
 *
 * 画面由播放器逐帧录下来（见 @shiba/player 的 record.ts），所以动画、页面切换和演示时一样；
 * MP4 用浏览器自带的编码器（WebCodecs）编成 H.264，再由 io/video/mp4.ts 装箱；GIF 由 io/video/gif.ts 编码。
 * 全在浏览器里完成，不需要服务器。
 * 这个模块（连同编码器）只在第一次导出视频时加载；对话框用到的设置在 video-settings.ts。
 */

export async function renderVideo(
  editor: Editor,
  settings: VideoSettings,
  progress: { onProgress?(fraction: number): void; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const visible = playableSlides(editor);
  const first = visible[0];
  if (!first) throw new Error('no slides');
  const { width, height } = videoSize({ width: first.size[0], height: first.size[1] }, settings.format, settings.size);
  const fps = settings.fps;

  // 图层渲染成图片：倍率按画面里幻灯片放大的倍数再留一些余量（缩放动画、平滑切换会把图层放大一点）
  const fit = Math.max(...visible.map((slide) => Math.min(width / slide.size[0], height / slide.size[1])));
  const scale = Math.min(4, Math.max(0.5, fit * 1.25));
  const compiled = await compilePresentation(editor, 'preview', '', { layers: 'png', scale });
  const images = new Map<string, ImageBitmap>();
  try {
    for (const slide of compiled.data.slides) {
      for (const layer of slide.layers) {
        if (!layer.src || images.has(layer.id)) continue;
        const blob = await (await fetch(layer.src)).blob();
        images.set(layer.id, await createImageBitmap(blob));
      }
    }
  } finally {
    compiled.dispose();
  }

  const record: Recording = {
    width,
    height,
    fps,
    dwell: settings.dwell * 1000,
    clickDelay: settings.clickDelay * 1000,
    images,
    background(ctx, index, w, h) {
      const fill = visible[index]?.fill;
      if (fill?.type === 'gradient') paintGradient(ctx, fill, w, h);
    },
    onProgress: (time, total) => progress.onProgress?.(total > 0 ? Math.min(1, time / total) : 0),
    signal: progress.signal,
    readback: settings.format === 'gif',
  };
  try {
    const data = compiled.data;
    return settings.format === 'gif' ? await encodeGif(data, record) : await encodeMp4(data, record);
  } finally {
    for (const image of images.values()) image.close();
  }
}

// ───────────── MP4 ─────────────

type Recording = Omit<RecordOptions, 'onFrame'>;

async function encodeMp4(data: PresentationData, record: Recording): Promise<Uint8Array> {
  if (!canEncodeVideo()) throw new VideoUnsupportedError('WebCodecs is not available');
  const { width, height, fps } = record;
  const config = await chooseConfig(width, height, fps);
  const writer = new Mp4Writer(width, height);
  const frameDuration = Math.round(1e6 / fps);
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      const description = metadata?.decoderConfig?.description;
      if (description) writer.setDecoderConfig(toBytes(description));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      writer.addSample({
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? frameDuration,
        key: chunk.type === 'key',
      });
    },
    error(error) {
      failure = error;
    },
  });
  try {
    encoder.configure(config);
    await recordPresentation(data, {
      ...record,
      async onFrame(canvas: FrameCanvas, index: number) {
        if (failure) throw failure;
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((index * 1e6) / fps),
          duration: frameDuration,
        });
        // 每两秒一个关键帧，拖动进度条时跳得快
        encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
        frame.close();
        // 编码器跟不上时等一等，免得排队的帧把内存吃光
        while (encoder.encodeQueueSize > 6) await dequeued(encoder);
      },
    });
    await encoder.flush();
    if (failure) throw failure;
    return writer.finish();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

/**
 * 挑一个浏览器支持的 H.264 配置：从画面大小和帧率需要的最低等级开始，依次试 High、Main、Baseline 三种档次。
 * 码率按画面大小定（1080p30 大约 6 Mbps），幻灯片的画面大部分时间是静止的，实际文件会小得多
 */
async function chooseConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  // H.264 的等级：编号、每帧最多多少个宏块、每秒最多多少个宏块
  const levels: [number, number, number][] = [
    [0x1f, 3600, 108_000],
    [0x28, 8192, 245_760],
    [0x2a, 8704, 522_240],
    [0x32, 22_080, 589_824],
    [0x33, 36_864, 983_040],
    [0x34, 36_864, 2_073_600],
  ];
  const usable = levels.filter(([, frame, rate]) => blocks <= frame && blocks * fps <= rate).map(([level]) => level);
  const bitrate = Math.round(Math.min(40e6, Math.max(1e6, width * height * fps * 0.1)));
  for (const level of usable) {
    for (const profile of ['6400', '4d00', '42e0']) {
      const config: VideoEncoderConfig = {
        codec: `avc1.${profile}${level.toString(16).padStart(2, '0')}`,
        width,
        height,
        bitrate,
        framerate: fps,
        avc: { format: 'avc' },
        latencyMode: 'quality',
      };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return { ...config, ...support.config, avc: { format: 'avc' } };
      } catch {
        // 有的浏览器对不认识的配置直接抛错，当作不支持
      }
    }
  }
  throw new VideoUnsupportedError(`no H.264 encoder for ${width}x${height}@${fps}`);
}

function dequeued(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      encoder.removeEventListener('dequeue', done);
      resolve();
    };
    // 老一点的浏览器没有 dequeue 事件，靠定时器兜底
    const timer = setTimeout(done, 20);
    encoder.addEventListener('dequeue', done);
  });
}

function toBytes(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof ArrayBuffer || source instanceof SharedArrayBuffer) return new Uint8Array(source).slice();
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
}

// ───────────── GIF ─────────────

async function encodeGif(data: PresentationData, record: Recording): Promise<Uint8Array> {
  const { width, height, fps } = record;
  const writer = new GifWriter(width, height);
  await recordPresentation(data, {
    ...record,
    onFrame(canvas: FrameCanvas) {
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      writer.addFrame(ctx.getImageData(0, 0, width, height).data, 1000 / fps);
    },
  });
  return writer.finish();
}

// ───────────── 渐变背景 ─────────────

/** 用画布的渐变画幻灯片的渐变背景（播放器里是 CSS 渐变，画不到画布上）。几何和画布上的渲染一致 */
function paintGradient(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  fill: GradientFill,
  width: number,
  height: number,
): void {
  const bounds = { x: 0, y: 0, w: width, h: height };
  const stops = normalizeStops(fill.stops);
  const last = stops[stops.length - 1]?.color;
  const g = gradientGeometry(fill, bounds);
  const degenerate =
    stops.length < 2 || (fill.kind === 'radial' ? g.radius < 1e-6 : Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 1e-6);
  ctx.save();
  if (degenerate) {
    if (last) {
      ctx.fillStyle = toCssColor(last);
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
    return;
  }
  let gradient: CanvasGradient;
  let area = { x: 0, y: 0, w: width, h: height };
  if (fill.kind === 'radial') {
    const m = radialEllipseMatrix(fill, bounds);
    if (m) {
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      // 压扁之后要填的范围：页面四个角换算回压扁前的坐标
      const inverse = new DOMMatrix(m).inverse();
      const corners = [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ].map(([x, y]) => inverse.transformPoint({ x, y }));
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      area = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
    gradient = ctx.createRadialGradient(g.x0, g.y0, 0, g.x0, g.y0, g.radius);
  } else {
    gradient = ctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1);
  }
  for (const stop of stops) gradient.addColorStop(Math.min(1, Math.max(0, stop.offset)), toCssColor(stop.color));
  ctx.fillStyle = gradient;
  ctx.fillRect(area.x, area.y, area.w, area.h);
  ctx.restore();
}
