import { runPlayer } from './player';
import type { PresentationData } from './types';

/**
 * 把演示稿录成一帧帧的画面（导出视频用）。
 *
 * 不另外实现一遍动画：用的就是播放器本身。让它在一个看不见的地方按虚拟时钟播放（见 PlayerOptions.manual），
 * 每推进一帧，就从它的元素上读出每个图层此刻的位置、透明度、裁剪和混合模式——这些值由浏览器按动画算好，
 * 和演示时屏幕上的一模一样——再把图层的图片按这些值画到画布上。
 * 所以录出来的和演示时看到的是同一套动画、同一套页面切换，包括"平滑"切换的配对和交叉淡化。
 *
 * 单击才开始的动画自动接上：一步播完、等 clickDelay 之后播下一步；一页的动画都播完，停 dwell 再翻页。
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type FrameCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface RecordOptions {
  /** 画面大小，像素。幻灯片等比缩放后居中，四周不够的地方是黑色 */
  width: number;
  height: number;
  /** 每秒多少帧 */
  fps: number;
  /** 一页的动画都播完以后停多久再翻页，毫秒；最后一页停这么久后结束 */
  dwell: number;
  /** "单击时"开始的动画：上一步播完以后等多久自动开始，毫秒 */
  clickDelay: number;
  /** 图层的图片，按图层 id。图片对应图层的盒子，分辨率越高越清晰 */
  images: ReadonlyMap<string, CanvasImageSource>;
  /**
   * 画渐变背景（CSS 渐变没法直接画到画布上）。在幻灯片坐标里画，范围是 (0, 0, width, height)。
   * 不提供时渐变背景画成黑色
   */
  background?(ctx: Context2D, slide: number, width: number, height: number): void;
  /** 每画好一帧调用一次；返回 Promise 时等它完成再画下一帧（比如等编码器跟上）。time 是这一帧的时刻，毫秒 */
  onFrame(canvas: FrameCanvas, index: number, time: number): void | Promise<void>;
  /** 进度：已经录到第几毫秒，预计一共多少毫秒 */
  onProgress?(time: number, total: number): void;
  signal?: AbortSignal;
  /** 最长录多久，毫秒，默认 30 分钟 */
  maxDuration?: number;
  /** onFrame 里要读回像素（getImageData）。告诉浏览器把画布放在内存里，读起来快 */
  readback?: boolean;
}

/** 按这些设置录下来大约有多长，毫秒。用来显示进度 */
export function estimateDuration(data: PresentationData, options: { dwell: number; clickDelay: number }): number {
  let total = 0;
  data.slides.forEach((slide, index) => {
    if (index > 0 && slide.transition.effect !== 'none') total += Math.max(0, slide.transition.duration);
    slide.steps.forEach((step, k) => {
      if (k > 0) total += options.clickDelay;
      total += Math.max(0, ...step.map((animation) => animation.start + animation.duration));
    });
    total += options.dwell;
  });
  return total;
}

