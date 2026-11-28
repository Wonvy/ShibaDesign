import {
  createNode,
  nextSeq,
  rectFromPoints,
  solid,
  translation,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '../editor';
import { DEFAULT_FILL, localOrigin } from '../ops';
import type { Tool } from './tool';

const DRAG_THRESHOLD = 3;
const DEFAULT_SIZE = 100;

interface Drag {
  start: Point;
  x: number;
  y: number;
  containerId: NodeId;
  nodeId: NodeId | null;
  key: string;
  /** 上一次的鼠标位置，按住空格挪动形状时用 */
  last: Point;
}

/**
 * 拖出来的矩形。按住 Shift 是正方形，按住 Alt 以起点为中心往外画（两个一起是以起点为中心的正方形）
 */
export function dragRect(start: Point, current: Point, square: boolean, fromCenter: boolean): Rect {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  if (fromCenter) return rectFromPoints(start.x - dx, start.y - dy, start.x + dx, start.y + dy);
  return rectFromPoints(start.x, start.y, start.x + dx, start.y + dy);
}

/**
 * 形状工具：拖出一个矩形或椭圆；单击不拖动时创建默认大小。
 * 按住 Shift 约束为正方形或正圆，按住 Alt 从中心画，拖动中按住空格挪动正在画的形状
 */
export function createShapeTool(kind: 'rect' | 'ellipse'): Tool {
  let drag: Drag | null = null;

  const build = (editor: Editor, containerId: NodeId, rect: Rect): SceneNode => {
    const { store } = editor;
    const origin = localOrigin(store, containerId, rect);
    const common = {
      parent: containerId,
      index: store.indexOnTop(containerId),
      seq: nextSeq(store, kind),
      transform: translation(origin.x, origin.y),
      size: [rect.w, rect.h] as const,
      fill: solid(DEFAULT_FILL),
      stroke: null,
    };
    return kind === 'rect' ? createNode('rect', { ...common, cornerRadius: 0 }) : createNode('ellipse', common);
  };

  return {
    id: kind,
    cursor: 'crosshair',

    onDeactivate() {
      drag = null;
    },

    onCancel(editor) {
      // 已经画出来的形状撤掉，像没画过一样
      if (drag?.nodeId) editor.store.abandon(drag.key);
      drag = null;
    },

    onPointerDown(e, editor) {
      drag = {
        start: e.world,
        x: e.x,
        y: e.y,
        containerId: editor.containerAt(e.world).id,
        nodeId: null,
        key: editor.newMergeKey('create'),
        last: e.world,
      };
    },

    onPointerMove(e, editor) {
      if (!e.down || !drag) return;
      const current = drag;
      if (!current.nodeId && Math.hypot(e.x - current.x, e.y - current.y) < DRAG_THRESHOLD) return;

      if (e.space) {
        current.start = {
          x: current.start.x + e.world.x - current.last.x,
          y: current.start.y + e.world.y - current.last.y,
        };
      }
      current.last = e.world;
      const rect = dragRect(current.start, e.world, e.shift, e.alt);

      editor.store.transact(
        'create',
        (tx) => {
          if (!current.nodeId) {
            current.nodeId = tx.create(build(editor, current.containerId, rect)).id;
          } else {
            const origin = localOrigin(editor.store, current.containerId, rect);
            tx.update(current.nodeId, { transform: translation(origin.x, origin.y), size: [rect.w, rect.h] });
          }
        },
        { mergeKey: current.key },
      );
    },

    onPointerUp(_e, editor) {
      const finished = drag;
      drag = null;
      if (!finished) return;
      let id = finished.nodeId;
      if (!id) {
        const rect: Rect = {
          x: finished.start.x - DEFAULT_SIZE / 2,
          y: finished.start.y - DEFAULT_SIZE / 2,
          w: DEFAULT_SIZE,
          h: DEFAULT_SIZE,
        };
        id = editor.store.transact('create', (tx) => tx.create(build(editor, finished.containerId, rect)).id);
      }
      editor.store.sealHistory();
      editor.select([id]);
      editor.setTool('select');
    },
  };
}
