import type { ArtboardNode, PageNode } from '@shiba/core';
import type { NodeTypeDef } from '../node-types';
import { toSkColor } from '../skia';

export const pageType: NodeTypeDef<PageNode> = {
  type: 'page',
  children: 'draw',
  outline(_node, { ck }) {
    return new ck.Path();
  },
  draw() {
    // 页面本身不画任何东西
  },
};

export const artboardType: NodeTypeDef<ArtboardNode> = {
  type: 'artboard',
  children: 'clip',
  outline(node, { ck }) {
    const builder = new ck.PathBuilder();
    builder.addRect(ck.XYWHRect(0, 0, node.size[0], node.size[1]));
    const path = builder.detach();
    builder.delete();
    return path;
  },
  draw(node, { ck, canvas, outline, paint, opacity, blendMode }) {
    if (!node.fill) return;
    paint.setStyle(ck.PaintStyle.Fill);
    paint.setColor(toSkColor(ck, node.fill.color, opacity));
    paint.setBlendMode(blendMode);
    canvas.drawPath(outline, paint);
  },
};
