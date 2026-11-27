import {
  applyToPoint,
  invert,
  isDescendantOf,
  rectFromPoints,
  rectsIntersect,
  topLevelOnly,
  type Matrix,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import { pruneAnimations } from '../commands/animation';
import type { Editor } from '../editor';
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
    };

/** 选择工具：点选、加选、框选、拖动移动、拖控制柄缩放、拖旋转手柄旋转、双击进入编组 */
export function createSelectTool(): Tool {
  let drag: Drag | null = null;

  const textWidth = (editor: Editor) => (node: TextNode) => editor.textLayouts.get(node).width;

  /** 鼠标按在控制柄或旋转手柄上：开始缩放或旋转 */
  const beginTransform = (editor: Editor, world: Point, x: number, y: number): boolean => {
    const hit = editor.selection.length > 0 ? editor.overlayLayer?.hitHandle(x, y) : null;
    const frame = hit ? editor.selectionFrame() : null;
    if (!hit || !frame) return false;
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
        const hit = editor.selection.length > 0 ? overlay?.hitHandle(e.x, e.y) : null;
        if (hit?.kind === 'rotate') editor.setCursor('grab');
        else if (hit) editor.setCursor(handleCursor(hit.handle, overlay?.frameAngle() ?? 0));
        else editor.setCursor('default');
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
      const hit = editor.pick(e.world).node;
      if (!hit) return;
      if (hit.type === 'text') {
        editor.commands.run('text.edit', { id: hit.id, world: e.world });
        return;
      }
      // 双击编组：进入这个组，选中鼠标下面的那个成员。之后单击组里的其他成员也是选成员
      if (hit.type === 'group') {
        const inner = editor.pickInside(e.world, hit.id);
        if (inner) editor.select([inner.id]);
      }
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
