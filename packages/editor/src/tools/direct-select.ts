import {
  applyToPoint,
  hasShapeStyle,
  invert,
  rectFromPoints,
  worldTransform,
  type NodeId,
  type PathNode,
  type Point,
  type SceneNode,
  type Subpath,
} from '@shiba/core';
import { pathGeometry } from '@shiba/renderer';
import type { Editor } from '../editor';
import {
  anchorKey,
  deleteAnchors,
  isSmooth,
  moveAnchors,
  moveHandle,
  normalizePath,
  parseKey,
  toggleSmooth,
} from '../path-edit';
import { snapPoint } from '../snap';
import type { Tool } from './tool';

/** 点中锚点、控制柄的范围，屏幕像素 */
const HIT = 6;
const ANCHOR_SIZE = 7;
const DRAG_THRESHOLD = 3;

type Drag =
  | { kind: 'pending'; x: number; y: number; start: Point }
  | { kind: 'anchors'; start: Point; original: readonly Subpath[]; key: string }
  | { kind: 'handle'; anchor: string; which: 'in' | 'out'; original: readonly Subpath[]; key: string }
  | { kind: 'marquee'; start: Point; current: Point; base: ReadonlySet<string> };

type HandleHit = { kind: 'anchor'; key: string } | { kind: 'handle'; key: string; which: 'in' | 'out' };

/** 能改锚点的对象：钢笔路径；矩形、椭圆这类形状拖锚点时先转成路径 */
function editable(node: SceneNode | undefined): node is SceneNode {
  return !!node && !node.locked && hasShapeStyle(node) && node.type !== 'boolean';
}

/**
 * 直接选择工具（A）：改钢笔路径的锚点。单击锚点选中（Shift 加选），框选；拖锚点挪动（选中的几个一起），
 * 拖控制柄改曲线（平滑锚点的另一根跟着转，按住 Alt 只动这一根）；双击锚点在尖角和平滑之间切换；
 * ⌫ 删除选中的锚点；方向键微移；Esc、回车回到选择工具。矩形、椭圆拖锚点时先转成路径（id 不变）
 */
