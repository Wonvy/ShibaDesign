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
  type PathNode,
} from '@shiba/core';
import { buildPath } from '@shiba/renderer';
import { DEFAULT_FILL, DEFAULT_STROKE } from '../ops';
import { anchorKey, deleteAnchors, normalizePath, segmentAt, splitSegment } from '../path-edit';
import type { Editor } from '../editor';
import type { PointerInfo } from '../types';
import { createPathDrawingTool } from './path-drawing';
import type { Tool } from './tool';

/** 钢笔停在选中路径的锚点、线段上多近算点中，屏幕像素 */
const EDIT_HIT = 6;

/** 钢笔在选中的路径上：停在锚点上是删锚点，停在线段上是加锚点 */
function editTarget(
  editor: Editor,
  e: PointerInfo,
): {
  node: PathNode;
  action: { kind: 'delete'; key: string } | { kind: 'add'; sub: number; index: number; t: number };
} | null {
  const nodes = editor.selectedNodes();
  const node = nodes.length === 1 ? nodes[0] : undefined;
  if (node?.type !== 'path' || node.locked) return null;
  const world = worldTransform(editor.store, node.id);
  const inverse = invert(world);
  if (!inverse) return null;
  for (let s = 0; s < node.subpaths.length; s++) {
    const anchors = node.subpaths[s]!.anchors;
    for (let i = 0; i < anchors.length; i++) {
      const [wx, wy] = applyToPoint(world, anchors[i]!.x, anchors[i]!.y);
      const p = editor.worldToScreen(wx, wy);
      if (Math.hypot(p.x - e.x, p.y - e.y) <= EDIT_HIT)
        return { node, action: { kind: 'delete', key: anchorKey(s, i) } };
    }
  }
  const [lx, ly] = applyToPoint(inverse, e.world.x, e.world.y);
  const scale = Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2])) * editor.camera.zoom;
  const hit = segmentAt(node.subpaths, { x: lx, y: ly }, EDIT_HIT / scale);
  return hit ? { node, action: { kind: 'add', ...hit } } : null;
}

/**
 * 钢笔工具：画出来的路径成为一个钢笔路径节点，放进第一个锚点所在的画板（画板外是页面）。
 * 闭合的路径默认有填充，开放的只有描边。怎么画见 path-drawing.ts
 */
export function createPenTool(): Tool {
  return createPathDrawingTool({
    id: 'pen',
    hoverCursor(editor, e) {
      const target = editTarget(editor, e);
      return target ? (target.action.kind === 'add' ? 'copy' : 'not-allowed') : null;
    },
    editExisting(editor, e) {
      const target = editTarget(editor, e);
      if (!target) return false;
      const { node, action } = target;
      const subpaths =
        action.kind === 'add'
          ? splitSegment(node.subpaths, action.sub, action.index, action.t)
          : deleteAnchors(node.subpaths, new Set([action.key]));
      if (subpaths.length === 0) return true;
      const normalized = normalizePath(editor, node, subpaths);
      editor.store.transact(action.kind === 'add' ? 'add anchor' : 'delete anchor', (tx) =>
        tx.update(node.id, normalized),
      );
      editor.store.sealHistory();
      return true;
    },
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
