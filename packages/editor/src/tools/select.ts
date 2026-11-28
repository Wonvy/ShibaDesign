import {
  hasBoxCorners,
  hasLiveAppearance,
  isEnterable,
  applyToPoint,
  isInstanceCopy,
  rotationOf,
  invert,
  isDescendantOf,
  rectContainsPoint,
  rectFromPoints,
  rectsIntersect,
  topLevelOnly,
  worldTransform,
  type GradientFill,
  type ImageFill,
  type Matrix,
  type Subpath,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import { hasAutoLayout, layoutFrames, layoutInsertion } from '../auto-layout';
import { pruneAnimations, setAnimationPath } from '../commands/animation';
import { cloneNodes } from '../commands/edit';
import {
  cornerPatch,
  hitCornerWidget,
  nextCornerStyle,
  radiusFromDrag,
  toNodeLocal,
  type CornerTarget,
  type CornerWidget,
} from '../corner-handles';
import { drawPill, formatNumber } from '../overlay-guides';
import { snapMove, snapPoint, type SnapTargets } from '../snap';
import type { PointerInfo } from '../types';
import type { Editor } from '../editor';
import { dragGradientPoint, imageRect, panImage, zoomImage, type GradientPoint } from '../fill-handles';
import { dragMotionPoint, hitMotionHandle, toPathPoint, type MotionPart, type MotionPathView } from '../motion-handles';
import { reparentByPosition, translateFromOriginals } from '../ops';
import {
  captureOriginals,
  handleCursor,
  resizeBounds,
  resizeInWorld,
  resizeLocal,
  rotateNodes,
  type Handle,
} from '../resize';
import type { Tool } from './tool';

const DRAG_THRESHOLD = 3;
/** 按住 Shift 旋转时吸附的步长：15° */
const ROTATE_SNAP = Math.PI / 12;
/** 按住 Shift 移动时方向吸附的步长：45° */
const MOVE_SNAP = Math.PI / 4;

type Drag =
  | { kind: 'pending'; x: number; y: number; world: Point; collapseTo: NodeId | null }
  // copies：按着 Alt 拖动时复制出来的副本（原件 id → 副本 id），拖动的是副本，原件留在原处
  | {
      kind: 'move';
      world: Point;
      originals: Map<NodeId, SceneNode>;
      key: string;
      canCopy: boolean;
      copies: Map<NodeId, NodeId> | null;
      /** 吸附用：开始时选区的外框和候选 */
      bounds: Rect | null;
      targets: SnapTargets | null;
      /** 拖的是自动布局画框里的东西：这些画框拖动中暂停排列，松手后按位置调整顺序再排 */
      paused: NodeId[];
    }
  // base 是框选开始时保留的选区（按着 Shift 时），before 是按下鼠标之前的选区，取消时换回去；
  // deep：按着 ⌘ 框选，选的是编组里面的成员
  | {
      kind: 'marquee';
      start: Point;
      current: Point;
      base: readonly NodeId[];
      before: readonly NodeId[];
      deep: boolean;
      remove: boolean;
    }
  // 只选一个对象：沿对象自己的方向缩放
  | {
      kind: 'resize-local';
      handle: Handle;
      id: NodeId;
      box: Rect;
      toLocal: Matrix;
      originals: Map<NodeId, SceneNode>;
      key: string;
      /** 对象没转过角度时才吸附（转过的对象沿自己的方向缩放，边不和画布对齐） */
      targets: SnapTargets | null;
    }
  // 多选：缩放整体的外接矩形
  | {
      kind: 'resize-world';
      handle: Handle;
      from: Rect;
      ids: NodeId[];
      originals: Map<NodeId, SceneNode>;
      key: string;
      targets: SnapTargets | null;
    }
  | {
      kind: 'rotate';
      pivot: Point;
      startAngle: number;
      ids: NodeId[];
      originals: Map<NodeId, SceneNode>;
      key: string;
      /** 鼠标在屏幕上的位置，旁边显示角度 */
      at?: Point;
    }
  // 在画布上调整填充：拖渐变的手柄、在形状里拖动或缩放图片。坐标都换算到节点本地
  | {
      kind: 'gradient';
      id: NodeId;
      point: GradientPoint;
      original: GradientFill;
      box: Rect;
      toLocal: Matrix;
      key: string;
    }
  | {
      kind: 'image-pan';
      id: NodeId;
      original: ImageFill;
      box: Rect;
      image: { width: number; height: number };
      toLocal: Matrix;
      start: Point;
      key: string;
    }
  | {
      kind: 'image-zoom';
      id: NodeId;
      original: ImageFill;
      box: Rect;
      image: { width: number; height: number };
      toLocal: Matrix;
      center: Point;
      distance: number;
      key: string;
    }
  // 拖圆角控件：所有的角一起，或者（按着 Alt）只改这一个
  | {
      kind: 'corner';
      id: NodeId;
      target: CornerTarget;
      widget: CornerWidget;
      startLocal: Point;
      single: boolean;
      moved: boolean;
      key: string;
      /** 鼠标在屏幕上的位置，旁边显示半径 */
      at: Point;
      radius: number;
    }
  // 拖动作路径上的锚点或控制柄
  | {
      kind: 'motion';
      view: MotionPathView;
      index: number;
      part: MotionPart;
      original: Subpath;
      key: string;
    };

/** 正在画布上调整的那个节点的填充、外框、本地坐标换算；没在调整时返回 null */
function fillTarget(
  editor: Editor,
): { node: SceneNode; fill: GradientFill | ImageFill; box: Rect; toLocal: Matrix } | null {
  const editing = editor.fillEditing;
  const node = editing ? editor.store.get(editing.id) : undefined;
  const fill = node && 'fill' in node ? node.fill : null;
  if (!node || !fill || (fill.type !== 'gradient' && fill.type !== 'image')) return null;
  const toLocal = invert(worldTransform(editor.store, node.id));
  if (!toLocal) return null;
  return { node, fill, box: editor.geometry.localBounds(node), toLocal };
}

function toLocalPoint(m: Matrix, p: Point): Point {
  const [x, y] = applyToPoint(m, p.x, p.y);
  return { x, y };
}

/** 图片的像素大小（资源库里记着），读不到时返回 null */
function imageSize(editor: Editor, fill: ImageFill): { width: number; height: number } | null {
  const meta = editor.assets.meta(fill.assetId);
  return meta && meta.width > 0 && meta.height > 0 ? { width: meta.width, height: meta.height } : null;
}

/** 选择工具：点选、加选、框选、拖动移动、拖控制柄缩放、拖旋转手柄旋转、双击进入编组 */
export function createSelectTool(): Tool {
  let selectionBeforeClick: NodeId[] = [];
  let drag: Drag | null = null;

  // 按原文件字形显示的文字，文本框就是原文件里那段字的范围，不看排版结果
  const textWidth = (editor: Editor) => (node: TextNode) =>
    hasLiveAppearance(node) ? node.size[0] : editor.textLayouts.get(node).width;

  /**
   * 在画布上调整填充时按下鼠标：按在手柄上就拖手柄；调整图片时按在形状或图片范围里就拖动图片。
   * 按在别处返回 false，照常处理（点到别处会换选区，自然就退出了调整）
   */
  const beginFillEdit = (editor: Editor, world: Point, x: number, y: number): boolean => {
    const target = fillTarget(editor);
    if (!target) return false;
    const { node, fill, box, toLocal } = target;
    const hit = editor.overlayLayer?.hitHandle(x, y) ?? null;
    const local = toLocalPoint(toLocal, world);
    if (hit?.kind === 'gradient' && fill.type === 'gradient') {
      drag = {
        kind: 'gradient',
        id: node.id,
        point: hit.point,
        original: fill,
        box,
        toLocal,
        key: editor.newMergeKey('gradient'),
      };
      return true;
    }
    if (fill.type !== 'image') return false;
    const image = imageSize(editor, fill);
    if (!image) return false;
    const rect = imageRect(fill, box, image);
    if (hit?.kind === 'image') {
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      drag = {
        kind: 'image-zoom',
        id: node.id,
        original: fill,
        box,
        image,
        toLocal,
        center,
        distance: Math.max(1e-6, Math.hypot(local.x - center.x, local.y - center.y)),
        key: editor.newMergeKey('image-zoom'),
      };
      return true;
    }
    if (editor.geometry.outlineOf(node).contains(local.x, local.y) || rectContainsPoint(rect, local.x, local.y)) {
      drag = {
        kind: 'image-pan',
        id: node.id,
        original: fill,
        box,
        image,
        toLocal,
        start: local,
        key: editor.newMergeKey('image-pan'),
      };
      return true;
    }
    return false;
  };

  /** 鼠标按在控制柄或旋转手柄上：开始缩放或旋转 */
  const beginTransform = (editor: Editor, world: Point, x: number, y: number): boolean => {
    const hit = editor.selection.length > 0 ? editor.overlayLayer?.hitHandle(x, y) : null;
    const frame = hit ? editor.selectionFrame() : null;
    if (!hit || !frame || (hit.kind !== 'resize' && hit.kind !== 'rotate')) return false;
    const ids = topLevelOnly(editor.store, editor.selection);
    const originals = captureOriginals(editor.store, ids, textWidth(editor));

    if (hit.kind === 'rotate') {
      const [tl, , br] = frame.corners;
      const pivot = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
      drag = {
        kind: 'rotate',
        pivot,
        startAngle: Math.atan2(world.y - pivot.y, world.x - pivot.x),
        ids,
        originals,
        key: editor.newMergeKey('rotate'),
      };
      return true;
    }

    const toLocal = frame.single ? invert(frame.single.world) : null;
    if (frame.single && toLocal) {
      const m = frame.single.world;
      const axisAligned = Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
      drag = {
        kind: 'resize-local',
        handle: hit.handle,
        id: frame.single.id,
        box: frame.single.box,
        toLocal,
        originals,
        key: editor.newMergeKey('resize'),
        targets: axisAligned ? editor.snapTargets(ids) : null,
      };
    } else {
      drag = {
        kind: 'resize-world',
        handle: hit.handle,
        from: editor.selectionBounds()!,
        ids,
        originals,
        key: editor.newMergeKey('resize'),
        targets: editor.snapTargets(ids),
      };
    }
    return true;
  };

  return {
    id: 'select',
    cursor: 'default',

    onDeactivate(editor) {
      drag = null;
      editor.setHover(null);
    },

    onPointerDown(e, editor) {
      // 记下按下之前的选区：双击空白处时（第一下已经把选区清掉了）靠它知道刚才在哪个组里
      selectionBeforeClick = [...editor.selection];
      if (beginFillEdit(editor, e.world, e.x, e.y)) return;
      // 圆角控件在形状里面，离控制柄远，先看它
      const corner = hitCornerWidget(editor, e.x, e.y);
      if (corner) {
        const local = toNodeLocal(corner.target, e.world);
        if (local) {
          drag = {
            kind: 'corner',
            id: corner.target.node.id,
            target: corner.target,
            widget: corner.widget,
            startLocal: local,
            single: e.alt,
            moved: false,
            key: editor.newMergeKey('corner'),
            at: { x: e.x, y: e.y },
            radius: corner.widget.radius,
          };
          return;
        }
      }
      // 动作路径的手柄优先：路径的起点在对象中心，终点常常落在别的控制柄附近
      const motion = hitMotionHandle(editor, e.x, e.y);
      if (motion) {
        drag = {
          kind: 'motion',
          view: motion.view,
          index: motion.index,
          part: motion.part,
          original: motion.view.path,
          key: editor.newMergeKey('motion-path'),
        };
        return;
      }
      if (beginTransform(editor, e.world, e.x, e.y)) return;

      editor.setHover(null);
      editor.setMeasuring(false);
      // ⌘ 单击直接选中最里面的对象（深选），不管套了几层编组
      const picked = e.mod ? editor.pickDeep(e.world) : editor.pick(e.world).node;
      const target = editor.overlayLayer?.hitArtboardLabel(e.x, e.y) ?? picked?.id ?? null;
      if (!target) {
        const before = [...editor.selection];
        const keep = e.shift || e.alt;
        if (!keep) editor.clearSelection();
        drag = {
          kind: 'marquee',
          start: e.world,
          current: e.world,
          base: keep ? before : [],
          before,
          deep: e.mod,
          remove: e.alt && !e.shift,
        };
        return;
      }

      // 在图层面板里选中了布尔组内部的对象时，点它所在的布尔组不改变选择，这样可以直接拖动内部对象
      const keepsInner = !e.shift && editor.selection.some((id) => isDescendantOf(editor.store, id, target));
      const wasSelected = keepsInner || editor.selection.includes(target);
      if (e.shift) {
        if (wasSelected) {
          editor.select(editor.selection.filter((id) => id !== target));
          drag = null;
          return;
        }
        editor.select([...editor.selection, target]);
      } else if (!wasSelected) {
        editor.select([target]);
      }
      drag = {
        kind: 'pending',
        x: e.x,
        y: e.y,
        world: e.world,
        // 点在多选中的某一个上且没有拖动：松开时收拢成只选它
        collapseTo: !e.shift && !keepsInner && wasSelected && editor.selection.length > 1 ? target : null,
      };
    },

    onPointerMove(e, editor) {
      const { store } = editor;
      if (!e.down || !drag) {
        // 按着 Alt：画出选区到鼠标下对象的距离
        editor.setMeasuring(e.alt && !e.down && editor.selection.length > 0);
        const overlay = editor.overlayLayer;
        if (hitMotionHandle(editor, e.x, e.y)) {
          editor.setCursor('move');
          return;
        }
        if (hitCornerWidget(editor, e.x, e.y)) {
          editor.setCursor('pointer');
          editor.setHover(null);
          return;
        }
        const hit = editor.selection.length > 0 ? overlay?.hitHandle(e.x, e.y) : null;
        if (hit?.kind === 'rotate') editor.setCursor('grab');
        else if (hit?.kind === 'resize') editor.setCursor(handleCursor(hit.handle, overlay?.frameAngle() ?? 0));
        else if (hit) editor.setCursor('pointer');
        else {
          // 悬停高亮：单击会选中的那个对象（按着 ⌘ 时是深选会选中的那个）
          if (!hit) editor.setHover((e.mod ? editor.pickDeep(e.world) : editor.pick(e.world).node)?.id ?? null);

          // 调整图片时，形状里面可以直接拖动图片
          const target = fillTarget(editor);
          const local = target ? toLocalPoint(target.toLocal, e.world) : null;
          const inside =
            target?.fill.type === 'image' && local && editor.geometry.outlineOf(target.node).contains(local.x, local.y);
          editor.setCursor(inside ? 'move' : 'default');
        }
        return;
      }

      if (drag.kind === 'pending') {
        if (Math.hypot(e.x - drag.x, e.y - drag.y) < DRAG_THRESHOLD) return;
        const ids = topLevelOnly(store, editor.selection);
        const paused = [
          ...new Set(
            ids.flatMap((id) => {
              const node = store.get(id);
              const parent = node?.parent ? store.get(node.parent) : undefined;
              return node && !node.layoutIgnore && hasAutoLayout(parent) ? [parent!.id] : [];
            }),
          ),
        ];
        paused.forEach((id) => editor.layoutPaused.add(id));
        drag = {
          kind: 'move',
          world: drag.world,
          originals: new Map(ids.map((id) => [id, store.require(id)])),
          key: editor.newMergeKey('move'),
          // 实例里的东西不能复制（会往实例里加东西），这时 Alt 不起作用
          canCopy: ids.every((id) => !isInstanceCopy(store.get(id))),
          copies: null,
          bounds: editor.selectionBounds(),
          targets: editor.snapTargets(ids),
          paused,
        };
      }

      if (drag.kind === 'move') {
        let dx = e.world.x - drag.world.x;
        let dy = e.world.y - drag.world.y;
        if (e.shift) {
          // 锁定在 0°、45°、90°……的方向上，长度取在这个方向上的投影
          const angle = Math.round(Math.atan2(dy, dx) / MOVE_SNAP) * MOVE_SNAP;
          const length = dx * Math.cos(angle) + dy * Math.sin(angle);
          dx = Math.abs(Math.cos(angle)) < 1e-9 ? 0 : length * Math.cos(angle);
          dy = Math.abs(Math.sin(angle)) < 1e-9 ? 0 : length * Math.sin(angle);
        }
        const move = drag;
        const { originals, key } = move;
        // 吸附：按着 ⌘ 时不吸；Shift 锁定在斜线方向上时也不吸（吸了就离开那条斜线了）
        if (move.bounds && move.targets && editor.snapping && !e.mod) {
          const axes = e.shift ? { x: dy === 0 && dx !== 0, y: dx === 0 && dy !== 0 } : { x: true, y: true };
          const box = { ...move.bounds, x: move.bounds.x + dx, y: move.bounds.y + dy };
          const hit = snapMove(move.targets, box, {
            threshold: editor.snapThreshold,
            axes,
            pixels: editor.view.snapPixels,
          });
          dx += hit.dx;
          dy += hit.dy;
          editor.setSnapFeedback(hit);
        } else {
          editor.setSnapFeedback(null);
        }
        const wantCopy = e.alt && move.canCopy;
        if (wantCopy && !move.copies) {
          // 按下 Alt：原件回到原处，在它上面复制一份，拖动的换成副本
          store.transact(
            'move',
            (tx) => {
              translateFromOriginals(tx, store, originals, 0, 0);
              move.copies = cloneNodes(editor, tx, [...originals.keys()], 0, 0);
            },
            { mergeKey: key },
          );
          editor.select([...move.copies!.values()]);
          editor.setCursor('copy');
        } else if (!wantCopy && move.copies) {
          // 松开 Alt：副本删掉，拖动的换回原件
          const copies = move.copies;
          store.transact('move', (tx) => copies.forEach((copy) => tx.remove(copy)), { mergeKey: key });
          move.copies = null;
          editor.select([...originals.keys()]);
          editor.setCursor('default');
        }
        const moving = move.copies ? copyOriginals(originals, move.copies) : originals;
        store.transact('move', (tx) => translateFromOriginals(tx, store, moving, dx, dy), { mergeKey: key });
        return;
      }

      if (drag.kind === 'marquee') {
        if (e.space) {
          // 按住空格挪动整个选框
          drag.start = { x: drag.start.x + e.world.x - drag.current.x, y: drag.start.y + e.world.y - drag.current.y };
        }
        drag.current = e.world;
        const rect = rectFromPoints(drag.start.x, drag.start.y, e.world.x, e.world.y);
        const candidates = drag.deep ? groupMembersOf(editor, editor.selectableNodes()) : editor.selectableNodes();
        // 偏好"框选要整个框住"：对象整个在框里才选，否则框到一部分就选
        const contain = editor.view.marqueeContain;
        const hits = candidates
          .filter((node) => {
            const b = editor.geometry.worldBounds(node);
            return contain
              ? b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h
              : rectsIntersect(b, rect);
          })
          .map((node) => node.id);
        if (drag.remove) {
          // 按着 Alt 框选：从原来的选区里减掉框到的
          const removed = new Set(hits);
          editor.select(drag.base.filter((id) => !removed.has(id)));
        } else {
          editor.select([...new Set([...drag.base, ...hits])]);
        }
        return;
      }

      if (drag.kind === 'resize-local') {
        const { id, box, originals, key } = drag;
        const pointer = snapResizePointer(editor, drag.targets, drag.handle, e);
        const [lx, ly] = applyToPoint(drag.toLocal, pointer.x, pointer.y);
        const next = resizeBounds(box, drag.handle, { x: lx, y: ly }, e.shift, e.alt);
        // 按住 ⌘：画框、画板里的东西不按约束跟着变
        const mode = e.mod ? 'fixed' : 'constraints';
        store.transact('resize', (tx) => resizeLocal(tx, store, originals, id, box, next, mode), { mergeKey: key });
        return;
      }

      if (drag.kind === 'resize-world') {
        const { ids, originals, from, key } = drag;
        const pointer = snapResizePointer(editor, drag.targets, drag.handle, e);
        const to = resizeBounds(from, drag.handle, pointer, e.shift, e.alt);
        const mode = e.mod ? 'fixed' : 'constraints';
        store.transact('resize', (tx) => resizeInWorld(tx, store, originals, ids, from, to, mode), {
          mergeKey: key,
        });
        return;
      }

      if (drag.kind === 'gradient') {
        const { id, original, box, point, key } = drag;
        const fill = dragGradientPoint(original, box, point, toLocalPoint(drag.toLocal, e.world), e.shift);
        store.transact('gradient', (tx) => tx.update(id, { fill }), { mergeKey: key });
        return;
      }

      if (drag.kind === 'image-pan') {
        const { id, original, box, image, start, key } = drag;
        const local = toLocalPoint(drag.toLocal, e.world);
        const fill = panImage(original, box, image, local.x - start.x, local.y - start.y);
        store.transact('move image', (tx) => tx.update(id, { fill }), { mergeKey: key });
        return;
      }

      if (drag.kind === 'image-zoom') {
        const { id, original, box, image, center, distance, key } = drag;
        const local = toLocalPoint(drag.toLocal, e.world);
        const fill = zoomImage(original, box, image, Math.hypot(local.x - center.x, local.y - center.y) / distance);
        store.transact('zoom image', (tx) => tx.update(id, { fill }), { mergeKey: key });
        return;
      }

      if (drag.kind === 'corner') {
        const local = toNodeLocal(drag.target, e.world);
        if (!local) return;
        drag.moved = true;
        drag.at = { x: e.x, y: e.y };
        const radius = radiusFromDrag(drag.widget, drag.widget.radius, drag.startLocal, local);
        drag.radius = radius;
        const node = store.get(drag.id);
        if (node?.type !== 'rect' && node?.type !== 'path') return;
        const patch = cornerPatch(node, drag.widget.key, radius, drag.single);
        store.transact('corner radius', (tx) => tx.update(node.id, patch), { mergeKey: drag.key });
        return;
      }

      if (drag.kind === 'motion') {
        const { view, index, part, original, key } = drag;
        const to = toPathPoint(view, e.world);
        if (!to) return;
        setAnimationPath(editor, view.slideId, view.animationId, dragMotionPoint(original, index, part, to), key);
        return;
      }

      if (drag.kind === 'rotate') {
        const { ids, originals, pivot, key } = drag;
        let angle = Math.atan2(e.world.y - pivot.y, e.world.x - pivot.x) - drag.startAngle;
        if (e.shift) angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
        drag.at = { x: e.x, y: e.y };
        store.transact('rotate', (tx) => rotateNodes(tx, store, originals, ids, pivot, angle), { mergeKey: key });
      }
    },

    onCancel(editor) {
      const cancelled = drag;
      drag = null;
      editor.setSnapFeedback(null);
      if (!cancelled) return;
      if (cancelled.kind === 'move') cancelled.paused.forEach((id) => editor.layoutPaused.delete(id));
      if (cancelled.kind === 'marquee') editor.select(cancelled.before);
      else if ('key' in cancelled) editor.store.abandon(cancelled.key);
      if (cancelled.kind === 'move' && cancelled.copies) editor.select([...cancelled.originals.keys()]);
      editor.setCursor('default');
    },

    onPointerUp(_e, editor) {
      const finished = drag;
      drag = null;
      editor.setSnapFeedback(null);
      if (!finished) return;
      if (finished.kind === 'pending' && finished.collapseTo) editor.select([finished.collapseTo]);
      if (finished.kind === 'corner' && !finished.moved && finished.single) {
        // Alt 单击控件：换圆角样式
        const node = editor.store.get(finished.id);
        if (hasBoxCorners(node) || node?.type === 'path') {
          editor.store.transact('corner style', (tx) => tx.update(node.id, { cornerStyle: nextCornerStyle(node) }));
        }
      }
      if (finished.kind === 'move') {
        const moved = finished.copies ? [...finished.copies.values()] : [...finished.originals.keys()];
        finished.paused.forEach((id) => editor.layoutPaused.delete(id));
        editor.store.transact(
          'move',
          (tx) => {
            reparentByPosition(editor, tx, moved);
            // 暂停过的自动布局画框按新的顺序排回去（东西拖出去了的也要把空位收起来）
            layoutFrames(editor, tx, finished.paused);
            // 对象被拖到别的幻灯片上之后，它在原来那一页的动画就没有意义了
            pruneAnimations(tx, editor.store);
          },
          { mergeKey: finished.key },
        );
      }
      if (finished.kind !== 'pending' && finished.kind !== 'marquee') editor.store.sealHistory();
      if (finished.kind === 'rotate' || (finished.kind === 'move' && finished.copies)) editor.setCursor('default');
    },

    onDoubleClick(e, editor) {
      const picked = editor.pick(e.world);
      const hit = picked.node;
      // 在组（画框）里双击空白处：退回上一层，选中这个组
      const outer = enteredContainer(editor, selectionBeforeClick);
      if (outer && (!hit || !isDescendantOf(editor.store, hit.id, outer.id))) {
        editor.select([outer.id]);
        return;
      }
      if (!hit) {
        // 双击画板的空白处：画板背景是渐变时，在画布上调整它
        const board = picked.artboard;
        if (board?.fill?.type === 'gradient') editor.setFillEditing({ id: board.id, kind: 'gradient' });
        return;
      }
      if (hit.type === 'text') {
        editor.commands.run('text.edit', { id: hit.id, world: e.world });
        return;
      }
      // 双击钢笔路径：改它的锚点
      if (hit.type === 'path' && !hit.locked) {
        editor.select([hit.id]);
        editor.setTool('direct');
        return;
      }
      // 双击编组、画框：进入它，选中鼠标下面的那个成员。之后单击里面的其他成员也是选成员。
      // 蒙版组也一样：蒙版本身点不中，选中的是被遮住的内容，拖动它时蒙版不动。
      // 双击画框的空白处（下面没有它里面的东西）：画框填了渐变或图片时在画布上调整它
      if (hit.type === 'group' || hit.type === 'frame') {
        const inner = editor.pickInside(e.world, hit.id);
        if (inner) {
          editor.select([inner.id]);
          return;
        }
        if (hit.type === 'group') return;
      }
      // 双击填了渐变或图片的形状：在画布上调整渐变的起点终点，或者图片在形状里的位置和大小
      const fill = 'fill' in hit ? hit.fill : null;
      if (fill?.type === 'gradient' || fill?.type === 'image') editor.setFillEditing({ id: hit.id, kind: fill.type });
    },

    onKeyDown(event, editor) {
      if (event.key === 'Escape' && editor.fillEditing) {
        editor.setFillEditing(null);
        return true;
      }
      return false;
    },

    drawOverlay(ctx, editor) {
      if (drag?.kind === 'move') {
        drawInsertionBar(ctx, editor, drag.copies ? [...drag.copies.values()] : [...drag.originals.keys()]);
        return;
      }
      if (drag?.kind === 'corner' && drag.moved) {
        drawPill(ctx, `R ${formatNumber(drag.radius)}`, drag.at.x + 22, drag.at.y + 18, editor.theme.accent);
        return;
      }
      if (drag?.kind === 'rotate' && drag.at && drag.ids[0]) {
        // 旋转时鼠标旁边显示第一个对象现在转了多少度
        const degrees = (rotationOf(worldTransform(editor.store, drag.ids[0])) * 180) / Math.PI;
        drawPill(ctx, `${formatNumber(degrees)}°`, drag.at.x + 24, drag.at.y + 20, editor.theme.accent);
        return;
      }
      if (drag?.kind !== 'marquee') return;
      const a = editor.worldToScreen(drag.start.x, drag.start.y);
      const b = editor.worldToScreen(drag.current.x, drag.current.y);
      const rect = rectFromPoints(a.x, a.y, b.x, b.y);
      ctx.save();
      ctx.fillStyle = editor.theme.accent;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = editor.theme.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.round(rect.w), Math.round(rect.h));
      ctx.restore();
    },
  };
}

