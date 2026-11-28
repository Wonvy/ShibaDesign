import {
  hasLiveAppearance,
  applyToPoint,
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
import { pruneAnimations, setAnimationPath } from '../commands/animation';
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

type Drag =
  | { kind: 'pending'; x: number; y: number; world: Point; collapseTo: NodeId | null }
  | { kind: 'move'; world: Point; originals: Map<NodeId, SceneNode>; key: string }
  | { kind: 'marquee'; start: Point; current: Point; base: readonly NodeId[] }
  // 只选一个对象：沿对象自己的方向缩放
  | {
      kind: 'resize-local';
      handle: Handle;
      id: NodeId;
      box: Rect;
      toLocal: Matrix;
      originals: Map<NodeId, SceneNode>;
      key: string;
    }
  // 多选：缩放整体的外接矩形
  | { kind: 'resize-world'; handle: Handle; from: Rect; ids: NodeId[]; originals: Map<NodeId, SceneNode>; key: string }
  | {
      kind: 'rotate';
      pivot: Point;
      startAngle: number;
      ids: NodeId[];
      originals: Map<NodeId, SceneNode>;
      key: string;
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
      drag = {
        kind: 'resize-local',
        handle: hit.handle,
        id: frame.single.id,
        box: frame.single.box,
        toLocal,
        originals,
        key: editor.newMergeKey('resize'),
      };
    } else {
      drag = {
        kind: 'resize-world',
        handle: hit.handle,
        from: editor.selectionBounds()!,
        ids,
        originals,
        key: editor.newMergeKey('resize'),
      };
    }
    return true;
  };

  return {
    id: 'select',
    cursor: 'default',

    onDeactivate() {
      drag = null;
    },

    onPointerDown(e, editor) {
      if (beginFillEdit(editor, e.world, e.x, e.y)) return;
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

      const target = editor.overlayLayer?.hitArtboardLabel(e.x, e.y) ?? editor.pick(e.world).node?.id ?? null;
      if (!target) {
        if (!e.shift) editor.clearSelection();
        drag = { kind: 'marquee', start: e.world, current: e.world, base: e.shift ? [...editor.selection] : [] };
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
        const overlay = editor.overlayLayer;
        if (hitMotionHandle(editor, e.x, e.y)) {
          editor.setCursor('move');
          return;
        }
        const hit = editor.selection.length > 0 ? overlay?.hitHandle(e.x, e.y) : null;
        if (hit?.kind === 'rotate') editor.setCursor('grab');
        else if (hit?.kind === 'resize') editor.setCursor(handleCursor(hit.handle, overlay?.frameAngle() ?? 0));
        else if (hit) editor.setCursor('pointer');
        else {
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
        drag = {
          kind: 'move',
          world: drag.world,
          originals: new Map(ids.map((id) => [id, store.require(id)])),
          key: editor.newMergeKey('move'),
        };
      }

      if (drag.kind === 'move') {
        let dx = e.world.x - drag.world.x;
        let dy = e.world.y - drag.world.y;
        if (e.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const { originals, key } = drag;
        store.transact('move', (tx) => translateFromOriginals(tx, store, originals, dx, dy), { mergeKey: key });
        return;
      }

      if (drag.kind === 'marquee') {
        drag.current = e.world;
        const rect = rectFromPoints(drag.start.x, drag.start.y, e.world.x, e.world.y);
        const hits = editor
          .selectableNodes()
          .filter((node) => rectsIntersect(editor.geometry.worldBounds(node), rect))
          .map((node) => node.id);
        editor.select([...drag.base, ...hits]);
        return;
      }

      if (drag.kind === 'resize-local') {
        const { id, box, originals, key } = drag;
        const [lx, ly] = applyToPoint(drag.toLocal, e.world.x, e.world.y);
        const next = resizeBounds(box, drag.handle, { x: lx, y: ly }, e.shift);
        store.transact('resize', (tx) => resizeLocal(tx, store, originals, id, box, next), { mergeKey: key });
        return;
      }

      if (drag.kind === 'resize-world') {
        const { ids, originals, from, key } = drag;
        const to = resizeBounds(from, drag.handle, e.world, e.shift);
        store.transact('resize', (tx) => resizeInWorld(tx, store, originals, ids, from, to), { mergeKey: key });
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
        store.transact('rotate', (tx) => rotateNodes(tx, store, originals, ids, pivot, angle), { mergeKey: key });
      }
    },

    onPointerUp(_e, editor) {
      const finished = drag;
      drag = null;
      if (!finished) return;
      if (finished.kind === 'pending' && finished.collapseTo) editor.select([finished.collapseTo]);
      if (finished.kind === 'move') {
        editor.store.transact(
          'move',
          (tx) => {
            reparentByPosition(editor, tx, finished.originals.keys());
            // 对象被拖到别的幻灯片上之后，它在原来那一页的动画就没有意义了
            pruneAnimations(tx, editor.store);
          },
          { mergeKey: finished.key },
        );
      }
      if (finished.kind !== 'pending' && finished.kind !== 'marquee') editor.store.sealHistory();
      if (finished.kind === 'rotate') editor.setCursor('default');
    },

    onDoubleClick(e, editor) {
      const picked = editor.pick(e.world);
      const hit = picked.node;
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
      // 双击编组：进入这个组，选中鼠标下面的那个成员。之后单击组里的其他成员也是选成员。
      // 蒙版组也一样：蒙版本身点不中，选中的是被遮住的内容，拖动它时蒙版不动
      if (hit.type === 'group') {
        const inner = editor.pickInside(e.world, hit.id);
        if (inner) editor.select([inner.id]);
        return;
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
