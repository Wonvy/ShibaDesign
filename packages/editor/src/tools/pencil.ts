import type { Point } from '@shiba/core';
import { fitCurve } from '../curve-fit';
import { createPathFromAnchors } from './pen';
import type { Tool } from './tool';

/** 拟合允许偏离多远，屏幕像素 */
const TOLERANCE = 2.5;
/** 松手时离起点这么近算画了一个闭合的形状，屏幕像素 */
const CLOSE_DISTANCE = 10;

/**
 * 铅笔（⇧P）：按住拖动手画，松手后把画过的点拟合成平滑的贝塞尔曲线，结果是普通的钢笔路径，之后可以改锚点。
 * 松手时回到起点附近就是闭合的形状（有填充）
 */
export function createPencilTool(): Tool {
  let points: Point[] = [];
  let screen: Point[] = [];

  return {
    id: 'pencil',
    cursor: 'crosshair',

    onDeactivate() {
      points = [];
      screen = [];
    },

    onCancel(editor) {
      points = [];
      screen = [];
      editor.requestRender();
    },

    onPointerDown(e) {
      points = [e.world];
      screen = [{ x: e.x, y: e.y }];
    },

    onPointerMove(e, editor) {
      if (!e.down || points.length === 0) return;
      points.push(e.world);
      screen.push({ x: e.x, y: e.y });
      editor.requestRender();
    },

    onPointerUp(_e, editor) {
      const drawn = points;
      const path = screen;
      points = [];
      screen = [];
      if (drawn.length < 3) {
        editor.requestRender();
        return;
      }
      const tolerance = TOLERANCE / editor.camera.zoom;
      const first = path[0]!;
      const last = path[path.length - 1]!;
      const closed = path.length > 8 && Math.hypot(first.x - last.x, first.y - last.y) <= CLOSE_DISTANCE;
      const anchors = fitCurve(drawn, tolerance, closed);
      if (anchors.length < 2) return;
      if (closed && anchors.length > 2) {
        // 闭合：最后一个锚点和第一个重合，把它的入控制柄交给第一个，再去掉它
        const tail = anchors.pop()!;
        anchors[0] = { ...anchors[0]!, inX: tail.inX, inY: tail.inY };
      }
      createPathFromAnchors(editor, anchors, closed);
      if (!editor.toolLocked) editor.setTool('select');
    },

    drawOverlay(ctx, editor) {
      if (screen.length < 2) return;
      ctx.save();
      ctx.strokeStyle = editor.theme.accent;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(screen[0]!.x, screen[0]!.y);
      for (const p of screen.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.restore();
    },
  };
}