/** 拖进自动布局画框时，在要插进去的空隙里画一条插入条 */
function drawInsertionBar(ctx: CanvasRenderingContext2D, editor: Editor, ids: readonly NodeId[]): void {
  const bounds = editor.selectionBounds();
  if (!bounds || ids.length === 0) return;
  const moving = new Set(ids);
  const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  const target = editor.containerAt(center, moving);
  const slot = layoutInsertion(editor, target.id, center, moving);
  if (!slot) return;
  const world = worldTransform(editor.store, target.id);
  const [a, b] = slot.bar.map((p) => {
    const [x, y] = applyToPoint(world, p.x, p.y);
    return editor.worldToScreen(x, y);
  });
  ctx.save();
  ctx.strokeStyle = editor.theme.accent;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a!.x, a!.y);
  ctx.lineTo(b!.x, b!.y);
  ctx.stroke();
  ctx.restore();
}

/** 缩放时吸附拖动的那条边：拖右边的控制柄只吸 x，拖角吸两个方向；按着 ⌘ 时不吸 */
function snapResizePointer(editor: Editor, targets: SnapTargets | null, handle: Handle, e: PointerInfo): Point {
  if (!targets || !editor.snapping || e.mod) {
    editor.setSnapFeedback(null);
    return e.world;
  }
  const axes = { x: handle.includes('e') || handle.includes('w'), y: handle.includes('n') || handle.includes('s') };
  const hit = snapPoint(targets, e.world, { threshold: editor.snapThreshold, axes, pixels: editor.view.snapPixels });
  editor.setSnapFeedback({ lines: hit.lines, spacing: [] });
  return hit.point;
}

