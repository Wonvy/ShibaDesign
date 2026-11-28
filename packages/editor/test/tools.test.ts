import { beforeAll, describe, expect, it } from 'vitest';
import { rgba, solid, type Anchor, type PathNode, type PolygonNode, type RectNode } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { fitCurve } from '../src';
import { canvasKit, pointer, scene, type Scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

/** 用当前工具从 a 拖到 b（mod 关掉吸附，免得落点被吸走） */
function drag(
  s: Scene,
  a: { x: number; y: number },
  b: { x: number; y: number },
  options: { shift?: boolean; alt?: boolean } = {},
) {
  const tool = s.editor.tool;
  tool.onPointerDown!(pointer(a, { mod: true, ...options }), s.editor);
  tool.onPointerMove!(pointer({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { mod: true, ...options }), s.editor);
  tool.onPointerMove!(pointer(b, { mod: true, ...options }), s.editor);
  tool.onPointerUp!(pointer(b, { mod: true, down: false, ...options }), s.editor);
}

/** 选中的那一个节点 */
const selected = <T>(s: Scene) => s.store.get(s.editor.selection[0]!) as T;

/** 一段三次曲线上 t 处的点 */
function bezier(a: Anchor, b: Anchor, t: number) {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * a.outX + 3 * u * t * t * b.inX + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * a.outY + 3 * u * t * t * b.inY + t * t * t * b.y,
  };
}

/** 一串点离拟合出来的曲线最远有多远 */
function worstDistance(points: { x: number; y: number }[], anchors: Anchor[], closed: boolean): number {
  const samples: { x: number; y: number }[] = [];
  const count = closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k <= 200; k++) samples.push(bezier(anchors[i]!, anchors[(i + 1) % anchors.length]!, k / 200));
  }
  let worst = 0;
  for (const p of points) {
    let best = Infinity;
    for (const q of samples) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('直线和箭头', () => {
  it('拖出一条两个锚点的开放路径，只有描边；画完选中它、回到选择工具', () => {
    const s = scene(ck);
    s.editor.setTool('line');
    drag(s, { x: 300, y: 300 }, { x: 500, y: 400 });
    const path = selected<PathNode>(s);
    expect(path.type).toBe('path');
    expect(path.fill).toBeNull();
    expect(path.stroke?.arrowEnd).toBeUndefined();
    expect(path.subpaths).toHaveLength(1);
    expect(path.subpaths[0]!.closed).toBe(false);
    expect(path.transform).toEqual([1, 0, 0, 1, 300, 300]);
    expect(path.size).toEqual([200, 100]);
    expect(path.subpaths[0]!.anchors.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [200, 100],
    ]);
    expect(s.editor.tool.id).toBe('select');
  });

  it('按住 Shift 方向锁定在 45° 的倍数上；按住 Alt 以起点为中点往两边画', () => {
    const s = scene(ck);
    s.editor.setTool('line');
    drag(s, { x: 300, y: 300 }, { x: 500, y: 320 }, { shift: true });
    const flat = selected<PathNode>(s);
    expect(flat.size[1]).toBeCloseTo(0, 9);
    expect(flat.size[0]).toBeCloseTo(Math.hypot(200, 20), 9);

    s.editor.setTool('line');
    drag(s, { x: 500, y: 300 }, { x: 600, y: 350 }, { alt: true });
    const centered = selected<PathNode>(s);
    expect(centered.transform).toEqual([1, 0, 0, 1, 400, 250]);
    expect(centered.size).toEqual([200, 100]);
  });

  it('箭头工具在终点加一个箭头；一步撤销', () => {
    const s = scene(ck);
    s.editor.setTool('arrow');
    drag(s, { x: 300, y: 300 }, { x: 500, y: 300 });
    const arrow = selected<PathNode>(s);
    expect(arrow.stroke?.arrowEnd).toBe('arrow');
    expect(arrow.stroke?.arrowStart).toBeUndefined();
    s.store.undo();
    expect(s.store.get(arrow.id)).toBeUndefined();
  });

  it('点一下不动不画；Esc 取消正在画的线', () => {
    const s = scene(ck);
    s.editor.setTool('line');
    const before = s.store.children(s.board).length;
    const tool = s.editor.tool;
    tool.onPointerDown!(pointer({ x: 300, y: 300 }, { mod: true }), s.editor);
    tool.onPointerUp!(pointer({ x: 300, y: 300 }, { mod: true, down: false }), s.editor);
    expect(s.store.children(s.board).length).toBe(before);
    tool.onPointerDown!(pointer({ x: 300, y: 300 }, { mod: true }), s.editor);
    tool.onPointerMove!(pointer({ x: 400, y: 300 }, { mod: true }), s.editor);
    expect(s.store.children(s.board).length).toBe(before + 1);
    tool.onCancel!(s.editor);
    expect(s.store.children(s.board).length).toBe(before);
  });
});

