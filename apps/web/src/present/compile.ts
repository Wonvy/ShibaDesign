import {
  multiply,
  scheduleAnimations,
  slides,
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
 * 每一页上的每个对象渲染成一张透明背景的图片（由和画布同一个渲染引擎生成，所以静态外观完全一致），
 * 动画列表排成带时刻和关键帧的步骤。
 */

export interface CompiledPresentation {
  data: PresentationData;
  /** 释放预览时创建的临时图片地址 */
  dispose(): void;
}

/** 图层图片的倍率：两倍图，在普通和高分屏上放大播放都够清晰 */
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
): Promise<CompiledPresentation> {
  const { store } = editor;
  const urls: string[] = [];
  const toSrc = (png: Uint8Array): string => {
    if (mode === 'export') return toDataUrl(png);
    const url = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' }));
    urls.push(url);
    return url;
  };

  const compiled: PlayerSlide[] = [];
  for (const slide of slides(store)) {
    if (!slide.visible) continue;
    const layers: PlayerLayer[] = [];
    const boxes = new Map<NodeId, Rect>();
    for (const node of store.children(slide.id)) {
      if (!node.visible) continue;
      const snapshot = await editor.snapshot(node.id, SNAPSHOT_SCALE);
      if (!snapshot) continue;
      // 图片对应的是节点本地坐标里的 box；把"本地坐标 → 幻灯片"的变换平移到 box 的左上角
      const m = multiply(node.transform, translation(snapshot.box.x, snapshot.box.y));
      layers.push({
        id: node.id,
        key: node.lineageId,
        src: toSrc(snapshot.png),
        width: snapshot.box.w,
        height: snapshot.box.h,
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
      background: slide.fill ? toCssColor(slide.fill.color) : 'transparent',
      layers,
      steps: schedule.steps.map((step) => step.map(({ target, ...rest }) => ({ layer: target, ...rest }))),
      transition: slide.deck?.transition ?? { effect: 'none', duration: 0 },
    });
  }

  return {
    data: { title, slides: compiled },
    dispose: () => urls.forEach((url) => URL.revokeObjectURL(url)),
  };
}
