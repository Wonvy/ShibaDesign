import {
  applyToPoint,
  getEffect,
  invert,
  motionPathEnds,
  transformRect,
  worldTransform,
  type Matrix,
  type NodeId,
  type Point,
  type Subpath,
} from '@shiba/core';
import { slideLayerOf } from './commands/animation';
import type { Editor } from './editor';

/**
 * 在画布上显示和修改动作路径。选中一个有动作路径的对象时，它的每条路径画成虚线，起点绿色、终点红色，
 * 锚点和曲线的控制柄可以拖动。路径存在幻灯片的动画列表里，坐标是相对对象中心的位移（见 core 的 animation.ts），
 * 这里负责换算到屏幕上：对象中心 + 前面几条路径挪过的距离 + 路径上的点，再经过幻灯片的变换和相机。
 */

/** 一条要显示的动作路径 */
export interface MotionPathView {
  slideId: NodeId;
  animationId: string;
  target: NodeId;
  path: Subpath;
  /** 路径的原点（幻灯片坐标）：对象中心，加上同一个对象前面的动作路径挪过的距离 */
  origin: Point;
  /** 幻灯片坐标 → 世界坐标 */
  toWorld: Matrix;
}

/** 锚点本身，或者它进来、出去的控制柄 */
export type MotionPart = 'anchor' | 'in' | 'out';

/** 屏幕上的一个手柄 */
export interface MotionHandle {
  view: MotionPathView;
  index: number;
  part: MotionPart;
  screen: Point;
}

const HANDLE_HIT = 8;

