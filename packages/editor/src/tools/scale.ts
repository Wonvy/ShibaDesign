import {
  hasLiveAppearance,
  topLevelOnly,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import type { Editor } from '../editor';
import { drawPill, formatNumber } from '../overlay-guides';
import { captureOriginals } from '../resize';
import { scaleUniform } from '../scale';
import type { Tool } from './tool';

const MIN_SCALE = 0.01;

const xy = (p: Point): [number, number] => [p.x, p.y];

interface Drag {
  pivot: Point;
  start: number;
  from: Rect;
  ids: NodeId[];
  originals: Map<NodeId, SceneNode>;
  key: string;
  at: Point;
  k: number;
}

/** 缩放中心的标记：一个小十字加圆圈，屏幕像素 */
const MARK = 6;

/**
 * 缩放工具（K）：在画布上按住拖动，选中的对象等比缩放，描边、圆角、字号跟着按比例变。
 * 缩放中心默认是选区中心，按住 Alt 单击可以换一个中心（换了选择就回到选区中心）。拖动时显示百分比，Esc 取消
 */
export function createScaleTool(): Tool {
  let drag: Drag | null = null;
  /** Alt 单击定下的缩放中心，和定下时的选择（选择变了就作废） */
  let origin: { point: Point; selection: string } | null = null;

  const pivotOf = (editor: Editor, from: Rect): Point =>
    origin && origin.selection === editor.selection.join(',')
      ? origin.point
      : { x: from.x + from.w / 2, y: from.y + from.h / 2 };

  return {
    id: 'scale',
    cursor: 'nwse-resize',

    onDeactivate() {
      drag = null;
      origin = null;
    },

    onCancel(editor) {
      if (drag) editor.store.abandon(drag.key);
      drag = null;
    },

    onPointerDown(e, editor) {
      const from = editor.selectionBounds();
      if (!from) return;
      const { store } = editor;
      const ids = topLevelOnly(store, editor.selection).filter((id) => store.get(id)?.type !== 'artboard');
      if (ids.length === 0) return;
      if (e.alt) {
        origin = { point: e.world, selection: editor.selection.join(',') };
        editor.requestRender();
        return;
      }
      const pivot = pivotOf(editor, from);
      const start = Math.hypot(e.world.x - pivot.x, e.world.y - pivot.y);
      if (start < 1e-6) return;
      const textWidth = (node: TextNode): number =>
        hasLiveAppearance(node) ? node.size[0] : editor.textLayouts.get(node).width;
      drag = {
        pivot,
        start,
        from,
        ids,
        originals: captureOriginals(store, ids, textWidth),
        key: editor.newMergeKey('scale'),
        at: { x: e.x, y: e.y },
        k: 1,
      };
    },

    onPointerMove(e, editor) {
      if (!e.down || !drag) return;
      const current = drag;
      const k = Math.max(
        MIN_SCALE,
        Math.hypot(e.world.x - current.pivot.x, e.world.y - current.pivot.y) / current.start,
      );
      current.k = k;
      current.at = { x: e.x, y: e.y };
      const { store } = editor;
      store.transact(
        'scale',
        (tx) => scaleUniform(tx, store, current.originals, current.ids, current.from, current.pivot, k),
        { mergeKey: current.key },
      );
    },

    onPointerUp(_e, editor) {
      if (drag) editor.store.sealHistory();
      drag = null;
    },

    drawOverlay(ctx, editor) {
      const from = drag?.from ?? editor.selectionBounds();
      if (from) {
        const p = editor.worldToScreen(...xy(drag?.pivot ?? pivotOf(editor, from)));
        ctx.save();
        ctx.strokeStyle = editor.theme.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, MARK / 2, 0, Math.PI * 2);
        ctx.moveTo(p.x - MARK, p.y);
        ctx.lineTo(p.x + MARK, p.y);
        ctx.moveTo(p.x, p.y - MARK);
        ctx.lineTo(p.x, p.y + MARK);
        ctx.stroke();
        ctx.restore();
      }
      if (!drag) return;
      drawPill(ctx, `${formatNumber(drag.k * 100)}%`, drag.at.x + 24, drag.at.y + 18, editor.theme.accent);
    },
  };
}
