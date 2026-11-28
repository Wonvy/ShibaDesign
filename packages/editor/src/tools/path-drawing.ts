import type { Anchor, Point } from '@shiba/core';
import type { Editor } from '../editor';
import type { PointerInfo } from '../types';
import type { Tool } from './tool';

const CLOSE_RADIUS = 8;

export interface PathDrawingOptions {
  id: string;
  /**
   * 开始画时就定下来的第一个锚点（世界坐标），比如动作路径从对象中心出发。
   * 不提供或返回 null 时，第一次单击放下第一个锚点
   */
  start?(editor: Editor): Point | null;
  /**
   * 画完了：锚点是世界坐标，至少两个。点回第一个锚点是闭合路径，
   * 点最后一个锚点、按回车、按 Esc、换工具是开放路径
   */
  finish(editor: Editor, anchors: Anchor[], closed: boolean): void;
  /** 什么都没画（不到两个锚点）就结束了 */
  cancel?(editor: Editor): void;
}

const corner = (p: Point): Anchor => ({ x: p.x, y: p.y, inX: p.x, inY: p.y, outX: p.x, outY: p.y });

/**
 * 用钢笔的方式画一条路径，钢笔工具和画动作路径的工具共用：
 * - 单击：添加直线锚点；按住拖动：拉出对称的曲线控制柄
 * - 点回第一个锚点：闭合路径；点最后一个锚点或按回车 / Esc：结束开放路径
 * - 退格：删掉最后一个锚点（开始时定下的第一个锚点删不掉）
 * 画的过程中锚点只存在工具里，结束时才交给 finish 写进文档，所以整条路径是一步撤销
 */
export function createPathDrawingTool(options: PathDrawingOptions): Tool {
  let anchors: Anchor[] = [];
  /** 开始时定下的锚点个数（0 或 1） */
  let fixed = 0;
  let dragging = false;
  let hover: Point | null = null;

  const reset = (): void => {
    anchors = [];
    fixed = 0;
    dragging = false;
    hover = null;
  };

  const begin = (editor: Editor): void => {
    reset();
    const start = options.start?.(editor) ?? null;
    if (start) {
      anchors = [corner(start)];
      fixed = 1;
    }
  };

  const isNear = (editor: Editor, anchor: Anchor, e: PointerInfo): boolean => {
    const s = editor.worldToScreen(anchor.x, anchor.y);
    return Math.hypot(s.x - e.x, s.y - e.y) <= CLOSE_RADIUS;
  };

  const end = (editor: Editor, closed: boolean): void => {
    const points = anchors;
    reset();
    if (points.length >= 2) options.finish(editor, points, closed);
    else options.cancel?.(editor);
  };

  return {
    id: options.id,
    cursor: 'crosshair',

    onActivate(editor) {
      begin(editor);
      editor.requestRender();
    },

    onDeactivate(editor) {
      // 换工具时画到一半的路径照样保存（和以前的钢笔工具一样）
      if (anchors.length > fixed) end(editor, false);
      else reset();
    },

    onPointerDown(e, editor) {
      const first = anchors[0];
      const last = anchors[anchors.length - 1];
      if (first && anchors.length >= 2 && isNear(editor, first, e)) {
        end(editor, true);
        return;
      }
      if (last && anchors.length > fixed && isNear(editor, last, e)) {
        end(editor, false);
        return;
      }
      anchors.push(corner(e.world));
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
        end(editor, false);
        return true;
      }
      if (event.key === 'Escape') {
        if (anchors.length > fixed) end(editor, false);
        else {
          reset();
          options.cancel?.(editor);
          if (editor.getState().tool === options.id) editor.setTool('select');
        }
        return true;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && anchors.length > fixed) {
        anchors.pop();
        editor.requestRender();
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
