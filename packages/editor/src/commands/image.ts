import { createNode, nextSeq, rectCenter, translation, type ImageFit, type Point, type Rect } from '@shiba/core';
import type { Editor } from '../editor';
import { localOrigin } from '../ops';
import type { Command } from './command';

/** 放进画板的图片最多占画板的这个比例，再大就等比缩小 */
const MAX_COVERAGE = 0.8;

/**
 * 把资源库里的一张图片放到画布上。
 * 图片不是单独的节点类型：放上去的是一个用这张图片作填充的矩形，之后可以改圆角、换成别的形状作蒙版。
 */
export const placeImage: Command<{ assetId: string; at?: Point }> = {
  id: 'image.place',
  enabled: (editor, args) => editor.assets.has(args.assetId),
  run(editor, { assetId, at }) {
    const meta = editor.assets.meta(assetId);
    if (!meta) return;
    const { store } = editor;

    const center = at ?? defaultCenter(editor);
    const container = editor.containerAt(center);
    let width = meta.width;
    let height = meta.height;
    if (container.type === 'artboard') {
      const limit = Math.min(
        (container.size[0] * MAX_COVERAGE) / width,
        (container.size[1] * MAX_COVERAGE) / height,
        1,
      );
      width *= limit;
      height *= limit;
    }
    const rect: Rect = { x: center.x - width / 2, y: center.y - height / 2, w: width, h: height };
    const origin = localOrigin(store, container.id, rect);

    const node = createNode('rect', {
      parent: container.id,
      index: store.indexOnTop(container.id),
      seq: nextSeq(store, 'rect'),
      ...(meta.name ? { name: stripExtension(meta.name) } : {}),
      transform: translation(origin.x, origin.y),
      size: [width, height],
      fill: { type: 'image', assetId, fit: 'cover' },
      stroke: null,
      cornerRadius: 0,
    });
    store.transact('place image', (tx) => tx.create(node));
    store.sealHistory();
    editor.setTool('select');
    editor.select([node.id]);
  },
};

/** 把选中形状的填充换成一张图片 */
export const setImageFill: Command<{ assetId: string; fit?: ImageFit }> = {
  id: 'image.setFill',
  enabled: (editor, args) => editor.assets.has(args.assetId) && editor.selectedNodes().some(canHoldImage),
  run(editor, { assetId, fit }) {
    editor.updateSelection('image fill', (node) => {
      if (!canHoldImage(node)) return null;
      const current = 'fill' in node && node.fill?.type === 'image' ? node.fill.fit : 'cover';
      return { fill: { type: 'image', assetId, fit: fit ?? current } };
    });
    editor.store.sealHistory();
  },
};

/** 形状类节点和画框才能用图片作填充；画板和文本目前只支持纯色 */
function canHoldImage(node: { type: string }): boolean {
  return ['rect', 'ellipse', 'polygon', 'path', 'boolean', 'frame'].includes(node.type);
}

/** 没指定位置时：放在当前画板的中央；没有画板就放在视口中央 */
function defaultCenter(editor: Editor): Point {
  const board = editor.activeArtboard;
  if (board) return rectCenter(editor.geometry.worldBounds(board));
  return editor.screenToWorld(editor.viewport.width / 2, editor.viewport.height / 2);
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).slice(0, 80);
}
