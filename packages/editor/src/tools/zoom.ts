import { rectFromPoints, type Point } from '@shiba/core';
import type { Tool } from './tool';

const DRAG_THRESHOLD = 5;

/** 视图缩放（Z）：单击放大一倍，按住 Alt 单击缩小一半，拖出一个框缩放到正好放下这个框 */
export function createZoomTool(): Tool {
  let start: { x: number; y: number; world: Point } | null = null;
  let current: Point | null = null;

  return {
    id: 'zoom',
    cursor: 'zoom-in',

    onDeactivate() {
      start = null;
      current = null;
    },

    onCancel() {
      start = null;
      current = null;
    },

    onPointerDown(e) {
      start = { x: e.x, y: e.y, world: e.world };
      current = e.world;
    },

    onPointerMove(e, editor) {
      if (!e.down) {
        editor.setCursor(e.alt ? 'zoom-out' : 'zoom-in');
        return;
      }
      current = e.world;
      editor.requestRender();
    },

    onPointerUp(e, editor) {
      const from = start;
      start = null;
      current = null;
      if (!from) return;
      if (Math.hypot(e.x - from.x, e.y - from.y) >= DRAG_THRESHOLD) {
        editor.zoomToFit(rectFromPoints(from.world.x, from.world.y, e.world.x, e.world.y));
        return;
      }
      editor.zoomAt(e.x, e.y, e.alt ? 0.5 : 2);
    },

    drawOverlay(ctx, editor) {
      if (!start || !current) return;
      const a = editor.worldToScreen(start.world.x, start.world.y);
      const b = editor.worldToScreen(current.x, current.y);
      const rect = rectFromPoints(a.x, a.y, b.x, b.y);
      if (rect.w < DRAG_THRESHOLD && rect.h < DRAG_THRESHOLD) return;
      ctx.save();
      ctx.strokeStyle = editor.theme.accent;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.round(rect.w), Math.round(rect.h));
      ctx.restore();
    },
  };
}