export function createDirectSelectTool(): Tool {
  let target: NodeId | null = null;
  let picked = new Set<string>();
  let drag: Drag | null = null;

  const node = (editor: Editor): SceneNode | undefined => (target ? editor.store.get(target) : undefined);

  /** 这个对象的锚点（本地坐标）：钢笔路径就是它的；别的形状按轮廓换算一份预览 */
  const anchorsOf = (editor: Editor, n: SceneNode): readonly Subpath[] => {
    if (n.type === 'path') return n.subpaths;
    const geometry = pathGeometry(editor.ck, editor.geometry.outlineOf(n));
    if (!geometry) return [];
    const { box } = geometry;
    return geometry.subpaths.map((s) => ({
      closed: s.closed,
      anchors: s.anchors.map((a) => ({
        x: a.x + box.x,
        y: a.y + box.y,
        inX: a.inX + box.x,
        inY: a.inY + box.y,
        outX: a.outX + box.x,
        outY: a.outY + box.y,
      })),
    }));
  };

  const toScreen = (editor: Editor, n: SceneNode) => {
    const m = worldTransform(editor.store, n.id);
    return (x: number, y: number): Point => {
      const [wx, wy] = applyToPoint(m, x, y);
      return editor.worldToScreen(wx, wy);
    };
  };

  const toLocal = (editor: Editor, n: SceneNode, world: Point): Point | null => {
    const inverse = invert(worldTransform(editor.store, n.id));
    if (!inverse) return null;
    const [x, y] = applyToPoint(inverse, world.x, world.y);
    return { x, y };
  };

  const hitAt = (editor: Editor, x: number, y: number): HandleHit | null => {
    const n = node(editor);
    if (!editable(n)) return null;
    const screen = toScreen(editor, n);
    const subpaths = anchorsOf(editor, n);
    // 选中的锚点的控制柄优先（常常和别的锚点挨得很近）
    for (const key of picked) {
      const [s, i] = parseKey(key);
      const a = subpaths[s]?.anchors[i];
      if (!a || !isSmooth(a)) continue;
      for (const which of ['out', 'in'] as const) {
        const p = which === 'in' ? screen(a.inX, a.inY) : screen(a.outX, a.outY);
        if (Math.hypot(p.x - x, p.y - y) <= HIT) return { kind: 'handle', key, which };
      }
    }
    for (let s = 0; s < subpaths.length; s++) {
      const anchors = subpaths[s]!.anchors;
      for (let i = 0; i < anchors.length; i++) {
        const p = screen(anchors[i]!.x, anchors[i]!.y);
        if (Math.hypot(p.x - x, p.y - y) <= HIT) return { kind: 'anchor', key: anchorKey(s, i) };
      }
    }
    return null;
  };

  /** 矩形、椭圆拖锚点前先拼合成路径（id 不变）；返回转好的路径 */
  const ensurePath = (editor: Editor): PathNode | null => {
    const n = node(editor);
    if (!n) return null;
    if (n.type === 'path') return n;
    editor.select([n.id]);
    editor.commands.run('path.flatten');
    const converted = editor.store.get(n.id);
    return converted?.type === 'path' ? converted : null;
  };

  const write = (editor: Editor, subpaths: readonly Subpath[], key: string): void => {
    if (!target) return;
    editor.store.transact('edit anchors', (tx) => tx.update(target!, { subpaths }), { mergeKey: key });
  };

  /** 松手时把节点的外框重新对齐到路径的范围（同一步撤销） */
  const finish = (editor: Editor, key: string): void => {
    const n = node(editor);
    if (n?.type !== 'path') return;
    const normalized = normalizePath(editor, n, n.subpaths);
    editor.store.transact('edit anchors', (tx) => tx.update(n.id, normalized), { mergeKey: key });
    editor.store.sealHistory();
  };

  const adopt = (editor: Editor): void => {
    const selected = editor.selectedNodes();
    target = selected.length === 1 && editable(selected[0]) ? selected[0]!.id : null;
    picked = new Set();
  };

  return {
    id: 'direct',
    cursor: 'default',

    onActivate(editor) {
      adopt(editor);
      editor.requestRender();
    },

    onDeactivate() {
      target = null;
      picked = new Set();
      drag = null;
    },

    onPointerDown(e, editor) {
      if (target && !editor.selection.includes(target)) adopt(editor);
      const hit = hitAt(editor, e.x, e.y);
      if (hit?.kind === 'handle') {
        const path = ensurePath(editor);
        if (!path) return;
        drag = {
          kind: 'handle',
          anchor: hit.key,
          which: hit.which,
          original: path.subpaths,
          key: editor.newMergeKey('handle'),
        };
        return;
      }
      if (hit?.kind === 'anchor') {
        if (e.shift) {
          const next = new Set(picked);
          if (next.has(hit.key)) next.delete(hit.key);
          else next.add(hit.key);
          picked = next;
        } else if (!picked.has(hit.key)) {
          picked = new Set([hit.key]);
        }
        drag = { kind: 'pending', x: e.x, y: e.y, start: e.world };
        editor.requestRender();
        return;
      }
      // 没点中锚点：换一个要改的对象（深选），或者在当前对象上框选锚点
      const deep = editor.pickDeep(e.world);
      if (deep && deep.id !== target && editable(deep)) {
        editor.select([deep.id]);
        target = deep.id;
        picked = new Set();
        editor.requestRender();
        return;
      }
      if (!deep && !target) {
        editor.clearSelection();
        return;
      }
      drag = { kind: 'marquee', start: e.world, current: e.world, base: e.shift ? new Set(picked) : new Set() };
      if (!e.shift) picked = new Set();
    },

    onPointerMove(e, editor) {
      if (!e.down || !drag) {
        const hit = hitAt(editor, e.x, e.y);
        editor.setCursor(hit ? 'pointer' : 'default');
        return;
      }
      const n = node(editor);
      if (drag.kind === 'pending') {
        if (Math.hypot(e.x - drag.x, e.y - drag.y) < DRAG_THRESHOLD) return;
        const path = ensurePath(editor);
        if (!path) {
          drag = null;
          return;
        }
        const start = toLocal(editor, path, drag.start);
        if (!start) return;
        drag = { kind: 'anchors', start, original: path.subpaths, key: editor.newMergeKey('anchors') };
      }
      if (drag.kind === 'anchors' && n) {
        let world = e.world;
        // 吸附：拿第一个选中的锚点去吸（按着 ⌘ 时不吸）
        const first = [...picked][0];
        if (editor.snapping && !e.mod && first) {
          const [s, i] = parseKey(first);
          const a = drag.original[s]?.anchors[i];
          const local = toLocal(editor, n, e.world);
          if (a && local) {
            const m = worldTransform(editor.store, n.id);
            const [ax, ay] = applyToPoint(m, a.x + local.x - drag.start.x, a.y + local.y - drag.start.y);
            const hit = snapPoint(editor.snapTargets([n.id]), { x: ax, y: ay }, { threshold: editor.snapThreshold });
            world = { x: e.world.x + hit.point.x - ax, y: e.world.y + hit.point.y - ay };
            editor.setSnapFeedback({ lines: hit.lines, spacing: [] });
          }
        }
        const local = toLocal(editor, n, world);
        if (!local) return;
        let dx = local.x - drag.start.x;
        let dy = local.y - drag.start.y;
        if (e.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        write(editor, moveAnchors(drag.original, picked, dx, dy), drag.key);
        return;
      }
      if (drag.kind === 'handle' && n) {
        const local = toLocal(editor, n, e.world);
        if (!local) return;
        write(editor, moveHandle(drag.original, drag.anchor, drag.which, local, e.alt), drag.key);
        return;
      }
      if (drag.kind === 'marquee' && n) {
        drag.current = e.world;
        const a = editor.worldToScreen(drag.start.x, drag.start.y);
        const b = editor.worldToScreen(e.world.x, e.world.y);
        const rect = rectFromPoints(a.x, a.y, b.x, b.y);
        const screen = toScreen(editor, n);
        const next = new Set(drag.base);
        anchorsOf(editor, n).forEach((s, si) =>
          s.anchors.forEach((anchor, i) => {
            const p = screen(anchor.x, anchor.y);
            if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
              next.add(anchorKey(si, i));
            }
          }),
        );
        picked = next;
      }
    },

    onPointerUp(_e, editor) {
      const finished = drag;
      drag = null;
      editor.setSnapFeedback(null);
      if (finished?.kind === 'anchors' || finished?.kind === 'handle') finish(editor, finished.key);
      editor.requestRender();
    },

    onCancel(editor) {
      const cancelled = drag;
      drag = null;
      editor.setSnapFeedback(null);
      if (cancelled?.kind === 'anchors' || cancelled?.kind === 'handle') editor.store.abandon(cancelled.key);
    },

    onDoubleClick(e, editor) {
      const hit = hitAt(editor, e.x, e.y);
      if (hit?.kind === 'anchor') {
        const path = ensurePath(editor);
        if (!path) return;
        const key = editor.newMergeKey('smooth');
        write(editor, toggleSmooth(path.subpaths, hit.key), key);
        finish(editor, key);
        return;
      }
      // 双击空白处：回到选择工具
      if (!editor.pickDeep(e.world)) editor.setTool('select');
    },

    onKeyDown(event, editor) {
      const n = node(editor);
      if ((event.key === 'Delete' || event.key === 'Backspace') && picked.size > 0 && n) {
        const path = ensurePath(editor);
        if (!path) return true;
        const subpaths = deleteAnchors(path.subpaths, picked);
        picked = new Set();
        if (subpaths.length === 0) {
          editor.commands.run('edit.delete');
          target = null;
          return true;
        }
        const key = editor.newMergeKey('delete anchors');
        write(editor, subpaths, key);
        finish(editor, key);
        return true;
      }
      if (event.key.startsWith('Arrow') && picked.size > 0 && n) {
        const path = ensurePath(editor);
        if (!path) return true;
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        const key = `nudge-anchors:${target}`;
        write(editor, moveAnchors(path.subpaths, picked, dx, dy), key);
        return true;
      }
      if (event.key === 'Escape') {
        if (picked.size > 0) picked = new Set();
        else editor.setTool('select');
        return true;
      }
      if (event.key === 'Enter') {
        editor.setTool('select');
        return true;
      }
      return false;
    },

    drawOverlay(ctx, editor) {
      const n = node(editor);
      if (!editable(n)) return;
      const screen = toScreen(editor, n);
      const subpaths = anchorsOf(editor, n);
      ctx.save();
      ctx.strokeStyle = editor.theme.accent;
      ctx.lineWidth = 1;
      // 路径本身
      ctx.beginPath();
      for (const s of subpaths) {
        const first = s.anchors[0];
        if (!first) continue;
        const p0 = screen(first.x, first.y);
        ctx.moveTo(p0.x, p0.y);
        const count = s.closed ? s.anchors.length : s.anchors.length - 1;
        for (let i = 0; i < count; i++) {
          const a = s.anchors[i]!;
          const b = s.anchors[(i + 1) % s.anchors.length]!;
          const c1 = screen(a.outX, a.outY);
          const c2 = screen(b.inX, b.inY);
          const p = screen(b.x, b.y);
          ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
        }
        if (s.closed) ctx.closePath();
      }
      ctx.stroke();
      // 选中的锚点的控制柄
      for (const key of picked) {
        const [si, i] = parseKey(key);
        const a = subpaths[si]?.anchors[i];
        if (!a || !isSmooth(a)) continue;
        const p = screen(a.x, a.y);
        for (const h of [screen(a.inX, a.inY), screen(a.outX, a.outY)]) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(h.x, h.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(h.x, h.y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = editor.theme.handleFill;
          ctx.fill();
          ctx.stroke();
        }
      }
      // 锚点：选中的实心
      subpaths.forEach((s, si) =>
        s.anchors.forEach((a, i) => {
          const p = screen(a.x, a.y);
          const on = picked.has(anchorKey(si, i));
          ctx.fillStyle = on ? editor.theme.accent : editor.theme.handleFill;
          ctx.fillRect(p.x - ANCHOR_SIZE / 2, p.y - ANCHOR_SIZE / 2, ANCHOR_SIZE, ANCHOR_SIZE);
          ctx.strokeRect(p.x - ANCHOR_SIZE / 2 + 0.5, p.y - ANCHOR_SIZE / 2 + 0.5, ANCHOR_SIZE - 1, ANCHOR_SIZE - 1);
        }),
      );
      // 框选
      if (drag?.kind === 'marquee') {
        const a = editor.worldToScreen(drag.start.x, drag.start.y);
        const b = editor.worldToScreen(drag.current.x, drag.current.y);
        const rect = rectFromPoints(a.x, a.y, b.x, b.y);
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = editor.theme.accent;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.globalAlpha = 1;
        ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.round(rect.w), Math.round(rect.h));
      }
      ctx.restore();
    },
  };
}
