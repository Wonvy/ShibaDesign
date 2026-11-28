import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DocStore,
  applyToPoint,
  colorStyles,
  createNode,
  isComponent,
  isInstance,
  rgba,
  solid,
  textStyles,
  translation,
  worldTransform,
  type GroupNode,
  type NodeId,
  type RectNode,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import { loadCanvasKit, type CanvasKit } from '@shiba/renderer';
import { captureOriginals, createEditor, resizeLocal, type Editor } from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

const GREY = rgba(0.5, 0.5, 0.5);
const RED = rgba(1, 0, 0);

function setup(): { editor: Editor; store: DocStore; board: NodeId } {
  const store = DocStore.create();
  const board = store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size: [1280, 720],
        fill: solid(rgba(1, 1, 1)),
        deck: { order: 'a0', notes: '' },
      }),
    ),
  ).id;
  const editor = createEditor({
    ck,
    store,
    theme: { background: rgba(0, 0, 0), accent: '#00f', label: '#888', handleFill: '#fff' },
    defaultFonts: { latin: 'Inter', cjk: 'Noto Sans SC' },
  });
  editor.viewport = { width: 1600, height: 1000 };
  return { editor, store, board };
}

function addRect(store: DocStore, parent: NodeId, x: number, y: number, w = 100, h = 50): RectNode {
  return store.transact('rect', (tx) =>
    tx.create(
      createNode('rect', {
        parent,
        index: store.indexOnTop(parent),
        seq: 1,
        transform: translation(x, y),
        size: [w, h],
        fill: solid(GREY),
        stroke: { color: RED, width: 2 },
        cornerRadius: 0,
      }),
    ),
  );
}

function addText(store: DocStore, parent: NodeId, x: number, y: number): TextNode {
  return store.transact('text', (tx) =>
    tx.create(
      createNode('text', {
        parent,
        index: store.indexOnTop(parent),
        seq: 1,
        transform: translation(x, y),
        text: '按钮',
        style: {
          fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
          fontSize: 20,
          fontWeight: 400,
          lineHeight: 1.4,
          letterSpacing: 0,
        },
        align: 'left',
        sizing: 'auto',
        fill: solid(rgba(0, 0, 0)),
      }),
    ),
  );
}

/** 选中两个对象做成组件，再放一个实例，返回主组件和实例 */
function makeComponent(editor: Editor, store: DocStore, board: NodeId): { main: GroupNode; instance: GroupNode } {
  const a = addRect(store, board, 100, 100);
  const b = addRect(store, board, 120, 160, 40, 20);
  editor.select([a.id, b.id]);
  expect(editor.commands.run('component.create')).toBe(true);
  const main = store.get(editor.selection[0]!) as GroupNode;
  editor.commands.run('component.place', { componentId: main.id, at: { x: 800, y: 400 } });
  const instance = store.get(editor.selection[0]!) as GroupNode;
  return { main, instance };
}

