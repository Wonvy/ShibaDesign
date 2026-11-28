import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DocStore,
  createNode,
  motionPathEnds,
  rgba,
  solid,
  translation,
  type ArtboardNode,
  type Point,
  type SlideAnimation,
} from '@shiba/core';
import { loadCanvasKit, type CanvasKit } from '@shiba/renderer';
import { createEditor, hitMotionHandle, motionHandles, motionPathsOf, type Editor } from '../src';
import type { PointerInfo } from '../src/types';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

/** 一页 1000 × 600 的幻灯片放在世界坐标 (200, 100)，上面一个 100 × 100 的矩形，中心在幻灯片的 (150, 150) */
function setup(): { editor: Editor; store: DocStore; slide: () => ArtboardNode; rect: string } {
  const store = DocStore.create();
  const board = store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        transform: translation(200, 100),
        size: [1000, 600],
        fill: solid(rgba(1, 1, 1)),
        deck: { order: 'a0', notes: '' },
      }),
    ),
  );
  const rect = store.transact('rect', (tx) =>
    tx.create(
      createNode('rect', {
        parent: board.id,
        index: 'a0',
        seq: 1,
        transform: translation(100, 100),
        size: [100, 100],
        cornerRadius: 0,
        fill: solid(rgba(1, 0, 0)),
        stroke: null,
      }),
    ),
  );
  const editor = createEditor({
    ck,
    store,
    theme: { background: rgba(0, 0, 0), accent: '#00f', label: '#888', handleFill: '#fff' },
    defaultFonts: { latin: 'Inter', cjk: 'Noto Sans SC' },
  });
  editor.select([rect.id]);
  return { editor, store, slide: () => store.get(board.id) as ArtboardNode, rect: rect.id };
}

/** 相机没动时屏幕坐标就是世界坐标 */
function pointer(world: Point, down = true): PointerInfo {
  return { x: world.x, y: world.y, world, shift: false, alt: false, mod: false, button: 0, down };
}

function key(name: string): KeyboardEvent {
  return { key: name } as KeyboardEvent;
}

const animations = (slide: ArtboardNode): readonly SlideAnimation[] => slide.deck?.animations ?? [];

