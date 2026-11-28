import type { CanvasKit, Path } from 'canvaskit-wasm';
import { arrowGeometry, arrowMetrics, hasRoundedAnchors, roundSubpaths, type SceneNode } from '@shiba/core';
import { buildPath } from './nodes/shapes';

/**
 * 箭头的 Skia 路径：缩短过的线（拿去描边）和箭头本身（按描边的颜色填充）。三个后端（画布、PDF、SVG）都用它，
 * 画出来一样。不是开放的钢笔路径、或者描边上没有箭头时返回 null。调用方用完要 delete 两条路径
 */
export function arrowPaths(ck: CanvasKit, node: SceneNode): { line: Path; heads: Path } | null {
  if (node.type !== 'path' || !node.stroke || !(node.stroke.width > 0)) return null;
  if (!node.stroke.arrowStart && !node.stroke.arrowEnd) return null;
  const subpaths = hasRoundedAnchors(node.subpaths)
    ? roundSubpaths(node.subpaths, { style: node.cornerStyle, smoothing: node.cornerSmoothing })
    : node.subpaths;
  const geometry = arrowGeometry(subpaths, node.stroke);
  if (!geometry) return null;
  const line = buildPath(ck, geometry.line, node.fillRule);
  const builder = new ck.PathBuilder();
  for (const { head, tip, dir, width } of geometry.arrows) {
    const { length, half } = arrowMetrics(head, width);
    const n = { x: -dir.y, y: dir.x };
    const at = (along: number, across: number): [number, number] => [
      tip.x + dir.x * along + n.x * across,
      tip.y + dir.y * along + n.y * across,
    ];
    if (head === 'triangle') {
      builder.moveTo(...at(0, 0));
      builder.lineTo(...at(-length, half));
      builder.lineTo(...at(-length, -half));
      builder.close();
    } else if (head === 'circle') {
      builder.addOval(ck.XYWHRect(tip.x - length, tip.y - length, length * 2, length * 2));
    } else if (head === 'square') {
      builder.moveTo(...at(length, length));
      builder.lineTo(...at(length, -length));
      builder.lineTo(...at(-length, -length));
      builder.lineTo(...at(-length, length));
      builder.close();
    } else {
      // 开口的箭头、横杠：画一条折线，再按线宽描成轮廓，和线本身一样粗
      const stroke = new ck.PathBuilder();
      if (head === 'arrow') {
        stroke.moveTo(...at(-length, half));
        stroke.lineTo(...at(0, 0));
        stroke.lineTo(...at(-length, -half));
      } else {
        stroke.moveTo(...at(0, half));
        stroke.lineTo(...at(0, -half));
      }
      const open = stroke.detach();
      stroke.delete();
      const outline = open.makeStroked({
        width,
        cap: head === 'arrow' ? ck.StrokeCap.Round : ck.StrokeCap.Butt,
        join: ck.StrokeJoin.Round,
      });
      open.delete();
      if (outline) {
        builder.addPath(outline);
        outline.delete();
      }
    }
  }
  const heads = builder.detach();
  builder.delete();
  return { line, heads };
}
