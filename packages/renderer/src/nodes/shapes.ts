import type { CanvasKit, Path } from 'canvaskit-wasm';
import type { EllipseNode, PathNode, RectNode } from '@shiba/core';
import type { NodeTypeDef } from '../node-types';

export const rectType: NodeTypeDef<RectNode> = {
  type: 'rect',
  children: 'none',
  outline(node, { ck }) {
    const [w, h] = node.size;
    const builder = new ck.PathBuilder();
    const r = Math.max(0, Math.min(node.cornerRadius, w / 2, h / 2));
    if (r > 0) builder.addRRect(ck.RRectXY(ck.XYWHRect(0, 0, w, h), r, r));
    else builder.addRect(ck.XYWHRect(0, 0, w, h));
    return finish(builder);
  },
};

export const ellipseType: NodeTypeDef<EllipseNode> = {
  type: 'ellipse',
  children: 'none',
  outline(node, { ck }) {
    const builder = new ck.PathBuilder();
    builder.addOval(ck.XYWHRect(0, 0, node.size[0], node.size[1]));
    return finish(builder);
  },
};

export const pathType: NodeTypeDef<PathNode> = {
  type: 'path',
  children: 'none',
  outline(node, { ck }) {
    return buildPath(ck, node.subpaths, node.fillRule);
  },
};

/** 把锚点模型转成 Skia 路径。编辑器里钢笔工具的预览也用它 */
export function buildPath(ck: CanvasKit, subpaths: PathNode['subpaths'], fillRule: PathNode['fillRule']): Path {
  const builder = new ck.PathBuilder();
  for (const sub of subpaths) {
    const first = sub.anchors[0];
    if (!first) continue;
    builder.moveTo(first.x, first.y);
    for (let i = 1; i < sub.anchors.length; i++) {
      segment(builder, sub.anchors[i - 1]!, sub.anchors[i]!);
    }
    if (sub.closed && sub.anchors.length > 1) {
      segment(builder, sub.anchors[sub.anchors.length - 1]!, first);
      builder.close();
    }
  }
  if (fillRule === 'evenodd') builder.setFillType(ck.FillType.EvenOdd);
  return finish(builder);
}

type Builder = InstanceType<CanvasKit['PathBuilder']>;
type AnchorLike = PathNode['subpaths'][number]['anchors'][number];

function segment(builder: Builder, from: AnchorLike, to: AnchorLike): void {
  const straight = from.outX === from.x && from.outY === from.y && to.inX === to.x && to.inY === to.y;
  if (straight) builder.lineTo(to.x, to.y);
  else builder.cubicTo(from.outX, from.outY, to.inX, to.inY, to.x, to.y);
}

function finish(builder: Builder): Path {
  const path = builder.detach();
  builder.delete();
  return path;
}
