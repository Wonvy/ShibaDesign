import type { ArtboardNode, GroupNode, PageNode } from '@shiba/core';
import type { NodeTypeDef } from '../node-types';
import { drawGradient } from '../gradient';
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

/** 编组：自己不画东西，也没有轮廓；边界和命中都来自子节点 */
export const groupType: NodeTypeDef<GroupNode> = {
  type: 'group',
  children: 'draw',
  outline(_node, { ck }) {
    return new ck.Path();
  },
  draw() {
    // 组本身没有外观
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
  draw(node, ctx) {
    const { ck, canvas, outline, paint, opacity, blendMode } = ctx;
    if (!node.fill) return;
    paint.setStyle(ck.PaintStyle.Fill);
    paint.setBlendMode(blendMode);
    if (node.fill.type === 'gradient') {
      drawGradient(node.fill, ctx);
      return;
    }
    paint.setColor(toSkColor(ck, node.fill.color, opacity));
    canvas.drawPath(outline, paint);
  },
};