describe('多边形和星形', () => {
  it('多边形工具画三角形，星形工具画五角星；对象名字分开叫', () => {
    const s = scene(ck);
    s.editor.setTool('polygon');
    drag(s, { x: 300, y: 300 }, { x: 400, y: 400 });
    const triangle = selected<PolygonNode>(s);
    expect(triangle).toMatchObject({ type: 'polygon', sides: 3, size: [100, 100], cornerRadius: 0 });
    expect(triangle.innerRatio).toBeUndefined();
    s.editor.setTool('star');
    drag(s, { x: 500, y: 300 }, { x: 600, y: 400 });
    const star = selected<PolygonNode>(s);
    expect(star).toMatchObject({ type: 'polygon', sides: 5 });
    expect(star.innerRatio).toBeCloseTo(0.382, 3);
  });
});

describe('工具锁定', () => {
  it('锁住的工具画完不回到选择工具；换工具时解开；再锁一次解开', () => {
    const s = scene(ck);
    s.editor.lockTool('rect');
    expect(s.editor.toolLocked).toBe(true);
    drag(s, { x: 300, y: 300 }, { x: 400, y: 400 });
    drag(s, { x: 500, y: 300 }, { x: 600, y: 400 });
    expect(s.editor.tool.id).toBe('rect');
    expect(s.store.children(s.board).filter((n) => n.type === 'rect')).toHaveLength(3);
    s.editor.setTool('ellipse');
    expect(s.editor.toolLocked).toBe(false);
    s.editor.setTool('rect');
    expect(s.editor.toolLocked).toBe(false);
    s.editor.lockTool('line');
    s.editor.lockTool('line');
    expect(s.editor.toolLocked).toBe(false);
    expect(s.editor.tool.id).toBe('line');
  });

  it('Esc：锁着时解锁回到选择工具，选中的不变；没锁时取消选择', () => {
    const s = scene(ck);
    s.editor.select([s.rects[0]!]);
    s.editor.lockTool('ellipse');
    s.editor.commands.run('edit.deselect');
    expect(s.editor.tool.id).toBe('select');
    expect(s.editor.toolLocked).toBe(false);
    expect(s.editor.selection).toEqual([s.rects[0]]);
    s.editor.commands.run('edit.deselect');
    expect(s.editor.selection).toEqual([]);
  });
});

