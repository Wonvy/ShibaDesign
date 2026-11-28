import type { Anchor, Point } from '@shiba/core';
import type { Editor } from '../editor';
import type { PointerInfo } from '../types';
import { snapPoint } from '../snap';
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
  /**
   * 还没开始画的时候按下：返回 true 表示这一下已经处理了（钢笔在选中的路径上加、删锚点），不再开始画新路径
   */
  editExisting?(editor: Editor, e: PointerInfo): boolean;
  /** 还没开始画时鼠标停在这里的指针样子；null 用默认的十字 */
  hoverCursor?(editor: Editor, e: PointerInfo): string | null;
}

const corner = (p: Point): Anchor => ({ x: p.x, y: p.y, inX: p.x, inY: p.y, outX: p.x, outY: p.y });

/** 按住 Shift：从 from 到 to 的方向锁定在 45° 的倍数上，长度取在这个方向上的投影 */
function constrain45(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const length = dx * Math.cos(angle) + dy * Math.sin(angle);
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

/**
 * 用钢笔的方式画一条路径，钢笔工具和画动作路径的工具共用：
 * - 单击：添加直线锚点；按住拖动：拉出对称的曲线控制柄
 * - 按住 Shift：新锚点相对上一个锚点、控制柄相对锚点锁定在 45° 的倍数上；按住 Alt 拖控制柄只动出去的那根（断开对称）；
 *   拖控制柄时按住空格挪动正在放的这个锚点；按着 ⌘ 时不吸附
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
  /** 上一次的鼠标位置，按住空格挪动锚点时用 */
  let lastPointer: Point | null = null;

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
      if (anchors.length === fixed && options.editExisting?.(editor, e)) return;
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
      // 新放的锚点吸附到附近的边和中线（按着 ⌘ 时不吸）；按住 Shift 时相对上一个锚点锁定 45°
      let at = e.world;
      if (e.shift && last) {
        at = constrain45(last, e.world);
      } else if (editor.snapping && !e.mod) {
        at = snapPoint(editor.snapTargets([]), e.world, {
          threshold: editor.snapThreshold,
          pixels: editor.view.snapPixels,
        }).point;
      }
      anchors.push(corner(at));
      dragging = true;
      lastPointer = e.world;
    },

    onPointerMove(e, editor) {
      if (!e.down && anchors.length === fixed && options.hoverCursor) {
        editor.setCursor(options.hoverCursor(editor, e) ?? 'crosshair');
      }
      hover = e.world;
      const last = anchors[anchors.length - 1];
      if (dragging && e.down && last) {
        if (e.space && lastPointer) {
          // 按住空格：整个锚点连同控制柄一起挪
          const dx = e.world.x - lastPointer.x;
          const dy = e.world.y - lastPointer.y;
          last.x += dx;
          last.y += dy;
          last.inX += dx;
          last.inY += dy;
          last.outX += dx;
          last.outY += dy;
        } else {
          const handle = e.shift ? constrain45(last, e.world) : e.world;
          last.outX = handle.x;
          last.outY = handle.y;
          // 按住 Alt：只动出去的那根控制柄，进来的那根留在原处
          if (!e.alt) {
            last.inX = 2 * last.x - handle.x;
            last.inY = 2 * last.y - handle.y;
          }
        }
        lastPointer = e.world;
      }
      if (anchors.length > 0) editor.requestRender();
    },

    onPointerUp() {
      dragging = false;
    },

    onCancel(editor) {
      // 拖控制柄拖到一半取消：这次单击放下的锚点也不要了
      if (dragging && anchors.length > fixed) anchors.pop();
      dragging = false;
      editor.requestRender();
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