describe('组件命令', () => {
  it('选中几个对象做成主组件，再放一个实例：实例的中心在指定的位置', () => {
    const { editor, store, board } = setup();
    const { main, instance } = makeComponent(editor, store, board);
    expect(isComponent(main)).toBe(true);
    expect(main.seq).toBe(1);
    expect(isInstance(instance)).toBe(true);
    expect(instance.parent).toBe(board);
    const bounds = editor.geometry.worldBounds(instance);
    expect(bounds.x + bounds.w / 2).toBeCloseTo(800);
    expect(bounds.y + bounds.h / 2).toBeCloseTo(400);
    expect(bounds.w).toBeCloseTo(editor.geometry.worldBounds(main).w);
  });

  it('只选一个普通编组时直接把它标成主组件', () => {
    const { editor, store, board } = setup();
    const a = addRect(store, board, 0, 0);
    editor.select([a.id]);
    editor.commands.run('group.create');
    const group = editor.selection[0]!;
    editor.commands.run('component.create');
    expect(editor.selection).toEqual([group]);
    expect(isComponent(store.get(group))).toBe(true);
  });

  it('实例里的东西不能编组、复制、调层序、转轮廓；删除等于隐藏', () => {
    const { editor, store, board } = setup();
    const { instance } = makeComponent(editor, store, board);
    const [first, second] = store.children(instance.id);
    editor.select([first!.id, second!.id]);
    expect(editor.commands.canRun('group.create')).toBe(false);
    expect(editor.commands.canRun('component.create')).toBe(false);
    expect(editor.commands.canRun('edit.duplicate')).toBe(false);
    expect(editor.commands.canRun('arrange.order', 'front')).toBe(false);
    expect(editor.commands.canRun('path.outlineStroke')).toBe(false);
    expect(editor.commands.canRun('boolean.create', 'union')).toBe(false);
    editor.commands.run('edit.delete');
    expect(store.children(instance.id)).toHaveLength(2);
    expect(store.get(first!.id)!.visible).toBe(false);
    expect(store.get(first!.id)!.overrides).toEqual(['visible']);
    // 重置之后回来
    editor.select([instance.id]);
    editor.commands.run('component.reset');
    expect(store.get(first!.id)!.visible).toBe(true);
  });

  it('主组件不能放进主组件，主组件里不能放自己的实例', () => {
    const { editor, store, board } = setup();
    const { main, instance } = makeComponent(editor, store, board);
    // 把实例和主组件里的东西编到一起：编组会把实例挪进主组件
    editor.select([store.children(main.id)[0]!.id, instance.id]);
    expect(editor.commands.canRun('group.create')).toBe(false);
    // 主组件和别的东西一起再做成组件
    const other = addRect(store, board, 600, 600);
    editor.select([main.id, other.id]);
    expect(editor.commands.canRun('component.create')).toBe(false);
    // 主组件里的东西不能再做组件
    editor.select([store.children(main.id)[0]!.id]);
    expect(editor.commands.canRun('component.create')).toBe(false);
  });

  it('实例拖大一倍：写进变换矩阵，主组件改了照样同步，一步撤销', () => {
    const { editor, store, board } = setup();
    const { main, instance } = makeComponent(editor, store, board);
    const box = editor.geometry.localBounds(instance);
    const originals = captureOriginals(store, [instance.id]);
    store.transact(
      'resize',
      (tx) => resizeLocal(tx, store, originals, instance.id, box, { ...box, w: box.w * 2, h: box.h * 2 }),
      {},
    );
    store.sealHistory();
    const scaled = store.get(instance.id)!;
    expect(scaled.transform[0]).toBeCloseTo(2);
    expect(scaled.transform[3]).toBeCloseTo(2);
    // 左上角不动，大小翻倍
    const before = applyToPoint(worldTransform(store, instance.id), box.x, box.y);
    expect(editor.geometry.worldBounds(scaled).w).toBeCloseTo(box.w * 2);
    const copy = store.children(instance.id)[0] as RectNode;
    expect(copy.size).toEqual([100, 50]);
    expect(copy.stroke?.width).toBe(2);
    // 主组件改大小，实例的副本照样跟着改，画出来按 2 倍
    const mainRect = store.children(main.id)[0]!;
    store.transact('main', (tx) => tx.update(mainRect.id, { size: [150, 50] }));
    expect((store.children(instance.id)[0] as RectNode).size).toEqual([150, 50]);
    expect(applyToPoint(worldTransform(store, instance.id), box.x, box.y)).toEqual(before);
  });

  it('分离实例后不再同步；跳到主组件选中它', () => {
    const { editor, store, board } = setup();
    const { main, instance } = makeComponent(editor, store, board);
    editor.select([instance.id]);
    expect(editor.commands.run('component.goToMain')).toBe(true);
    expect(editor.selection).toEqual([main.id]);
    editor.select([instance.id]);
    editor.commands.run('component.detach');
    expect(isInstance(store.get(instance.id))).toBe(false);
    const mainRect = store.children(main.id)[0]!;
    store.transact('main', (tx) => tx.update(mainRect.id, { size: [10, 10] }));
    expect((store.children(instance.id)[0] as RectNode).size).toEqual([100, 50]);
  });

  it('取消实例的编组：里面的东西变成普通对象，留在原处', () => {
    const { editor, store, board } = setup();
    const { instance } = makeComponent(editor, store, board);
    const before = editor.geometry.worldBounds(store.children(instance.id)[0]!);
    editor.select([instance.id]);
    editor.commands.run('group.release');
    expect(store.has(instance.id)).toBe(false);
    const released = editor.selectedNodes();
    expect(released).toHaveLength(2);
    expect(released.every((n: SceneNode) => n.source === undefined && n.parent === board)).toBe(true);
    const after = editor.geometry.worldBounds(released[0]!);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});

describe('样式命令', () => {
  it('从选中对象的颜色新建颜色样式并链接；改样式时对象跟着变；删样式断开', () => {
    const { editor, store, board } = setup();
    const a = addRect(store, board, 0, 0);
    const b = addRect(store, board, 200, 0);
    editor.select([a.id]);
    editor.commands.run('style.color.add', { id: 's1', name: '  主色  ', color: GREY, link: 'fill' });
    expect(colorStyles(store)).toEqual([{ id: 's1', name: '主色', color: GREY }]);
    editor.select([b.id]);
    editor.commands.run('style.color.apply', { id: 's1', target: 'stroke' });
    expect((store.get(b.id) as RectNode).stroke).toEqual({ color: GREY, width: 2, colorStyle: 's1' });

    const key = editor.newMergeKey('style');
    editor.commands.run('style.color.update', { id: 's1', color: rgba(0, 0.5, 0), mergeKey: key });
    editor.commands.run('style.color.update', { id: 's1', color: rgba(0, 0, 1), mergeKey: key });
    store.sealHistory();
    expect((store.get(a.id) as RectNode).fill).toEqual({ type: 'solid', color: rgba(0, 0, 1), colorStyle: 's1' });
    expect((store.get(b.id) as RectNode).stroke?.color).toEqual(rgba(0, 0, 1));
    // 拖取色器的过程是一步撤销
    store.undo();
    expect((store.get(a.id) as RectNode).fill).toEqual({ type: 'solid', color: GREY, colorStyle: 's1' });
    store.redo();

    editor.commands.run('style.color.remove', { id: 's1' });
    expect(colorStyles(store)).toEqual([]);
    expect((store.get(a.id) as RectNode).fill).toEqual({ type: 'solid', color: rgba(0, 0, 1) });
  });

  it('从选中的文字新建文字样式，套给另一段，重新定义后两段都变', () => {
    const { editor, store, board } = setup();
    const a = addText(store, board, 0, 0);
    const b = addText(store, board, 0, 100);
    editor.select([a.id]);
    editor.commands.run('style.text.add', { id: 't1', name: '正文', link: true });
    expect(textStyles(store)[0]!.style.fontSize).toBe(20);
    expect((store.get(a.id) as TextNode).textStyle).toBe('t1');

    editor.select([b.id]);
    editor.commands.run('style.text.apply', { id: 't1' });
    expect((store.get(b.id) as TextNode).textStyle).toBe('t1');

    // 改了 b 的字号就断开了；用它重新定义样式，a 跟着变，b 重新链接上
    store.transact('size', (tx) =>
      tx.update(b.id, { style: { ...(store.get(b.id) as TextNode).style, fontSize: 36 } }),
    );
    expect((store.get(b.id) as TextNode).textStyle).toBeUndefined();
    editor.commands.run('style.text.redefine', { id: 't1' });
    expect((store.get(a.id) as TextNode).style.fontSize).toBe(36);
    expect((store.get(b.id) as TextNode).textStyle).toBe('t1');

    editor.select([a.id]);
    editor.commands.run('style.text.detach');
    expect((store.get(a.id) as TextNode).textStyle).toBeUndefined();
  });

  it('改颜色样式时主组件和实例里链接它的颜色一起变', () => {
    const { editor, store, board } = setup();
    const { main, instance } = makeComponent(editor, store, board);
    editor.select([store.children(main.id)[0]!.id]);
    editor.commands.run('style.color.add', { id: 's', name: '主色', color: RED, link: 'fill' });
    const copy = store.children(instance.id)[0] as RectNode;
    expect(copy.fill).toEqual({ type: 'solid', color: RED, colorStyle: 's' });
    editor.commands.run('style.color.update', { id: 's', color: rgba(0, 1, 0) });
    expect((store.get(copy.id) as RectNode).fill).toEqual({ type: 'solid', color: rgba(0, 1, 0), colorStyle: 's' });
    expect(store.get(copy.id)!.overrides).toBeUndefined();
  });
});

describe('按版式新建幻灯片', () => {
  it('沿用当前页的大小和背景，摆好版式里的对象，是一步撤销', () => {
    const { editor, store, board } = setup();
    store.transact('dark', (tx) => tx.update(board, { fill: solid(rgba(0.1, 0.1, 0.15)) }));
    editor.setActiveArtboard(board);
    editor.commands.run('artboard.add', { layout: 'titleContent', texts: { title: '议程', body: '一\n二' } });
    const created = editor.activeArtboard!;
    expect(created.id).not.toBe(board);
    expect(created.size).toEqual([1280, 720]);
    expect(created.fill).toEqual(solid(rgba(0.1, 0.1, 0.15)));
    const kids = store.children(created.id) as TextNode[];
    expect(kids.map((k) => k.text)).toEqual(['议程', '一\n二']);
    // 深色背景上默认用白字
    expect(kids[0]!.fill?.color).toEqual(rgba(1, 1, 1));
    store.undo();
    expect(store.has(created.id)).toBe(false);
    expect(kids.every((k) => !store.has(k.id))).toBe(true);
  });

  it('文档里有"背景"颜色样式时，新幻灯片的背景链接它', () => {
    const { editor, store } = setup();
    editor.commands.run('style.color.add', { id: 'bg', name: '背景', color: rgba(0.9, 0.95, 1) });
    store.transact('role', (tx) =>
      tx.update(store.root.id, { colorStyles: colorStyles(store).map((s) => ({ ...s, role: 'background' as const })) }),
    );
    editor.commands.run('artboard.add');
    expect(editor.activeArtboard!.fill).toEqual({ type: 'solid', color: rgba(0.9, 0.95, 1), colorStyle: 'bg' });
    expect(store.children(editor.activeArtboard!.id)).toHaveLength(0);
  });
});
