import {
  multiply,
  scheduleAnimations,
  slides,
  gradientCss,
  toCssColor,
  transformRect,
  translation,
  type NodeId,
  type Rect,
} from '@shiba/core';
import type { Editor } from '@shiba/editor';
import type { PlayerLayer, PlayerSlide, PresentationData } from '@shiba/player';

/**
 * 把文档里的幻灯片"编译"成播放器能直接播的数据：
 * 每一页上的每个对象写成一段 SVG（和导出 SVG 是同一套代码）：矢量，放大播放也清晰，文字是真正的文字，
 * 可以选中、复制、搜索；用到的字体做成子集，所有图层共用一份。写不成 SVG 的对象退回渲染成图片。
 * 动画列表排成带时刻和关键帧的步骤。
 */

export interface CompiledPresentation {
  data: PresentationData;
  /** 释放预览时创建的临时图片地址 */
  dispose(): void;
}

export interface CompileOptions {
  /**
   * 图层写成什么：svg（默认，矢量）；png（渲染成图片，导出视频时用：录像要把图层画到画布上，
   * 内联 SVG 里的文字要用网页里的字体，画不到画布上）
   */
  layers?: 'svg' | 'png';
  /** 渲染成图片时的倍率，默认 2 */
  scale?: number;
}

/** 退回成图片时的倍率：两倍图，在普通和高分屏上放大播放都够清晰 */
const SNAPSHOT_SCALE = 2;

function toDataUrl(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * @param mode preview：图片用临时地址，快，用完要 dispose；export：图片内嵌成 data: 地址，可以写进文件
 */
export async function compilePresentation(
  editor: Editor,
  mode: 'preview' | 'export',
  title: string,
  options: CompileOptions = {},
): Promise<CompiledPresentation> {
  const scale = options.scale ?? SNAPSHOT_SCALE;
  const { store } = editor;
  const urls: string[] = [];
  const toSrc = (png: Uint8Array): string => {
    if (mode === 'export') return toDataUrl(png);
    const url = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' }));
    urls.push(url);
    return url;
  };

  const visibleSlides = slides(store).filter((slide) => slide.visible);
  const svg =
    options.layers === 'png'
      ? null
      : await editor.svgLayers(
          visibleSlides.flatMap((slide) =>
            store
              .children(slide.id)
              .filter((node) => node.visible)
              .map((node) => node.id),
          ),
        );

  const compiled: PlayerSlide[] = [];
  let fonts = '';
  try {
    for (const slide of visibleSlides) {
      const layers: PlayerLayer[] = [];
      const boxes = new Map<NodeId, Rect>();
      for (const node of store.children(slide.id)) {
        if (!node.visible) continue;
        let content: { svg?: string; src?: string; box: Rect } | null = null;
        try {
          content = svg?.layer(node.id) ?? null;
        } catch (error) {
          console.warn('[shiba] 图层写不成 SVG，改用图片', error);
        }
        if (!content) {
          const snapshot = await editor.snapshot(node.id, scale);
          if (snapshot) content = { src: toSrc(snapshot.png), box: snapshot.box };
        }
        if (!content) continue;
        // 内容对应的是节点本地坐标里的 box；把"本地坐标 → 幻灯片"的变换平移到 box 的左上角
        const { box } = content;
        const m = multiply(node.transform, translation(box.x, box.y));
        layers.push({
          id: node.id,
          key: node.lineageId,
          svg: content.svg,
          src: content.src,
          width: box.w,
          height: box.h,
          matrix: [m[0], m[1], m[2], m[3], m[4], m[5]],
          blend: node.blendMode,
          hidden: false,
        });
        boxes.set(node.id, transformRect(node.transform, editor.geometry.localBounds(node)));
      }

      const [width, height] = slide.size;
      const schedule = scheduleAnimations(slide.deck?.animations ?? [], { slide: { width, height }, boxes });
      const hidden = new Set(schedule.hiddenAtStart);
      for (const layer of layers) layer.hidden = hidden.has(layer.id);

      compiled.push({
        width,
        height,
        background: !slide.fill
          ? 'transparent'
          : slide.fill.type === 'gradient'
            ? gradientCss(slide.fill, width, height)
            : toCssColor(slide.fill.color),
        layers,
        steps: schedule.steps.map((step) => step.map(({ target, ...rest }) => ({ layer: target, ...rest }))),
        transition: slide.deck?.transition ?? { effect: 'none', duration: 0 },
      });
    }
    fonts = svg?.fontCss() ?? '';
  } finally {
    svg?.dispose();
  }
  return {
    data: { title, slides: compiled, fonts: fonts || undefined },
    dispose: () => urls.forEach((url) => URL.revokeObjectURL(url)),
  };
}
