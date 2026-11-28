import {
  CORNER_STYLES,
  applyToPoint,
  canRoundAnchor,
  invert,
  isInstance,
  maxRectRadius,
  rectCornerRadii,
  worldTransform,
  type CornerStyle,
  type Matrix,
  type NodePatch,
  type PathNode,
  type Point,
  type RectNode,
} from '@shiba/core';
import type { Editor } from './editor';

/**
 * 画布上的圆角控件（像 Illustrator 的"实时转角"）：只选中一个矩形或者带尖角的路径、而且它在屏幕上够大时，
 * 每个能加圆角的角里面有一个小圆点。拖它所有的角一起变，按住 Alt 只改这一个角；Alt 单击换圆角样式。
 */

/** 控件的半径、点中的范围，屏幕像素 */
const WIDGET_RADIUS = 4;
const WIDGET_HIT = 7;
/** 半径是 0 时控件离角多远，屏幕像素 */
const WIDGET_OFFSET = 14;
/** 对象在屏幕上的短边小于这个时不显示控件 */
const MIN_SCREEN_SIZE = 40;

export interface CornerWidget {
  /** 矩形是第几个角（0 左上、1 右上、2 右下、3 左下）；路径是 [子路径, 锚点] 拼成的字符串 */
  key: string;
  /** 角的位置（节点本地坐标） */
  corner: Point;
  /** 角平分线的方向（指向图形里面） */
  bisector: Point;
  /** 夹角的一半 */
  half: number;
  radius: number;
  max: number;
}

export interface CornerTarget {
  node: RectNode | PathNode;
  world: Matrix;
  widgets: CornerWidget[];
}

const unit = (x: number, y: number): Point => {
  const l = Math.hypot(x, y);
  return l > 1e-12 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
};

/** 现在能不能显示圆角控件；能的话返回节点和每个角 */
export function cornerTarget(editor: Editor): CornerTarget | null {
  if (editor.getState().tool !== 'select' || editor.fillEditing) return null;
  const nodes = editor.selectedNodes();
  if (nodes.length !== 1) return null;
  const node = nodes[0]!;
  if (node.locked || isInstance(node) || (node.type !== 'rect' && node.type !== 'path')) return null;
  const world = worldTransform(editor.store, node.id);
  const scale = Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2])) * editor.camera.zoom;
  const [w, h] = node.size;
  if (Math.min(w, h) * scale < MIN_SCREEN_SIZE) return null;
  const widgets = node.type === 'rect' ? rectWidgets(node) : pathWidgets(node);
  return widgets.length > 0 ? { node, world, widgets } : null;
}

function rectWidgets(node: RectNode): CornerWidget[] {
  const [w, h] = node.size;
  const radii = rectCornerRadii(node);
  const max = maxRectRadius(w, h);
  const corners: [number, number, number, number][] = [
    [0, 0, 1, 1],
    [w, 0, -1, 1],
    [w, h, -1, -1],
    [0, h, 1, -1],
  ];
  return corners.map(([x, y, dx, dy], i) => ({
    key: String(i),
    corner: { x, y },
    bisector: unit(dx, dy),
    half: Math.PI / 4,
    radius: Math.min(radii[i]!, max),
    max,
  }));
}

function pathWidgets(node: PathNode): CornerWidget[] {
  const out: CornerWidget[] = [];
  node.subpaths.forEach((sub, s) => {
    const n = sub.anchors.length;
    sub.anchors.forEach((a, i) => {
      if (!canRoundAnchor(sub, i)) return;
      const before = sub.anchors[(i - 1 + n) % n]!;
      const after = sub.anchors[(i + 1) % n]!;
      const u = unit(before.x - a.x, before.y - a.y);
      const v = unit(after.x - a.x, after.y - a.y);
      const angle = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
      if (angle < 0.01 || Math.PI - angle < 0.01) return;
      const half = angle / 2;
      const room = Math.min(Math.hypot(before.x - a.x, before.y - a.y), Math.hypot(after.x - a.x, after.y - a.y)) / 2;
      out.push({
        key: `${s}:${i}`,
        corner: { x: a.x, y: a.y },
        bisector: unit(u.x + v.x, u.y + v.y),
        half,
        radius: a.radius ?? 0,
        max: room * Math.tan(half),
      });
    });
  });
  return out;
}

