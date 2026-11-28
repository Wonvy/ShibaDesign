import { DocStore, createNode, rgba, solid, type DocumentData } from '@shiba/core';

/**
 * 新建时的空白尺寸。slides 为 true 的是演示稿：画板是一页幻灯片，打开后进幻灯片视图。
 * group 是 ui 的是界面设计的屏幕尺寸，新建对话框里单独列一组，画框工具的预设也用它们
 */
export interface BlankPreset {
  id: string;
  size: readonly [number, number];
  slides: boolean;
  group?: 'ui';
}

/**
 * 1 个文档单位在导出 PDF 时是 1 点、导出图片和 SVG 时是 1 像素，所以印刷品按点（A4 是 595 × 842），
 * 屏幕上用的按像素。演示稿和以前的默认画板一样是 1280 × 720
 */
export const BLANK_PRESETS: readonly BlankPreset[] = [
  { id: 'slides169', size: [1280, 720], slides: true },
  { id: 'slides43', size: [1024, 768], slides: true },
  { id: 'a4Portrait', size: [595, 842], slides: false },
  { id: 'a4Landscape', size: [842, 595], slides: false },
  { id: 'poster', size: [1191, 1684], slides: false },
  { id: 'square', size: [1080, 1080], slides: false },
  { id: 'story', size: [1080, 1920], slides: false },
  { id: 'banner', size: [1500, 500], slides: false },
  // 界面：常见设备的逻辑像素尺寸
  { id: 'phone', size: [393, 852], slides: false, group: 'ui' },
  { id: 'android', size: [360, 800], slides: false, group: 'ui' },
  { id: 'tablet', size: [820, 1180], slides: false, group: 'ui' },
  { id: 'desktop', size: [1440, 1024], slides: false, group: 'ui' },
  { id: 'web', size: [1920, 1080], slides: false, group: 'ui' },
];

/** 只有一张白色空白画板的文档 */
export function blankDocument(preset: BlankPreset): DocumentData {
  const store = DocStore.create();
  store.transact('init', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size: preset.size,
        fill: solid(rgba(1, 1, 1)),
        deck: preset.slides ? { order: 'a0', notes: '' } : null,
      }),
    ),
  );
  return store.toJSON();
}
