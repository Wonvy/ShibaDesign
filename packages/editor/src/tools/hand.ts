import type { Tool } from './tool';

/** 抓手工具：拖动平移画布 */
export function createHandTool(): Tool {
  let last: { x: number; y: number } | null = null;

  return {
    id: 'hand',
    cursor: 'grab',

    onDeactivate() {
      last = null;
    },

    onPointerDown(e, editor) {
      last = { x: e.x, y: e.y };
      editor.setCursor('grabbing');
    },

    onPointerMove(e, editor) {
      if (!e.down || !last) return;
      editor.panBy(e.x - last.x, e.y - last.y);
      last = { x: e.x, y: e.y };
    },

    onPointerUp(_e, editor) {
      last = null;
      editor.setCursor('grab');
    },
  };
}