/** 控件在屏幕上的位置：圆角的圆心；半径是 0 时离角 WIDGET_OFFSET 像素 */
export function widgetScreen(editor: Editor, target: CornerTarget, widget: CornerWidget): Point {
  const scale =
    Math.sqrt(Math.abs(target.world[0] * target.world[3] - target.world[1] * target.world[2])) * editor.camera.zoom;
  const distance = Math.max(widget.radius / Math.sin(widget.half), WIDGET_OFFSET / scale);
  const local = {
    x: widget.corner.x + widget.bisector.x * distance,
    y: widget.corner.y + widget.bisector.y * distance,
  };
  const [wx, wy] = applyToPoint(target.world, local.x, local.y);
  return editor.worldToScreen(wx, wy);
}

/** 屏幕上的这一点落在哪个控件上 */
export function hitCornerWidget(
  editor: Editor,
  x: number,
  y: number,
): { target: CornerTarget; widget: CornerWidget } | null {
  const target = cornerTarget(editor);
  if (!target) return null;
  for (const widget of target.widgets) {
    const p = widgetScreen(editor, target, widget);
    if (Math.hypot(x - p.x, y - p.y) <= WIDGET_HIT) return { target, widget };
  }
  return null;
}

/** 拖动时：鼠标在角平分线上挪了多少，换算成半径（圆心沿平分线移动 d，半径变 d·sin(θ/2)） */
export function radiusFromDrag(widget: CornerWidget, start: number, startLocal: Point, local: Point): number {
  const d = (local.x - startLocal.x) * widget.bisector.x + (local.y - startLocal.y) * widget.bisector.y;
  return Math.max(0, Math.min(widget.max, Math.round(start + d * Math.sin(widget.half))));
}

/**
 * 改圆角：所有的角一起，或者只改一个（Alt）。矩形四个角一样时只写 cornerRadius，不一样时写 cornerRadii；
 * 路径改锚点的 radius
 */
export function cornerPatch(node: RectNode | PathNode, key: string, radius: number, single: boolean): NodePatch {
  if (node.type === 'rect') {
    if (!single) return { cornerRadius: radius, cornerRadii: undefined };
    const radii = rectCornerRadii(node);
    radii[Number(key)] = radius;
    const uniform = radii.every((r) => r === radii[0]);
    return uniform ? { cornerRadius: radii[0], cornerRadii: undefined } : { cornerRadii: radii };
  }
  return {
    subpaths: node.subpaths.map((sub, s) => ({
      closed: sub.closed,
      anchors: sub.anchors.map((a, i) => {
        if (single ? `${s}:${i}` !== key : !canRoundAnchor(sub, i)) return a;
        const { radius: _old, ...rest } = a;
        return radius > 0 ? { ...rest, radius } : rest;
      }),
    })),
  };
}

/** Alt 单击控件：圆角 → 反向圆角 → 倒角 → 圆角 */
export function nextCornerStyle(node: RectNode | PathNode): CornerStyle {
  const current = node.cornerStyle ?? 'round';
  return CORNER_STYLES[(CORNER_STYLES.indexOf(current) + 1) % CORNER_STYLES.length]!;
}

/** 节点本地坐标里的点 */
export function toNodeLocal(target: CornerTarget, world: Point): Point | null {
  const inverse = invert(target.world);
  if (!inverse) return null;
  const [x, y] = applyToPoint(inverse, world.x, world.y);
  return { x, y };
}

/** 画控件：白底主题色描边的小圆点；到了最大半径的画成参考线的颜色 */
export function drawCornerWidgets(ctx: CanvasRenderingContext2D, editor: Editor, active: string | null): void {
  const target = cornerTarget(editor);
  if (!target) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  for (const widget of target.widgets) {
    const p = widgetScreen(editor, target, widget);
    const atMax = widget.max > 0 && widget.radius >= widget.max - 0.5;
    ctx.fillStyle = active === widget.key ? editor.theme.accent : editor.theme.handleFill;
    ctx.strokeStyle = atMax ? (editor.theme.snap ?? '#e8338a') : editor.theme.accent;
    ctx.beginPath();
    ctx.arc(p.x, p.y, WIDGET_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
