import { beforeAll, describe, expect, it } from 'vitest';
import type { Anchor, PathNode, Subpath } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { deleteAnchors, moveHandle, segmentAt, splitSegment, toggleSmooth } from '../src/path-edit';
import { canvasKit, pointer, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

const corner = (x: number, y: number): Anchor => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const curve: Subpath = {
  closed: false,
  anchors: [
    { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: -60 },
    { x: 120, y: 0, inX: 120, inY: -60, outX: 120, outY: 0 },
  ],
};

describe('改锚点的纯函数', () => {
  it('在线段上加锚点，形状不变', () => {
    const [split] = splitSegment([curve], 0, 0, 0.5);
    expect(split!.anchors).toHaveLength(3);
    const mid = split!.anchors[1]!;
    // 原曲线在 t = 0.5 处：(60, -45)
    expect(mid.x).toBeCloseTo(60);
    expect(mid.y).toBeCloseTo(-45);
    expect(segmentAt([curve], { x: 60, y: -44 }, 3)).toMatchObject({ sub: 0, index: 0 });
    expect(segmentAt([curve], { x: 60, y: 30 }, 3)).toBeNull();
  });

  it('删锚点；尖角和平滑互相切换', () => {
    const square: Subpath = { closed: true, anchors: [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)] };
    expect(deleteAnchors([square], new Set(['0:1']))[0]!.anchors).toHaveLength(3);
    expect(deleteAnchors([square], new Set(['0:0', '0:1', '0:2']))).toEqual([]);
    const smooth = toggleSmooth([square], '0:1')[0]!.anchors[1]!;
    expect(smooth.inX).not.toBe(smooth.x);
    // 控制柄沿前后两个锚点的连线方向：(0,0) → (100,100)
    expect(smooth.outX - smooth.x).toBeCloseTo(smooth.outY - smooth.y);
    const back = toggleSmooth(toggleSmooth([square], '0:1'), '0:1')[0]!.anchors[1]!;
    expect(back).toEqual(corner(100, 0));
  });

  it('拖控制柄：平滑锚点的另一根反向跟着转，按住 Alt 只动这一根', () => {
    const smooth: Subpath = {
      closed: false,
      anchors: [corner(0, 0), { x: 50, y: 0, inX: 30, inY: 0, outX: 70, outY: 0 }, corner(100, 0)],
    };
    const mirrored = moveHandle([smooth], '0:1', 'out', { x: 50, y: 30 }, false)[0]!.anchors[1]!;
    expect([mirrored.outX, mirrored.outY]).toEqual([50, 30]);
    expect(mirrored.inX).toBeCloseTo(50);
    expect(mirrored.inY).toBeCloseTo(-20);
    const broken = moveHandle([smooth], '0:1', 'out', { x: 50, y: 30 }, true)[0]!.anchors[1]!;
    expect([broken.inX, broken.inY]).toEqual([30, 0]);
  });
});

describe('直接选择工具', () => {
  it('矩形拖锚点：先转成路径（id 不变），锚点挪过去，外框重新对齐', () => {
    const s = scene(ck, [[100, 100, 100, 100]]);
    s.editor.select([s.rects[0]!]);
    s.editor.setTool('direct');
    const tool = s.editor.tools.get('direct')!;
    // 右下角的锚点在 (200, 200)
    tool.onPointerDown!(pointer({ x: 200, y: 200 }), s.editor);
    tool.onPointerMove!(pointer({ x: 210, y: 210 }), s.editor);
    tool.onPointerMove!(pointer({ x: 250, y: 230 }), s.editor);
    tool.onPointerUp!(pointer({ x: 250, y: 230 }, { down: false }), s.editor);
    const node = s.store.get(s.rects[0]!) as PathNode;
    expect(node.type).toBe('path');
    expect(node.size).toEqual([150, 130]);
    expect(s.editor.geometry.worldBounds(node)).toEqual({ x: 100, y: 100, w: 150, h: 130 });
  });

  it('框选锚点后按 ⌫ 删掉；双击锚点变平滑', () => {
    const s = scene(ck, [[100, 100, 100, 100]]);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('path.flatten');
    s.editor.setTool('direct');
    const tool = s.editor.tools.get('direct')!;
    // 框住右边的两个锚点
    tool.onPointerDown!(pointer({ x: 190, y: 50 }), s.editor);
    tool.onPointerMove!(pointer({ x: 260, y: 260 }), s.editor);
    tool.onPointerUp!(pointer({ x: 260, y: 260 }, { down: false }), s.editor);
    tool.onKeyDown!({ key: 'Backspace' } as KeyboardEvent, s.editor);
    const node = s.store.get(s.rects[0]!) as PathNode;
    expect(node.subpaths[0]!.anchors).toHaveLength(2);
  });

  it('钢笔停在选中路径的线段上单击加锚点，停在锚点上单击删锚点', () => {
    const s = scene(ck, [[100, 100, 100, 100]]);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('path.flatten');
    s.editor.setTool('pen');
    const pen = s.editor.tools.get('pen')!;
    pen.onPointerDown!(pointer({ x: 150, y: 100 }), s.editor);
    pen.onPointerUp!(pointer({ x: 150, y: 100 }, { down: false }), s.editor);
    const anchors = () => (s.store.get(s.rects[0]!) as PathNode).subpaths[0]!.anchors.length;
    expect(anchors()).toBe(5);
    pen.onPointerDown!(pointer({ x: 150, y: 100 }), s.editor);
    pen.onPointerUp!(pointer({ x: 150, y: 100 }, { down: false }), s.editor);
    expect(anchors()).toBe(4);
  });
});
