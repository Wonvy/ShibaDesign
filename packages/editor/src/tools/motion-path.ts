import {
  CUSTOM_MOTION_EFFECT,
  applyToPoint,
  invert,
  worldTransform,
  type Anchor,
  type NodeId,
  type Point,
} from '@shiba/core';
import { slideLayerOf } from '../commands/animation';
import type { Editor } from '../editor';
import { motionOrigin } from '../motion-handles';
import { createPathDrawingTool } from './path-drawing';
import type { Tool } from './tool';

/**
 * 画自定义的动作路径：从选中对象的中心出发（已有动作路径的话从最后一条的终点出发），像钢笔一样单击加点、拖动拉出曲线，回车或点最后一个点结束，
 * 点回起点是绕一圈回来。画完给这个对象加一条"自定义路径"动画，回到选择工具。
 * 开始画时只能选着一个幻灯片上的对象（见 animation.drawPath 命令）
 */
export function createMotionPathTool(): Tool {
  /** 正在给哪个对象画：它所在的幻灯片、图层，以及路径的出发点（幻灯片坐标） */
  let target: { slideId: NodeId; layerId: NodeId; center: Point } | null = null;

  const done = (editor: Editor): void => {
    const layer = target?.layerId;
    target = null;
    if (editor.getState().tool === 'motion-path') editor.setTool('select');
    if (layer && editor.store.has(layer)) editor.select([layer]);
  };

  return createPathDrawingTool({
    id: 'motion-path',
    start(editor) {
      const id = editor.selection.length === 1 ? editor.selection[0]! : null;
      const found = id ? slideLayerOf(editor.store, id) : null;
      // 已经有动作路径的话，从最后一条的终点接着画，和播放时一致
      const center = found ? motionOrigin(editor, found.layer.id) : null;
      if (!found || !center) {
        target = null;
        return null;
      }
      target = { slideId: found.slide.id, layerId: found.layer.id, center };
      const [x, y] = applyToPoint(worldTransform(editor.store, found.slide.id), center.x, center.y);
      return { x, y };
    },
    finish(editor, points, closed) {
      const current = target;
      if (!current || !editor.store.has(current.layerId)) {
        done(editor);
        return;
      }
      // 世界坐标 → 幻灯片坐标，再减去出发点：路径存的是相对出发点的位移
      const inverse = invert(worldTransform(editor.store, current.slideId));
      if (!inverse) {
        done(editor);
        return;
      }
      const local = (x: number, y: number): [number, number] => {
        const [lx, ly] = applyToPoint(inverse, x, y);
        return [lx - current.center.x, ly - current.center.y];
      };
      const anchors = points.map((a): Anchor => {
        const [x, y] = local(a.x, a.y);
        const [inX, inY] = local(a.inX, a.inY);
        const [outX, outY] = local(a.outX, a.outY);
        return { x, y, inX, inY, outX, outY };
      });
      editor.select([current.layerId]);
      editor.commands.run('animation.add', { effect: CUSTOM_MOTION_EFFECT, path: { closed, anchors } });
      done(editor);
    },
    cancel: done,
  });
}
