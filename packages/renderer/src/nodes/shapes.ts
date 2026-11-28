import type { CanvasKit, Path } from 'canvaskit-wasm';
import {
  hasRoundedAnchors,
  polygonOutline,
  type PolygonNode,
  rectCornerRadii,
  rectNeedsCorners,
  rectOutline,
  roundSubpaths,
  type EllipseNode,
  type FrameNode,
  type PathNode,
  type RectNode,
} from '@shiba/core';
import type { NodeTypeDef } from '../node-types';

/** 矩形和画框的轮廓：四个角一样的普通圆角用 Skia 自己的圆角矩形，其余按 corners.ts 生成锚点 */
export function boxOutline(ck: CanvasKit, node: RectNode | FrameNode): Path {
  const [w, h] = node.size;
  // 四个角不一样、反向圆角、倒角、平滑度：按 corners.ts 生成锚点
  if (rectNeedsCorners(node)) {
    const options = { style: node.cornerStyle, smoothing: node.cornerSmoothing };
    return buildPath(ck, [rectOutline(w, h, rectCornerRadii(node), options)], 'nonzero');
  }
  const builder = new ck.PathBuilder();
  const r = Math.max(0, Math.min(node.cornerRadius, w / 2, h / 2));
  if (r > 0) builder.addRRect(ck.RRectXY(ck.XYWHRect(0, 0, w, h), r, r));
  else builder.addRect(ck.XYWHRect(0, 0, w, h));
  return finish(builder);
}

export const rectType: NodeTypeDef<RectNode> = {
  type: 'rect',
  children: 'none',
  outline: (node, { ck }) => boxOutline(ck, node),
};

/**
 * 画框：先画自己的填充，再画子节点（裁剪时按自己的轮廓裁），最后画描边。
 * 边界、命中按自己的轮廓算，点在画框的空白处也点得中它
 */
export const frameType: NodeTypeDef<FrameNode> = {
  type: 'frame',
  children: 'clip',
  clips: (node) => node.clip,
  strokeOver: true,
  outline: (node, { ck }) => boxOutline(ck, node),
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

export const polygonType: NodeTypeDef<PolygonNode> = {
  type: 'polygon',
  children: 'none',
  outline(node, { ck }) {
    return buildPath(ck, [polygonOutline(node)], 'nonzero');
  },
};

export const pathType: NodeTypeDef<PathNode> = {
  type: 'path',
  children: 'none',
  outline(node, { ck }) {
    // 锚点带圆角半径时先换成普通锚点
    const subpaths = hasRoundedAnchors(node.subpaths)
      ? roundSubpaths(node.subpaths, { style: node.cornerStyle, smoothing: node.cornerSmoothing })
      : node.subpaths;
    return buildPath(ck, subpaths, node.fillRule);
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
