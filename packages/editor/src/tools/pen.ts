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
  type NodeId,
  type Point,
} from '@shiba/core';
import { buildPath } from '@shiba/renderer';
import type { Editor } from '../editor';
import { DEFAULT_FILL, DEFAULT_STROKE } from '../ops';
import type { PointerInfo } from '../types';
import type { Tool } from './tool';

const CLOSE_RADIUS = 8;

/**
 * 钢笔工具。
 * - 单击：添加直线锚点；按住拖动：拉出对称的曲线控制柄
 * - 点回第一个锚点：闭合路径；点最后一个锚点或按回车 / Esc：结束开放路径
 * - 退格：删掉最后一个锚点
 * 绘制过程中锚点只存在工具里，结束时才写入文档，所以整条路径是一步撤销。
 */
export function createPenTool(): Tool {
  let anchors: Anchor[] = [];
  let containerId: NodeId | null = null;
  let dragging = false;
  let hover: Point | null = null;

  const reset = (): void => {
    anchors = [];
    containerId = null;
    dragging = false;
    hover = null;
  };

  const isNear = (editor: Editor, anchor: Anchor, e: PointerInfo): boolean => {
    const s = editor.worldToScreen(anchor.x, anchor.y);
    return Math.hypot(s.x - e.x, s.y - e.y) <= CLOSE_RADIUS;
  };

  const finish = (editor: Editor, closed: boolean): void => {
    const points = anchors;
    const container = containerId;
    reset();
    if (points.length < 2 || !container || !editor.store.has(container)) return;

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
  };

  return {
    id: 'pen',
    cursor: 'crosshair',

    onDeactivate(editor) {
      finish(editor, false);
    },

    onPointerDown(e, editor) {
      const first = anchors[0];
      const last = anchors[anchors.length - 1];
      if (first && anchors.length >= 2 && isNear(editor, first, e)) {
        finish(editor, true);
        return;
      }
      if (last && isNear(editor, last, e)) {
        finish(editor, false);
        return;
      }
      if (anchors.length === 0) containerId = editor.containerAt(e.world).id;
      const { x, y } = e.world;
      anchors.push({ x, y, inX: x, inY: y, outX: x, outY: y });
      dragging = true;
    },

    onPointerMove(e, editor) {
      hover = e.world;
      const last = anchors[anchors.length - 1];
      if (dragging && e.down && last) {
        last.outX = e.world.x;
        last.outY = e.world.y;
        last.inX = 2 * last.x - e.world.x;
        last.inY = 2 * last.y - e.world.y;
      }
      if (anchors.length > 0) editor.requestRender();
    },

    onPointerUp() {
      dragging = false;
    },

    onKeyDown(event, editor) {
      if (event.key === 'Enter') {
        finish(editor, false);
        return true;
      }
      if (event.key === 'Escape') {
        if (anchors.length > 0) finish(editor, false);
        else editor.setTool('select');
        return true;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && anchors.length > 0) {
        anchors.pop();
        if (anchors.length === 0) reset();
        return true;
      }
      return false;
    },

    drawOverlay(ctx, editor) {
      const first = anchors[0];
      if (!first) return;
      const s = (x: number, y: number): Point => editor.worldToScreen(x, y);
      ctx.save();
      ctx.strokeStyle = editor.theme.accent;
      ctx.fillStyle = editor.theme.handleFill;
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      const p0 = s(first.x, first.y);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < anchors.length; i++) {
        const prev = anchors[i - 1]!;
        const cur = anchors[i]!;
        const c1 = s(prev.outX, prev.outY);
        const c2 = s(cur.inX, cur.inY);
        const p = s(cur.x, cur.y);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
      }
      const last = anchors[anchors.length - 1]!;
      if (hover && !dragging) {
        const c1 = s(last.outX, last.outY);
        const p = s(hover.x, hover.y);
        ctx.bezierCurveTo(c1.x, c1.y, p.x, p.y, p.x, p.y);
      }
      ctx.stroke();

      // 当前锚点的两根控制柄
      if (last.outX !== last.x || last.outY !== last.y) {
        const a = s(last.inX, last.inY);
        const b = s(last.outX, last.outY);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        for (const h of [a, b]) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      ctx.lineWidth = 1.5;
      for (const anchor of anchors) {
        const p = s(anchor.x, anchor.y);
        ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
        ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
      }
      ctx.restore();
    },
  };
}