/** 对象在幻灯片上的中心，和编译演示稿时算外框的方法一样（compile.ts） */
export function layerCenter(editor: Editor, id: NodeId): Point | null {
  const node = editor.store.get(id);
  if (!node) return null;
  const box = transformRect(node.transform, editor.geometry.localBounds(node));
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** 这些对象（所在幻灯片上对应的图层）的动作路径，按动画列表的顺序 */
export function motionPathsOf(editor: Editor, ids: readonly NodeId[]): MotionPathView[] {
  const { store } = editor;
  const out: MotionPathView[] = [];
  const done = new Set<NodeId>();
  for (const id of ids) {
    const found = slideLayerOf(store, id);
    if (!found || done.has(found.layer.id)) continue;
    done.add(found.layer.id);
    const center = layerCenter(editor, found.layer.id);
    if (!center) continue;
    const toWorld = worldTransform(store, found.slide.id);
    let origin = center;
    for (const animation of found.slide.deck?.animations ?? []) {
      if (animation.target !== found.layer.id || !animation.path) continue;
      if (getEffect(animation.effect)?.kind !== 'motion') continue;
      out.push({
        slideId: found.slide.id,
        animationId: animation.id,
        target: found.layer.id,
        path: animation.path,
        origin,
        toWorld,
      });
      const { end } = motionPathEnds(animation.path);
      origin = { x: origin.x + end.x, y: origin.y + end.y };
    }
  }
  return out;
}

/**
 * 给这个图层新加一条动作路径时，路径从哪里出发（幻灯片坐标）：对象中心，加上它已有的动作路径挪过的距离
 */
export function motionOrigin(editor: Editor, layerId: NodeId): Point | null {
  const center = layerCenter(editor, layerId);
  if (!center) return null;
  const views = motionPathsOf(editor, [layerId]);
  const last = views[views.length - 1];
  if (!last) return center;
  const { end } = motionPathEnds(last.path);
  return { x: last.origin.x + end.x, y: last.origin.y + end.y };
}

/** 现在要不要在画布上显示动作路径：用选择工具、没在调整填充、没在编辑文字 */
function showing(editor: Editor): boolean {
  const state = editor.getState();
  return state.tool === 'select' && !state.fillEditing && !state.textEditing && state.selection.length > 0;
}

/** 路径上的点（相对原点）→ 屏幕坐标 */
function toScreen(editor: Editor, view: MotionPathView, x: number, y: number): Point {
  const [wx, wy] = applyToPoint(view.toWorld, view.origin.x + x, view.origin.y + y);
  return editor.worldToScreen(wx, wy);
}

/** 世界坐标 → 某条路径自己的坐标（相对原点）。换算不了时返回 null */
export function toPathPoint(view: MotionPathView, world: Point): Point | null {
  const inverse = invert(view.toWorld);
  if (!inverse) return null;
  const [x, y] = applyToPoint(inverse, world.x, world.y);
  return { x: x - view.origin.x, y: y - view.origin.y };
}

const hasHandle = (a: { x: number; y: number }, hx: number, hy: number): boolean =>
  Math.abs(hx - a.x) > 1e-6 || Math.abs(hy - a.y) > 1e-6;

/** 选中对象的动作路径上所有手柄的屏幕位置。控制柄排在锚点前面，重叠时先点中控制柄 */
export function motionHandles(editor: Editor): MotionHandle[] {
  if (!showing(editor)) return [];
  const out: MotionHandle[] = [];
  for (const view of motionPathsOf(editor, editor.selection)) {
    view.path.anchors.forEach((a, index) => {
      if (hasHandle(a, a.inX, a.inY))
        out.push({ view, index, part: 'in', screen: toScreen(editor, view, a.inX, a.inY) });
      if (hasHandle(a, a.outX, a.outY))
        out.push({ view, index, part: 'out', screen: toScreen(editor, view, a.outX, a.outY) });
    });
    view.path.anchors.forEach((a, index) => {
      out.push({ view, index, part: 'anchor', screen: toScreen(editor, view, a.x, a.y) });
    });
  }
  return out;
}

/** 屏幕上的某个点点中了哪个手柄；后画的路径在上面，先找它的 */
export function hitMotionHandle(editor: Editor, x: number, y: number): MotionHandle | null {
  const handles = motionHandles(editor);
  for (let i = handles.length - 1; i >= 0; i--) {
    const h = handles[i]!;
    if (Math.hypot(h.screen.x - x, h.screen.y - y) <= HANDLE_HIT) return h;
  }
  return null;
}

/**
 * 拖动之后的路径。拖锚点：锚点连同它的两根控制柄一起挪；拖控制柄：只挪这一根，
 * 开始拖时两根控制柄是对称的（平滑的锚点），另一根跟着反向转，保持平滑
 * @param to 拖到的位置，路径自己的坐标
 */
export function dragMotionPoint(original: Subpath, index: number, part: MotionPart, to: Point): Subpath {
  const anchors = original.anchors.map((a, i) => {
    if (i !== index) return a;
    if (part === 'anchor') {
      const dx = to.x - a.x;
      const dy = to.y - a.y;
      return { x: to.x, y: to.y, inX: a.inX + dx, inY: a.inY + dy, outX: a.outX + dx, outY: a.outY + dy };
    }
    const symmetric =
      Math.abs(a.inX + a.outX - 2 * a.x) < 1e-6 &&
      Math.abs(a.inY + a.outY - 2 * a.y) < 1e-6 &&
      hasHandle(a, a.inX, a.inY);
    if (part === 'out') {
      return symmetric
        ? { ...a, outX: to.x, outY: to.y, inX: 2 * a.x - to.x, inY: 2 * a.y - to.y }
        : { ...a, outX: to.x, outY: to.y };
    }
    return symmetric
      ? { ...a, inX: to.x, inY: to.y, outX: 2 * a.x - to.x, outY: 2 * a.y - to.y }
      : { ...a, inX: to.x, inY: to.y };
  });
  return { closed: original.closed, anchors };
}

/** 把选中对象的动作路径画在覆盖层上 */
export function drawMotionPaths(ctx: CanvasRenderingContext2D, editor: Editor): void {
  if (!showing(editor)) return;
  const views = motionPathsOf(editor, editor.selection);
  if (views.length === 0) return;
  ctx.save();
  for (const view of views) {
    const { anchors } = view.path;
    const first = anchors[0];
    if (!first) continue;
    const s = (x: number, y: number): Point => toScreen(editor, view, x, y);

    // 路径：白底上叠一条虚线，在深色和浅色的内容上都看得清
    ctx.beginPath();
    const p0 = s(first.x, first.y);
    ctx.moveTo(p0.x, p0.y);
    const segment = (a: (typeof anchors)[number], b: (typeof anchors)[number]): void => {
      const c1 = s(a.outX, a.outY);
      const c2 = s(b.inX, b.inY);
      const p = s(b.x, b.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
    };
    for (let i = 1; i < anchors.length; i++) segment(anchors[i - 1]!, anchors[i]!);
    if (view.path.closed && anchors.length > 1) segment(anchors[anchors.length - 1]!, first);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = editor.theme.accent;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 曲线的控制柄
    ctx.lineWidth = 1;
    for (const a of anchors) {
      const p = s(a.x, a.y);
      for (const [hx, hy] of [
        [a.inX, a.inY],
        [a.outX, a.outY],
      ] as const) {
        if (!hasHandle(a, hx, hy)) continue;
        const h = s(hx, hy);
        ctx.strokeStyle = editor.theme.accent;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(h.x, h.y);
        ctx.stroke();
        ctx.fillStyle = editor.theme.handleFill;
        ctx.beginPath();
        ctx.arc(h.x, h.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // 锚点；起点画成绿色的三角，终点画成红色的方块（闭合路径的终点就是起点）
    ctx.lineWidth = 1.5;
    anchors.forEach((a, i) => {
      const p = s(a.x, a.y);
      const isStart = i === 0;
      const isEnd = !view.path.closed && i === anchors.length - 1;
      ctx.strokeStyle = editor.theme.accent;
      ctx.fillStyle = isStart ? '#30a46c' : isEnd ? '#e5484d' : editor.theme.handleFill;
      ctx.beginPath();
      if (isStart) {
        ctx.moveTo(p.x - 5, p.y - 6);
        ctx.lineTo(p.x + 7, p.y);
        ctx.lineTo(p.x - 5, p.y + 6);
        ctx.closePath();
      } else {
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
      }
      ctx.fill();
      ctx.stroke();
    });
  }
  ctx.restore();
}