describe('铅笔', () => {
  it('手画的曲线拟合成少量锚点的平滑路径，离画过的点不超过容差', () => {
    const points = Array.from({ length: 120 }, (_, i) => ({ x: i * 5, y: 300 + Math.sin(i / 10) * 60 }));
    const anchors = fitCurve(points, 2.5);
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    expect(anchors.length).toBeLessThan(15);
    expect(worstDistance(points, anchors, false)).toBeLessThan(2.5);
    // 一条直线只剩两个锚点
    expect(
      fitCurve(
        [0, 1, 2, 3, 4, 5].map((i) => ({ x: i * 20, y: i * 10 })),
        2,
      ),
    ).toHaveLength(2);
    expect(fitCurve([{ x: 1, y: 1 }], 2)).toEqual([]);
    // 闭合：首尾重合，接口两边的控制柄在一条直线上
    const ring = Array.from({ length: 60 }, (_, i) => ({
      x: Math.cos((i / 60) * Math.PI * 2) * 100,
      y: Math.sin((i / 60) * Math.PI * 2) * 100,
    }));
    const loop = fitCurve(ring, 1, true);
    const first = loop[0]!;
    const last = loop[loop.length - 1]!;
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(1e-9);
    const cross = (first.outX - first.x) * (last.inY - last.y) - (first.outY - first.y) * (last.inX - last.x);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    expect(worstDistance(ring, loop, false)).toBeLessThan(1);
  });

  it('画一圈回到起点附近是闭合的形状；没回到起点是开放的线', () => {
    const s = scene(ck);
    s.editor.setTool('pencil');
    const tool = s.editor.tool;
    const circle = Array.from({ length: 73 }, (_, i) => {
      const a = (i / 72) * Math.PI * 2;
      return { x: 500 + Math.cos(a) * 100, y: 300 + Math.sin(a) * 100 };
    });
    tool.onPointerDown!(pointer(circle[0]!), s.editor);
    for (const p of circle.slice(1)) tool.onPointerMove!(pointer(p), s.editor);
    tool.onPointerUp!(pointer(circle[72]!, { down: false }), s.editor);
    const closed = selected<PathNode>(s);
    expect(closed.subpaths[0]!.closed).toBe(true);
    expect(closed.subpaths[0]!.anchors.length).toBeLessThan(12);
    // 拟合出来的圆和原来的圆差不到 3 个像素（坐标换回世界坐标比较）
    const [, , , , ox, oy] = closed.transform;
    const world = closed.subpaths[0]!.anchors.map((a) => ({
      x: a.x + ox,
      y: a.y + oy,
      inX: a.inX + ox,
      inY: a.inY + oy,
      outX: a.outX + ox,
      outY: a.outY + oy,
    }));
    expect(worstDistance(circle, world, true)).toBeLessThan(3);
    expect(s.editor.tool.id).toBe('select');

    s.editor.setTool('pencil');
    const arc = circle.slice(0, 30);
    tool.onPointerDown!(pointer(arc[0]!), s.editor);
    for (const p of arc.slice(1)) tool.onPointerMove!(pointer(p), s.editor);
    tool.onPointerUp!(pointer(arc[29]!, { down: false }), s.editor);
    expect(selected<PathNode>(s).subpaths[0]!.closed).toBe(false);
  });
});

describe('等比缩放', () => {
  function strokedRect() {
    const s = scene(ck, [[100, 100, 100, 100]]);
    s.store.transact('look', (tx) =>
      tx.update(s.rects[0]!, { cornerRadius: 10, stroke: { color: rgba(0, 0, 0), width: 2, dash: [4, 2] } }),
    );
    s.store.sealHistory();
    s.editor.select([s.rects[0]!]);
    return s;
  }

  it('缩放工具：以选区中心为中心拖到两倍，尺寸、描边、虚线、圆角一起变；一步撤销', () => {
    const s = strokedRect();
    s.editor.setTool('scale');
    const tool = s.editor.tool;
    tool.onPointerDown!(pointer({ x: 250, y: 150 }), s.editor);
    tool.onPointerMove!(pointer({ x: 300, y: 150 }), s.editor);
    tool.onPointerMove!(pointer({ x: 350, y: 150 }), s.editor);
    tool.onPointerUp!(pointer({ x: 350, y: 150 }, { down: false }), s.editor);
    const rect = s.store.get(s.rects[0]!) as RectNode;
    expect(rect.size).toEqual([200, 200]);
    expect(rect.transform[4]).toBeCloseTo(50, 9);
    expect(rect.transform[5]).toBeCloseTo(50, 9);
    expect(rect.cornerRadius).toBeCloseTo(20, 9);
    expect(rect.stroke).toMatchObject({ width: 4, dash: [8, 4] });
    s.store.undo();
    expect(s.store.get(s.rects[0]!)).toMatchObject({ size: [100, 100], cornerRadius: 10, stroke: { width: 2 } });
  });

  it('按住 Alt 单击换缩放中心，之后拖动以它为中心', () => {
    const s = strokedRect();
    s.editor.setTool('scale');
    const tool = s.editor.tool;
    tool.onPointerDown!(pointer({ x: 100, y: 100 }, { alt: true }), s.editor);
    tool.onPointerUp!(pointer({ x: 100, y: 100 }, { alt: true, down: false }), s.editor);
    tool.onPointerDown!(pointer({ x: 200, y: 200 }), s.editor);
    tool.onPointerMove!(pointer({ x: 150, y: 150 }), s.editor);
    tool.onPointerUp!(pointer({ x: 150, y: 150 }, { down: false }), s.editor);
    const rect = s.store.get(s.rects[0]!) as RectNode;
    // 左上角不动，缩到一半
    expect(rect.transform[4]).toBeCloseTo(100, 9);
    expect(rect.transform[5]).toBeCloseTo(100, 9);
    expect(rect.size[0]).toBeCloseTo(50, 9);
    expect(rect.stroke?.width).toBeCloseTo(1, 9);
  });

  it('Esc 取消正在进行的缩放', () => {
    const s = strokedRect();
    s.editor.setTool('scale');
    const tool = s.editor.tool;
    tool.onPointerDown!(pointer({ x: 250, y: 150 }), s.editor);
    tool.onPointerMove!(pointer({ x: 350, y: 150 }), s.editor);
    tool.onCancel!(s.editor);
    expect(s.store.get(s.rects[0]!)).toMatchObject({ size: [100, 100], stroke: { width: 2 } });
  });

  it('“等比缩放”命令按百分比缩放；百分比不是正数时不可用', () => {
    const s = strokedRect();
    s.editor.commands.run('arrange.scale', 50);
    const rect = s.store.get(s.rects[0]!) as RectNode;
    expect(rect.size).toEqual([50, 50]);
    expect(rect.cornerRadius).toBeCloseTo(5, 9);
    expect(rect.stroke?.width).toBeCloseTo(1, 9);
    expect(s.editor.commands.canRun('arrange.scale', 0)).toBe(false);
  });
});

