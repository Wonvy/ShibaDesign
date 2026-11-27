import {
  isDescendantOf,
  rectFromPoints,
  rectsIntersect,
  topLevelOnly,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import { reparentByPosition, translateFromOriginals } from '../ops';
import { captureOriginals, handleCursor, resizeBounds, scaleNodes, type Handle } from '../resize';
import type { Tool } from './tool';

const DRAG_THRESHOLD = 3;

type Drag =
  | { kind: 'pending'; x: number; y: number; world: Point; collapseTo: NodeId | null }
  | { kind: 'move'; world: Point; originals: Map<NodeId, SceneNode>; key: string }
  | { kind: 'marquee'; start: Point; current: Point; base: readonly NodeId[] }
  | { kind: 'resize'; handle: Handle; from: Rect; ids: NodeId[]; originals: Map<NodeId, SceneNode>; key: string };

/** 选择工具：点选、加选、框选、拖动移动、拖控制柄缩放 */
export function createSelectTool(): Tool {
  let drag: Drag | null = null;

  return {
    id: 'select',
    cursor: 'default',

    onDeactivate() {
      drag = null;
    },

    onPointerDown(e, editor) {
      const overlay = editor.overlayLayer;
      const handle = editor.selection.length > 0 ? overlay?.hitHandle(e.x, e.y) : null;
      if (handle) {
        const ids = topLevelOnly(editor.store, editor.selection);
        drag = {
          kind: 'resize',
          handle,
          from: editor.selectionBounds()!,
          ids,
          originals: captureOriginals(editor.store, ids, (node) => editor.textLayouts.get(node).width),
          key: editor.newMergeKey('resize'),
        };
        return;
      }

      const target = overlay?.hitArtboardLabel(e.x, e.y) ?? editor.pick(e.world).node?.id ?? null;
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
        const handle = editor.selection.length > 0 ? editor.overlayLayer?.hitHandle(e.x, e.y) : null;
        editor.setCursor(handle ? handleCursor(handle) : 'default');
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

      if (drag.kind === 'resize') {
        const { ids, originals, from, key } = drag;
        const to = resizeBounds(from, drag.handle, e.world, e.shift);
        store.transact('resize', (tx) => scaleNodes(tx, store, ids, originals, from, to), { mergeKey: key });
      }
    },

    onPointerUp(_e, editor) {
      const finished = drag;
      drag = null;
      if (!finished) return;
      if (finished.kind === 'pending' && finished.collapseTo) editor.select([finished.collapseTo]);
      if (finished.kind === 'move') {
        editor.store.transact('move', (tx) => reparentByPosition(editor, tx, finished.originals.keys()), {
          mergeKey: finished.key,
        });
      }
      if (finished.kind === 'move' || finished.kind === 'resize') editor.store.sealHistory();
    },

    onDoubleClick(e, editor) {
      const hit = editor.pick(e.world).node;
      if (hit?.type === 'text') editor.commands.run('text.edit', { id: hit.id, world: e.world });
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
