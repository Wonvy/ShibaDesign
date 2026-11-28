import {
  IDENTITY,
  applyToPoint,
  createNode,
  invert,
  nextSeq,
  translation,
  worldTransform,
  type Anchor,
  type NodeId,
  type Point,
} from '@shiba/core';
import type { Editor } from '../editor';
import { DEFAULT_STROKE } from '../ops';
import { snapPoint, type SnapTargets } from '../snap';
import type { PointerInfo } from '../types';
import type { Tool } from './tool';

const DRAG_THRESHOLD = 3;
/** 按住 Shift 时方向吸附的步长：45° */
const ANGLE_SNAP = Math.PI / 4;

interface Drag {
  start: Point;
  x: number;
  y: number;
  containerId: NodeId;
  nodeId: NodeId | null;
  key: string;
  targets: SnapTargets;
}

const corner = (x: number, y: number): Anchor => ({ x, y, inX: x, inY: y, outX: x, outY: y });

/** 终点：吸附到附近的边和中线，按住 Shift 方向锁定在 45° 的倍数上 */
function endPoint(editor: Editor, drag: Drag, e: PointerInfo): Point {
  let p = e.world;
  if (e.shift) {
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const angle = Math.round(Math.atan2(dy, dx) / ANGLE_SNAP) * ANGLE_SNAP;
    const length = Math.hypot(dx, dy);
    p = { x: drag.start.x + Math.cos(angle) * length, y: drag.start.y + Math.sin(angle) * length };
    editor.setSnapFeedback(null);
    return p;
  }
  if (!editor.snapping || e.mod) {
    editor.setSnapFeedback(null);
    return p;
  }
  const hit = snapPoint(drag.targets, p, { threshold: editor.snapThreshold, pixels: editor.view.snapPixels });
  editor.setSnapFeedback({ lines: hit.lines, spacing: [] });
  return hit.point;
}

/**
 * 直线（L）和箭头（⇧L）：拖出一条两个锚点的开放钢笔路径，只有描边；箭头在终点有一个开口的箭头。
 * 按住 Shift 方向锁定在 45° 的倍数上，按住 Alt 以起点为中点往两边画；起点终点吸附到附近的边和中线
 */
export function createLineTool(kind: 'line' | 'arrow'): Tool {
  let drag: Drag | null = null;

  const write = (editor: Editor, current: Drag, from: Point, to: Point): void => {
    const { store } = editor;
    const inverse = invert(worldTransform(store, current.containerId)) ?? IDENTITY;
    const [ax, ay] = applyToPoint(inverse, from.x, from.y);
    const [bx, by] = applyToPoint(inverse, to.x, to.y);
    const ox = Math.min(ax, bx);
    const oy = Math.min(ay, by);
    const subpaths = [{ closed: false, anchors: [corner(ax - ox, ay - oy), corner(bx - ox, by - oy)] }];
    const patch = { transform: translation(ox, oy), size: [Math.abs(bx - ax), Math.abs(by - ay)] as const, subpaths };
    store.transact(
      'create',
      (tx) => {
        if (current.nodeId) {
          tx.update(current.nodeId, patch);
          return;
        }
        const node = createNode('path', {
          parent: current.containerId,
          index: store.indexOnTop(current.containerId),
          seq: nextSeq(store, 'path'),
          ...patch,
          fillRule: 'nonzero',
          fill: null,
          stroke: { color: DEFAULT_STROKE, width: 2, ...(kind === 'arrow' ? { arrowEnd: 'arrow' as const } : {}) },
        });
        current.nodeId = tx.create(node).id;
      },
      { mergeKey: current.key },
    );
  };

  return {
    id: kind,
    cursor: 'crosshair',

    onDeactivate() {
      drag = null;
    },

    onCancel(editor) {
      if (drag?.nodeId) editor.store.abandon(drag.key);
      drag = null;
      editor.setSnapFeedback(null);
    },

    onPointerDown(e, editor) {
      const targets = editor.snapTargets([]);
      let start = e.world;
      if (editor.snapping && !e.mod) start = snapPoint(targets, e.world, { threshold: editor.snapThreshold }).point;
      drag = {
        start,
        x: e.x,
        y: e.y,
        containerId: editor.containerAt(e.world).id,
        nodeId: null,
        key: editor.newMergeKey('create'),
        targets,
      };
    },

    onPointerMove(e, editor) {
      if (!e.down || !drag) return;
      const current = drag;
      if (!current.nodeId && Math.hypot(e.x - current.x, e.y - current.y) < DRAG_THRESHOLD) return;
      const end = endPoint(editor, current, e);
      // 按住 Alt：起点是中点，往两边画
      const from = e.alt ? { x: 2 * current.start.x - end.x, y: 2 * current.start.y - end.y } : current.start;
      write(editor, current, from, end);
    },

    onPointerUp(_e, editor) {
      const finished = drag;
      drag = null;
      editor.setSnapFeedback(null);
      if (!finished?.nodeId) return;
      editor.store.sealHistory();
      editor.select([finished.nodeId]);
      if (!editor.toolLocked) editor.setTool('select');
    },
  };
}
