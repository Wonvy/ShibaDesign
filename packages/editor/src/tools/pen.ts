import {
  IDENTITY,
  applyToPoint,
  createNode,
  invert,
  nextSeq,
  solid,
  translation,
  worldTransform,
  type Anchor,
} from '@shiba/core';
import { buildPath } from '@shiba/renderer';
import { DEFAULT_FILL, DEFAULT_STROKE } from '../ops';
import { createPathDrawingTool } from './path-drawing';
import type { Tool } from './tool';

/**
 * 钢笔工具：画出来的路径成为一个钢笔路径节点，放进第一个锚点所在的画板（画板外是页面）。
 * 闭合的路径默认有填充，开放的只有描边。怎么画见 path-drawing.ts
 */
export function createPenTool(): Tool {
  return createPathDrawingTool({
    id: 'pen',
    finish(editor, points, closed) {
      const first = points[0]!;
      const container = editor.containerAt({ x: first.x, y: first.y }).id;
      const { store } = editor;
      const inverse = invert(worldTransform(store, container)) ?? IDENTITY;
      const local = points.map((a): Anchor => {
        const [x, y] = applyToPoint(inverse, a.x, a.y);
        const [inX, inY] = applyToPoint(inverse, a.inX, a.inY);
        const [outX, outY] = applyToPoint(inverse, a.outX, a.outY);
        return { x, y, inX, inY, outX, outY };
      });

      // 用真实曲线的紧致边界确定节点的位置和大小，再把锚点平移到节点本地坐标
      const probe = buildPath(editor.ck, [{ closed, anchors: local }], 'nonzero');
      const bounds = probe.computeTightBounds();
      probe.delete();
      const ox = bounds[0]!;
      const oy = bounds[1]!;
      const shifted = local.map((a) => ({
        x: a.x - ox,
        y: a.y - oy,
        inX: a.inX - ox,
        inY: a.inY - oy,
        outX: a.outX - ox,
        outY: a.outY - oy,
      }));

      const node = createNode('path', {
        parent: container,
        index: store.indexOnTop(container),
        seq: nextSeq(store, 'path'),
        transform: translation(ox, oy),
        size: [bounds[2]! - ox, bounds[3]! - oy],
        subpaths: [{ closed, anchors: shifted }],
        fillRule: 'nonzero',
        fill: closed ? solid(DEFAULT_FILL) : null,
        stroke: { color: DEFAULT_STROKE, width: 2 },
      });
      store.transact('pen', (tx) => tx.create(node));
      store.sealHistory();
      editor.select([node.id]);
    },
  });
}