/** 拖动副本用的"原件"：副本刚复制出来时和原件重合，按原件的变换算位移（复制出来的画板放在别处，也拉回来跟着走） */
function copyOriginals(
  originals: ReadonlyMap<NodeId, SceneNode>,
  copies: ReadonlyMap<NodeId, NodeId>,
): Map<NodeId, SceneNode> {
  const out = new Map<NodeId, SceneNode>();
  for (const [source, copy] of copies) {
    const original = originals.get(source);
    if (original) out.set(copy, { ...original, id: copy } as SceneNode);
  }
  return out;
}

/** 选中的东西都在同一个"进去了"的组（画框）里时，返回这个组 */
function enteredContainer(editor: Editor, ids: readonly NodeId[]): SceneNode | null {
  if (ids.length === 0) return null;
  const parents = new Set(ids.map((id) => editor.store.get(id)?.parent ?? null));
  if (parents.size !== 1) return null;
  const parent = editor.store.get([...parents][0] ?? '');
  return parent && isEnterable(parent) ? parent : null;
}

/** ⌘ 框选的候选：编组展开成里面的成员（一层层展开到不是编组为止），看不见、锁定的不算 */
function groupMembersOf(editor: Editor, nodes: readonly SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (node: SceneNode): void => {
    if (!node.visible || node.locked) return;
    // 画框里有东西时也展开；空的画框自己算一个
    const kids = node.type === 'group' || node.type === 'frame' ? editor.store.children(node.id) : [];
    if (kids.length > 0) kids.forEach(visit);
    else out.push(node);
  };
  nodes.forEach(visit);
  return out;
}