/** 录下整个演示稿。返回一共多少帧、多长（毫秒） */
export async function recordPresentation(
  data: PresentationData,
  options: RecordOptions,
): Promise<{ frames: number; duration: number }> {
  if (data.slides.length === 0) throw new Error('no slides');
  const { width, height, fps } = options;
  const canvas = makeCanvas(width, height);
  const groupCanvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: !!options.readback }) as Context2D | null;
  const group = groupCanvas.getContext('2d') as Context2D | null;
  if (!ctx || !group) throw new Error('canvas 2d unavailable');
  for (const context of [ctx, group]) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
  }

  // 播放器放在屏幕外面：要真的在网页里，浏览器才会给它的元素算样式
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;overflow:hidden;pointer-events:none;`;
  document.body.appendChild(host);
  const player = runPlayer(host, data, { manual: true });

  const step = 1000 / fps;
  const total = estimateDuration(data, options);
  const limit = options.maxDuration ?? 30 * 60 * 1000;
  let index = 0;
  let idleSince: number | null = null;
  try {
    for (;;) {
      if (options.signal?.aborted) throw new DOMException('Recording aborted', 'AbortError');
      // 让动画结束后接着发生的事（下一步、翻页后的第一步）先跑完
      await settle();
      const time = index * step;
      drawFrame(host, data, options, ctx, canvas, group, groupCanvas);
      await options.onFrame(canvas, index, time);
      options.onProgress?.(time, Math.max(total, time));
      index++;

      const state = player.state();
      if (state.busy) idleSince = null;
      else {
        idleSince ??= time;
        const more = state.step + 1 < state.steps;
        const wait = more ? options.clickDelay : options.dwell;
        if (time - idleSince + 1e-6 >= wait) {
          if (!more && state.slide + 1 >= state.slides) break;
          player.next();
          idleSince = null;
        }
      }
      if (time >= limit) break;
      player.advance(step);
    }
  } finally {
    player.destroy();
    host.remove();
  }
  return { frames: index, duration: index * step };
}

function makeCanvas(width: number, height: number): FrameCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 等一个宏任务：这期间所有排着的微任务（动画的 finished 之后接着做的事）都会执行 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

// ───────────── 按播放器的元素画出一帧 ─────────────

function drawFrame(
  host: HTMLElement,
  data: PresentationData,
  options: RecordOptions,
  ctx: Context2D,
  canvas: FrameCanvas,
  group: Context2D,
  groupCanvas: FrameCanvas,
): void {
  const { width, height } = canvas;
  reset(ctx);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  for (const frame of host.querySelectorAll<HTMLElement>('[data-shiba="frame"]')) {
    const frameStyle = getComputedStyle(frame);
    if (frameStyle.visibility === 'hidden' || frameStyle.display === 'none') continue;
    const index = Number(frame.dataset.slide);
    const slide = data.slides[index];
    const el = frame.querySelector<HTMLElement>(':scope > [data-shiba="slide"]');
    if (!slide || !el) continue;
    const elStyle = getComputedStyle(el);
    const frameMatrix = elementMatrix(frameStyle);
    const slideMatrix = frameMatrix.multiply(elementMatrix(elStyle));

    // 一页先画进单独的画布：切换时整页的透明度作用在合成好的一整页上，混合模式也只和这一页里的东西混合
    reset(group);
    group.clearRect(0, 0, width, height);
    group.save();
    setTransform(group, slideMatrix);
    group.beginPath();
    group.rect(0, 0, slide.width, slide.height);
    group.clip();
    if (elStyle.backgroundImage && elStyle.backgroundImage !== 'none') {
      if (options.background) options.background(group, index, slide.width, slide.height);
      else {
        group.fillStyle = '#000';
        group.fillRect(0, 0, slide.width, slide.height);
      }
    } else {
      group.fillStyle = elStyle.backgroundColor;
      group.fillRect(0, 0, slide.width, slide.height);
    }
    for (const mover of el.querySelectorAll<HTMLElement>(':scope > [data-shiba="mover"]')) {
      drawLayer(group, slideMatrix, mover, options.images);
    }
    group.restore();

    // 幻灯片的外框裁掉超出页面的部分
    ctx.save();
    setTransform(ctx, frameMatrix);
    ctx.beginPath();
    ctx.rect(0, 0, slide.width, slide.height);
    ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = unit(elStyle.opacity);
    ctx.drawImage(groupCanvas, 0, 0);
    ctx.restore();
  }
}

function drawLayer(
  ctx: Context2D,
  slideMatrix: DOMMatrix,
  mover: HTMLElement,
  images: ReadonlyMap<string, CanvasImageSource>,
): void {
  const moverStyle = getComputedStyle(mover);
  if (moverStyle.visibility === 'hidden' || moverStyle.display === 'none') return;
  const layer = mover.querySelector<HTMLElement>(':scope > [data-shiba="layer"]');
  const fx = layer?.querySelector<HTMLElement>(':scope > [data-shiba="fx"]');
  if (!layer || !fx) return;
  const layerStyle = getComputedStyle(layer);
  const fxStyle = getComputedStyle(fx);
  const w = parseFloat(layerStyle.width) || 0;
  const h = parseFloat(layerStyle.height) || 0;
  if (w <= 0 || h <= 0) return;
  const matrix = slideMatrix
    .multiply(elementMatrix(moverStyle))
    .multiply(elementMatrix(layerStyle))
    .multiply(elementMatrix(fxStyle));
  const clip = insetRect(fxStyle.clipPath, w, h);
  if (clip && (clip.w <= 0 || clip.h <= 0)) return;
  const alpha = unit(moverStyle.opacity) * unit(fxStyle.opacity);

  for (const content of fx.querySelectorAll<HTMLElement>(':scope > [data-layer]')) {
    const image = images.get(content.dataset.layer ?? '');
    if (!image) continue;
    const contentStyle = getComputedStyle(content);
    if (contentStyle.visibility === 'hidden') continue;
    const opacity = alpha * unit(contentStyle.opacity);
    if (opacity <= 0) continue;
    ctx.save();
    setTransform(ctx, matrix);
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
    }
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = blendOperation(moverStyle.mixBlendMode);
    ctx.drawImage(image, 0, 0, w, h);
    ctx.restore();
  }
}

function reset(ctx: Context2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function setTransform(ctx: Context2D, m: DOMMatrix): void {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
}

function unit(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/**
 * 一个元素的变换（在父元素坐标里）。播放器的元素都放在父元素的左上角，所以只有变换：
 * 绕 transform-origin，依次是 translate、rotate、scale 三个单独的属性，再是 transform，和 CSS 的规定一致
 */
function elementMatrix(style: CSSStyleDeclaration): DOMMatrix {
  const [ox = 0, oy = 0] = style.transformOrigin.split(' ').map((v) => parseFloat(v) || 0);
  const m = new DOMMatrix().translateSelf(ox, oy);
  if (style.translate && style.translate !== 'none') {
    const [tx = '0', ty = '0'] = style.translate.split(' ');
    m.translateSelf(parseFloat(tx) || 0, parseFloat(ty) || 0);
  }
  if (style.rotate && style.rotate !== 'none') {
    const parts = style.rotate.split(' ');
    m.rotateSelf(angle(parts[parts.length - 1]!));
  }
  if (style.scale && style.scale !== 'none') {
    const [sx = 1, sy = sx] = style.scale.split(' ').map((v) => parseFloat(v));
    m.scaleSelf(sx, sy);
  }
  if (style.transform && style.transform !== 'none') m.multiplySelf(new DOMMatrix(style.transform));
  return m.translateSelf(-ox, -oy);
}

function angle(value: string): number {
  const n = parseFloat(value) || 0;
  if (value.endsWith('rad')) return (n * 180) / Math.PI;
  if (value.endsWith('turn')) return n * 360;
  if (value.endsWith('grad')) return n * 0.9;
  return n;
}

/** clip-path: inset(...) → 裁剪矩形（元素自己的坐标）；不是 inset 时返回 null（不裁） */
function insetRect(
  value: string,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  const match = /^inset\((.*)\)$/.exec(value?.trim() ?? '');
  if (!match) return null;
  // 圆角（round ...）这里用不到，去掉
  const args = splitTopLevel(match[1]!.split(/\sround\s/)[0]!);
  const [t = '0', r = t, b = t, l = r] = args;
  const top = length(t, height);
  const right = length(r, width);
  const bottom = length(b, height);
  const left = length(l, width);
  return { x: left, y: top, w: width - left - right, h: height - top - bottom };
}

/** 按空白拆开，但不拆括号里面的（calc(10% + 2px)） */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text.trim()) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (/\s/.test(char) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else current += char;
  }
  if (current) out.push(current);
  return out;
}

/** 长度：像素、百分比，或者两者相加减的 calc()（动画插值时会出现） */
function length(value: string, reference: number): number {
  let total = 0;
  const body = value.replace(/^calc\(/, '').replace(/\)$/, '');
  for (const match of body.matchAll(/([+-]?)\s*(\d*\.?\d+(?:e[+-]?\d+)?)(px|%)?/gi)) {
    const n = parseFloat(match[2]!) * (match[1] === '-' ? -1 : 1);
    total += match[3] === '%' ? (n / 100) * reference : n;
  }
  return total;
}

const BLEND_MODES = new Set([
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

/** CSS 的 mix-blend-mode → 画布的合成方式。16 种名字一样，只有 normal 在画布上叫 source-over */
function blendOperation(mode: string): GlobalCompositeOperation {
  return BLEND_MODES.has(mode) ? (mode as GlobalCompositeOperation) : 'source-over';
}