describe('吸管和视图缩放', () => {
  it('吸管：点一个对象，把它的填充和描边套到选中的对象上；按住 Alt 只取填充', () => {
    const s = scene(ck, [
      [100, 100, 100, 100],
      [300, 100, 100, 100],
    ]);
    s.store.transact('look', (tx) =>
      tx.update(s.rects[1]!, { fill: solid(rgba(0, 0, 1)), stroke: { color: rgba(0, 1, 0), width: 6 }, opacity: 0.5 }),
    );
    s.store.sealHistory();
    s.editor.select([s.rects[0]!]);
    s.editor.setTool('eyedropper');
    s.editor.tool.onPointerDown!(pointer({ x: 350, y: 150 }, { alt: true }), s.editor);
    expect(s.store.get(s.rects[0]!)).toMatchObject({ fill: solid(rgba(0, 0, 1)), stroke: null, opacity: 1 });
    s.editor.tool.onPointerDown!(pointer({ x: 350, y: 150 }), s.editor);
    expect(s.store.get(s.rects[0]!)).toMatchObject({ stroke: { width: 6 }, opacity: 0.5 });
    // 选中的还是原来那个
    expect(s.editor.selection).toEqual([s.rects[0]]);
  });

  it('视图缩放：单击放大一倍，按住 Alt 单击缩小一半，点的位置不动', () => {
    const s = scene(ck);
    s.editor.setTool('zoom');
    const tool = s.editor.tool;
    tool.onPointerDown!(pointer({ x: 200, y: 100 }), s.editor);
    tool.onPointerUp!(pointer({ x: 200, y: 100 }, { down: false }), s.editor);
    expect(s.editor.camera.zoom).toBeCloseTo(2, 9);
    expect(s.editor.worldToScreen(200, 100)).toEqual({ x: 200, y: 100 });
    tool.onPointerDown!(pointer({ x: 200, y: 100 }, { alt: true }), s.editor);
    tool.onPointerUp!(pointer({ x: 200, y: 100 }, { alt: true, down: false }), s.editor);
    expect(s.editor.camera.zoom).toBeCloseTo(1, 9);
  });
});

describe('效果跟着等比缩放和复制属性', () => {
  it('等比缩放时阴影的偏移、模糊、扩展和模糊半径按比例变；复制属性带上效果', () => {
    const s = scene(ck, [
      [100, 100, 100, 100],
      [300, 100, 100, 100],
    ]);
    s.store.transact('fx', (tx) =>
      tx.update(s.rects[0]!, {
        effects: [
          { type: 'dropShadow', color: rgba(0, 0, 0, 0.3), x: 2, y: 4, blur: 8, spread: 1 },
          { type: 'layerBlur', radius: 6 },
        ],
      }),
    );
    s.store.sealHistory();
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('arrange.scale', 200);
    expect((s.store.get(s.rects[0]!) as RectNode).effects).toEqual([
      { type: 'dropShadow', color: rgba(0, 0, 0, 0.3), x: 4, y: 8, blur: 16, spread: 2 },
      { type: 'layerBlur', radius: 12 },
    ]);
    s.editor.commands.run('edit.copyProperties');
    s.editor.select([s.rects[1]!]);
    s.editor.commands.run('edit.pasteProperties');
    expect((s.store.get(s.rects[1]!) as RectNode).effects).toHaveLength(2);
  });
});