describe('动作路径', () => {
  it('加直线、弧线、圆形：路径按幻灯片大小生成，从对象中心出发', () => {
    const { editor, slide } = setup();
    editor.commands.run('animation.add', { effect: 'motion.line' });
    const [added] = animations(slide());
    expect(added!.path).toEqual({
      closed: false,
      anchors: [
        { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
        { x: 250, y: 0, inX: 250, inY: 0, outX: 250, outY: 0 },
      ],
    });
    // 自定义路径没有预设的路径，不能直接加
    expect(editor.commands.canRun('animation.add', { effect: 'motion.custom' })).toBe(false);
  });

  it('画自定义路径：从对象中心出发，路径存成相对中心的位移；画完回到选择工具，一步撤销', () => {
    const { editor, store, slide, rect } = setup();
    expect(editor.commands.run('animation.drawPath')).toBe(true);
    expect(editor.getState().tool).toBe('motion-path');
    const tool = editor.tool;
    // 对象中心在世界坐标 (350, 250)；单击 (500, 250)，再在 (500, 400) 按住拖到 (560, 400) 拉出曲线
    tool.onPointerDown!(pointer({ x: 500, y: 250 }), editor);
    tool.onPointerUp!(pointer({ x: 500, y: 250 }, false), editor);
    tool.onPointerDown!(pointer({ x: 500, y: 400 }), editor);
    tool.onPointerMove!(pointer({ x: 560, y: 400 }), editor);
    tool.onPointerUp!(pointer({ x: 560, y: 400 }, false), editor);
    tool.onKeyDown!(key('Enter'), editor);

    expect(editor.getState().tool).toBe('select');
    expect(editor.selection).toEqual([rect]);
    const [added] = animations(slide());
    expect(added).toMatchObject({ effect: 'motion.custom', target: rect });
    expect(added!.path!.anchors.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [150, 0],
      [150, 150],
    ]);
    expect(added!.path!.anchors[2]).toMatchObject({ outX: 210, outY: 150, inX: 90, inY: 150 });
    store.undo();
    expect(animations(slide())).toHaveLength(0);
  });

  it('Esc 什么都没画就取消，不加动画', () => {
    const { editor, slide } = setup();
    editor.commands.run('animation.drawPath');
    editor.tool.onKeyDown!(key('Escape'), editor);
    expect(editor.getState().tool).toBe('select');
    expect(animations(slide())).toHaveLength(0);
  });

  it('第二条路径从第一条的终点出发：画布上显示的位置和画的时候都接着', () => {
    const { editor, slide, rect } = setup();
    editor.commands.run('animation.add', { effect: 'motion.line' });
    editor.commands.run('animation.drawPath');
    const tool = editor.tool;
    // 第一条走到幻灯片 (400, 150)，世界坐标 (600, 250)；从那里往下画 100
    tool.onPointerDown!(pointer({ x: 600, y: 350 }), editor);
    tool.onPointerUp!(pointer({ x: 600, y: 350 }, false), editor);
    tool.onKeyDown!(key('Enter'), editor);
    const [, second] = animations(slide());
    expect(second!.path!.anchors.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [0, 100],
    ]);
    const views = motionPathsOf(editor, [rect]);
    expect(views.map((v) => v.origin)).toEqual([
      { x: 150, y: 150 },
      { x: 400, y: 150 },
    ]);
  });

  it('选中对象时在画布上拖终点改路径；整个拖动是一步撤销', () => {
    const { editor, store, slide } = setup();
    editor.commands.run('animation.add', { effect: 'motion.line' });
    store.sealHistory();
    // 终点在幻灯片 (400, 150)，世界坐标 (600, 250)
    const end = motionHandles(editor).find((h) => h.part === 'anchor' && h.index === 1)!;
    expect(end.screen).toEqual({ x: 600, y: 250 });
    expect(hitMotionHandle(editor, 603, 252)).toMatchObject({ index: 1, part: 'anchor' });

    const select = editor.tool;
    select.onPointerDown!(pointer({ x: 600, y: 250 }), editor);
    select.onPointerMove!(pointer({ x: 620, y: 300 }), editor);
    select.onPointerMove!(pointer({ x: 640, y: 350 }), editor);
    select.onPointerUp!(pointer({ x: 640, y: 350 }, false), editor);
    const [moved] = animations(slide());
    expect(motionPathEnds(moved!.path).end).toEqual({ x: 290, y: 100 });
    // 拖的是路径的手柄，对象自己没动
    expect(store.get(editor.selection[0]!)!.transform).toEqual(translation(100, 100));
    store.undo();
    expect(motionPathEnds(animations(slide())[0]!.path).end).toEqual({ x: 250, y: 0 });
  });

  it('拖平滑锚点的一根控制柄，另一根反向跟着转', () => {
    const { editor, slide } = setup();
    editor.commands.run('animation.add', { effect: 'motion.arc' });
    const [arc] = animations(slide());
    const middle = arc!.path!.anchors[1]!;
    const handle = motionHandles(editor).find((h) => h.index === 1 && h.part === 'out')!;
    const select = editor.tool;
    select.onPointerDown!(pointer(handle.screen), editor);
    select.onPointerMove!(pointer({ x: handle.screen.x, y: handle.screen.y - 40 }), editor);
    select.onPointerUp!(pointer({ x: handle.screen.x, y: handle.screen.y - 40 }, false), editor);
    const after = animations(slide())[0]!.path!.anchors[1]!;
    expect(after.outY).toBeCloseTo(middle.outY - 40, 6);
    expect(after.inX + after.outX).toBeCloseTo(2 * after.x, 6);
    expect(after.inY + after.outY).toBeCloseTo(2 * after.y, 6);
  });

  it('反转路径方向', () => {
    const { editor, slide } = setup();
    editor.commands.run('animation.add', { effect: 'motion.line' });
    const [added] = animations(slide());
    editor.commands.run('animation.reversePath', { slideId: slide().id, id: added!.id });
    expect(motionPathEnds(animations(slide())[0]!.path)).toEqual({ start: { x: 250, y: 0 }, end: { x: 0, y: 0 } });
  });

  it('没选中对象、或者换了别的工具时不显示路径手柄', () => {
    const { editor } = setup();
    editor.commands.run('animation.add', { effect: 'motion.line' });
    expect(motionHandles(editor).length).toBeGreaterThan(0);
    editor.clearSelection();
    expect(motionHandles(editor)).toEqual([]);
  });
});

describe('钢笔工具（和画动作路径共用一套画法）', () => {
  it('单击两点、回车：生成一条开放的路径', () => {
    const { editor, store, slide } = setup();
    editor.setTool('pen');
    const tool = editor.tool;
    tool.onPointerDown!(pointer({ x: 300, y: 500 }), editor);
    tool.onPointerUp!(pointer({ x: 300, y: 500 }, false), editor);
    tool.onPointerDown!(pointer({ x: 400, y: 520 }), editor);
    tool.onPointerUp!(pointer({ x: 400, y: 520 }, false), editor);
    tool.onKeyDown!(key('Enter'), editor);
    const path = store.get(editor.selection[0]!)!;
    expect(path.type).toBe('path');
    expect(path.parent).toBe(slide().id);
    expect(path.type === 'path' && path.subpaths[0]!.closed).toBe(false);
    expect(editor.geometry.worldBounds(path)).toMatchObject({ x: 300, y: 500, w: 100, h: 20 });
  });
});

describe('演讲者备注', () => {
  it('打字时连续写进文档，一次编辑是一步撤销；内容没变时不写', async () => {
    const { setSlideNotes } = await import('../src');
    const { editor, store, slide } = setup();
    const key = editor.newMergeKey('notes');
    setSlideNotes(editor, slide().id, '第', key);
    setSlideNotes(editor, slide().id, '第一', key);
    setSlideNotes(editor, slide().id, '第一点', key);
    store.sealHistory();
    expect(slide().deck!.notes).toBe('第一点');
    const version = store.version;
    setSlideNotes(editor, slide().id, '第一点');
    expect(store.version).toBe(version);
    store.undo();
    expect(slide().deck!.notes).toBe('');
  });
});
