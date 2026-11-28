import { beforeAll, describe, expect, it } from 'vitest';
import { slides, translation, worldTransform, type FrameNode, type SceneNode } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { cornerTarget } from '../src';
import { canvasKit, pointer, scene, type Scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

/** 用当前工具从 a 拖到 b（mod 关掉吸附） */
function drag(s: Scene, a: { x: number; y: number }, b: { x: number; y: number }) {
  const tool = s.editor.tool;
  tool.onPointerDown!(pointer(a, { mod: true }), s.editor);
  tool.onPointerMove!(pointer({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { mod: true }), s.editor);
  tool.onPointerMove!(pointer(b, { mod: true }), s.editor);
  tool.onPointerUp!(pointer(b, { mod: true, down: false }), s.editor);
}

/** 节点在世界坐标里的位置（变换的平移部分） */
const at = (s: Scene, id: string) => worldTransform(s.store, id).slice(4);

/** 画板里 (400,200) 起一个 300 × 200 的画框，返回它的 id */
function addFrame(s: Scene): string {
  s.editor.setTool('frame');
  drag(s, { x: 400, y: 200 }, { x: 700, y: 400 });
  return s.editor.selection[0]!;
}

describe('画框工具', () => {
  it('在画板里画出白底、裁剪内容的画框；在画板外面（画布视图）画的是新的一页', () => {
    const s = scene(ck);
    const id = addFrame(s);
    const frame = s.store.get(id) as FrameNode;
    expect(frame).toMatchObject({ type: 'frame', parent: s.board, size: [300, 200], clip: true, cornerRadius: 0 });
    expect(frame.transform).toEqual(translation(400, 200));
    expect(s.editor.tool.id).toBe('select');

    s.editor.setTool('frame');
    drag(s, { x: 1200, y: 0 }, { x: 1500, y: 300 });
    const board = s.store.get(s.editor.selection[0]!)!;
    expect(board).toMatchObject({ type: 'artboard', parent: s.store.root.id, size: [300, 300] });
    expect(slides(s.store).at(-1)?.id).toBe(board.id);
  });

  it('画框里画的形状放进画框；画框改大小时里面的东西不动', () => {
    const s = scene(ck);
    const frame = addFrame(s);
    s.editor.setTool('rect');
    drag(s, { x: 450, y: 250 }, { x: 500, y: 300 });
    const rect = s.editor.selection[0]!;
    expect(s.store.get(rect)?.parent).toBe(frame);
    expect(s.store.get(rect)?.transform).toEqual(translation(50, 50));
    s.editor.select([frame]);
    s.editor.commands.run('arrange.scale', 200);
    // 等比缩放画框只改它自己（里面的东西以后按约束跟着变）
    expect(s.store.get(frame)?.size).toEqual([600, 400]);
    expect(s.store.get(rect)?.size).toEqual([50, 50]);
  });
});

describe('选择画框里的东西', () => {
  it('单击里面的东西选中画框，单击空白处也选中画框；双击进去选中里面的，之后单击里面别的也是选里面的', () => {
    const s = scene(ck, [
      [420, 220, 40, 40],
      [520, 220, 40, 40],
    ]);
    const frame = addFrame(s);
    // 把两个矩形放进画框（画框在 400,200）
    s.store.transact('move in', (tx) => {
      tx.update(s.rects[0]!, { parent: frame, index: 'a0', transform: translation(20, 20) });
      tx.update(s.rects[1]!, { parent: frame, index: 'a1', transform: translation(120, 20) });
    });
    const select = s.editor.tools.get('select')!;

    s.editor.select([]);
    expect(s.editor.pick({ x: 440, y: 240 }).node?.id).toBe(frame);
    expect(s.editor.pick({ x: 650, y: 350 }).node?.id).toBe(frame);
    select.onDoubleClick!(pointer({ x: 440, y: 240 }), s.editor);
    expect(s.editor.selection).toEqual([s.rects[0]]);
    expect(s.editor.pick({ x: 540, y: 240 }).node?.id).toBe(s.rects[1]);
    // 选择父级回到画框
    s.editor.commands.run('select.parent');
    expect(s.editor.selection).toEqual([frame]);
  });

  it('把对象拖进画框就放进去、拖出来就拿出来，画布上的位置不变；拖画框时里面的东西跟着走', () => {
    const s = scene(ck, [[100, 100, 40, 40]]);
    const frame = addFrame(s);
    const select = s.editor.tools.get('select')!;
    s.editor.setTool('select');
    s.editor.select([s.rects[0]!]);
    select.onPointerDown!(pointer({ x: 120, y: 120 }), s.editor);
    select.onPointerMove!(pointer({ x: 300, y: 200 }), s.editor);
    select.onPointerMove!(pointer({ x: 520, y: 320 }, { mod: true }), s.editor);
    select.onPointerUp!(pointer({ x: 520, y: 320 }, { mod: true, down: false }), s.editor);
    const inside = s.store.get(s.rects[0]!)!;
    expect(inside.parent).toBe(frame);
    expect(at(s, inside.id)).toEqual([500, 300]);

    // 拖画框：画框不会放进自己里面，矩形跟着挪
    s.editor.select([frame]);
    select.onPointerDown!(pointer({ x: 650, y: 380 }), s.editor);
    select.onPointerMove!(pointer({ x: 660, y: 390 }, { mod: true }), s.editor);
    select.onPointerMove!(pointer({ x: 700, y: 400 }, { mod: true }), s.editor);
    select.onPointerUp!(pointer({ x: 700, y: 400 }, { mod: true, down: false }), s.editor);
    expect(s.store.get(frame)?.parent).toBe(s.board);
    expect(at(s, inside.id)).toEqual([550, 320]);

    // 双击进去，把矩形拖到画框外面
    select.onDoubleClick!(pointer({ x: 570, y: 340 }), s.editor);
    expect(s.editor.selection).toEqual([inside.id]);
    select.onPointerDown!(pointer({ x: 570, y: 340 }), s.editor);
    select.onPointerMove!(pointer({ x: 400, y: 340 }, { mod: true }), s.editor);
    select.onPointerMove!(pointer({ x: 170, y: 140 }, { mod: true }), s.editor);
    select.onPointerUp!(pointer({ x: 170, y: 140 }, { mod: true, down: false }), s.editor);
    expect(s.store.get(inside.id)?.parent).toBe(s.board);
    expect(at(s, inside.id)).toEqual([150, 120]);
  });
});

describe('用画框包起来', () => {
  it('画框正好框住选中的对象、没有填充、不裁剪；画布上的位置不变；一步撤销；取消编组去掉画框', () => {
    const s = scene(ck, [
      [100, 100, 100, 50],
      [300, 200, 50, 100],
    ]);
    s.editor.select([s.rects[0]!, s.rects[1]!]);
    s.editor.commands.run('frame.wrap');
    const frame = s.store.get(s.editor.selection[0]!) as FrameNode;
    expect(frame).toMatchObject({ type: 'frame', parent: s.board, size: [250, 200], fill: null, clip: false });
    expect(frame.transform).toEqual(translation(100, 100));
    expect(s.store.children(frame.id).map((n: SceneNode) => n.id)).toEqual([s.rects[0], s.rects[1]]);
    expect(at(s, s.rects[1]!)).toEqual([300, 200]);
    expect(s.store.get(s.rects[1]!)?.transform).toEqual(translation(200, 100));

    s.editor.commands.run('group.release');
    expect(s.store.get(frame.id)).toBeUndefined();
    expect(s.store.get(s.rects[1]!)?.parent).toBe(s.board);
    expect(at(s, s.rects[1]!)).toEqual([300, 200]);
    s.store.undo();
    s.store.undo();
    expect(s.store.get(s.rects[1]!)?.parent).toBe(s.board);
    expect(s.store.get(frame.id)).toBeUndefined();
  });
});

describe('画框的圆角', () => {
  it('画框和矩形一样有画布上的圆角控件；等比缩放时圆角跟着变', () => {
    const s = scene(ck);
    const frame = addFrame(s);
    expect(cornerTarget(s.editor)?.widgets).toHaveLength(4);
    s.store.transact('r', (tx) => tx.update(frame, { cornerRadius: 12 }));
    s.editor.commands.run('arrange.scale', 50);
    expect((s.store.get(frame) as FrameNode).cornerRadius).toBeCloseTo(6, 9);
  });
});
