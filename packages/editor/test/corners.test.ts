import { beforeAll, describe, expect, it } from 'vitest';
import type { PathNode, RectNode } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { cornerTarget, widgetScreen } from '../src';
import { canvasKit, pointer, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

describe('画布上的圆角控件', () => {
  it('只选中一个够大的矩形时出现，四个角各一个', () => {
    const s = scene(ck, [
      [100, 100, 200, 100],
      [400, 100, 20, 20],
    ]);
    s.editor.select([s.rects[0]!]);
    const target = cornerTarget(s.editor)!;
    expect(target.widgets.map((w) => w.key)).toEqual(['0', '1', '2', '3']);
    // 半径是 0 时控件在离角 14 像素的角平分线上
    const p = widgetScreen(s.editor, target, target.widgets[0]!);
    expect(p.x).toBeCloseTo(100 + 14 / Math.SQRT2);
    expect(p.y).toBeCloseTo(100 + 14 / Math.SQRT2);
    s.editor.select([s.rects[1]!]);
    expect(cornerTarget(s.editor)).toBeNull();
    s.editor.select([s.rects[0]!, s.rects[1]!]);
    expect(cornerTarget(s.editor)).toBeNull();
  });

  it('拖控件四个角一起变；按住 Alt 只改这一个；一步撤销', () => {
    const s = scene(ck, [[100, 100, 200, 100]]);
    s.editor.select([s.rects[0]!]);
    const select = s.editor.tools.get('select')!;
    const start = widgetScreen(s.editor, cornerTarget(s.editor)!, cornerTarget(s.editor)!.widgets[0]!);
    select.onPointerDown!(pointer(start), s.editor);
    // 沿角平分线往里拖 20√2：半径加 20
    select.onPointerMove!(pointer({ x: start.x + 20, y: start.y + 20 }), s.editor);
    select.onPointerUp!(pointer({ x: start.x + 20, y: start.y + 20 }, { down: false }), s.editor);
    const rect = () => s.store.get(s.rects[0]!) as RectNode;
    expect(rect().cornerRadius).toBe(20);
    expect(rect().cornerRadii).toBeUndefined();

    const target = cornerTarget(s.editor)!;
    const corner = widgetScreen(s.editor, target, target.widgets[2]!);
    select.onPointerDown!(pointer(corner, { alt: true }), s.editor);
    select.onPointerMove!(pointer({ x: corner.x - 10, y: corner.y - 10 }, { alt: true }), s.editor);
    select.onPointerUp!(pointer({ x: corner.x - 10, y: corner.y - 10 }, { alt: true, down: false }), s.editor);
    expect(rect().cornerRadii).toEqual([20, 20, 30, 20]);
    s.store.undo();
    expect(rect().cornerRadii).toBeUndefined();
    expect(rect().cornerRadius).toBe(20);
  });

  it('半径不超过短边的一半', () => {
    const s = scene(ck, [[100, 100, 200, 100]]);
    s.editor.select([s.rects[0]!]);
    const select = s.editor.tools.get('select')!;
    const start = widgetScreen(s.editor, cornerTarget(s.editor)!, cornerTarget(s.editor)!.widgets[0]!);
    select.onPointerDown!(pointer(start), s.editor);
    select.onPointerMove!(pointer({ x: start.x + 300, y: start.y + 300 }), s.editor);
    select.onPointerUp!(pointer({ x: start.x + 300, y: start.y + 300 }, { down: false }), s.editor);
    expect((s.store.get(s.rects[0]!) as RectNode).cornerRadius).toBe(50);
  });

  it('Alt 单击控件换圆角样式', () => {
    const s = scene(ck, [[100, 100, 200, 100]]);
    s.editor.select([s.rects[0]!]);
    const select = s.editor.tools.get('select')!;
    const click = () => {
      const target = cornerTarget(s.editor)!;
      const p = widgetScreen(s.editor, target, target.widgets[1]!);
      select.onPointerDown!(pointer(p, { alt: true }), s.editor);
      select.onPointerUp!(pointer(p, { alt: true, down: false }), s.editor);
    };
    click();
    expect((s.store.get(s.rects[0]!) as RectNode).cornerStyle).toBe('inverted');
    click();
    expect((s.store.get(s.rects[0]!) as RectNode).cornerStyle).toBe('chamfer');
    click();
    expect((s.store.get(s.rects[0]!) as RectNode).cornerStyle).toBe('round');
  });

  it('路径：每个两边都是直线的尖角有控件，拖它改锚点的半径', () => {
    const s = scene(ck, [[100, 100, 200, 200]]);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('path.flatten');
    const path = () => s.store.get(s.rects[0]!) as PathNode;
    expect(path().type).toBe('path');
    const target = cornerTarget(s.editor)!;
    expect(target.widgets).toHaveLength(4);
    const select = s.editor.tools.get('select')!;
    const p = widgetScreen(s.editor, target, target.widgets[0]!);
    select.onPointerDown!(pointer(p), s.editor);
    select.onPointerMove!(pointer({ x: p.x + 15, y: p.y + 15 }), s.editor);
    select.onPointerUp!(pointer({ x: p.x + 15, y: p.y + 15 }, { down: false }), s.editor);
    expect(path().subpaths[0]!.anchors.map((a) => a.radius)).toEqual([15, 15, 15, 15]);
    // 缩放以后半径还在
    s.editor.commands.run('edit.resize', { dw: 20, dh: 0 });
    expect(path().subpaths[0]!.anchors.every((a) => a.radius === 15)).toBe(true);
  });
});
