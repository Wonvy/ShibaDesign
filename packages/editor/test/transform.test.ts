import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DocStore,
  applyToPoint,
  createNode,
  rgba,
  rotationOf,
  solid,
  translation,
  worldTransform,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import { loadCanvasKit, type CanvasKit } from '@shiba/renderer';
import {
  captureOriginals,
  createEditor,
  flipNodes,
  handleCursor,
  resizeBounds,
  resizeInWorld,
  resizeLocal,
  rotateNodes,
  type Editor,
} from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

function setup(): { editor: Editor; store: DocStore; board: SceneNode } {
  const store = DocStore.create();
  const board = store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        transform: translation(1000, 500),
        size: [1280, 720],
        fill: solid(rgba(1, 1, 1)),
        deck: { order: 'a0', notes: '' },
      }),
    ),
  );
  const editor = createEditor({
    ck,
    store,
    theme: { background: rgba(0, 0, 0), accent: '#00f', label: '#888', handleFill: '#fff' },
    defaultFonts: { latin: 'Inter', cjk: 'Noto Sans SC' },
  });
  return { editor, store, board };
}

function addRect(store: DocStore, parent: NodeId, x: number, y: number, w: number, h: number): SceneNode {
  return store.transact('rect', (tx) =>
    tx.create(
      createNode('rect', {
        parent,
        index: store.indexOnTop(parent),
        seq: 1,
        transform: translation(x, y),
        size: [w, h],
        fill: solid(rgba(0.5, 0.5, 0.5)),
        stroke: null,
        cornerRadius: 0,
      }),
    ),
  );
}

/** 节点本地坐标里的一个点在世界坐标里的位置 */
function worldPoint(store: DocStore, id: NodeId, x: number, y: number): Point {
  const [wx, wy] = applyToPoint(worldTransform(store, id), x, y);
  return { x: wx, y: wy };
}

function expectPoint(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
}

function expectRect(actual: Rect, expected: Rect): void {
  expect(actual.x).toBeCloseTo(expected.x, 4);
  expect(actual.y).toBeCloseTo(expected.y, 4);
  expect(actual.w).toBeCloseTo(expected.w, 4);
  expect(actual.h).toBeCloseTo(expected.h, 4);
}

const bounds = (editor: Editor, id: NodeId): Rect => editor.geometry.worldBounds(editor.store.require(id));

function rotate(editor: Editor, ids: NodeId[], pivot: Point, degrees: number): void {
  const { store } = editor;
  const originals = captureOriginals(store, ids);
  store.transact('rotate', (tx) => rotateNodes(tx, store, originals, ids, pivot, (degrees * Math.PI) / 180));
}

describe('旋转', () => {
  it('绕中心转 90°：宽高对调，中心不动', () => {
    const { editor, store, board } = setup();
    const rect = addRect(store, board.id, 100, 100, 200, 100);
    const before = bounds(editor, rect.id);
    rotate(editor, [rect.id], { x: before.x + 100, y: before.y + 50 }, 90);
    expectRect(bounds(editor, rect.id), { x: before.x + 50, y: before.y - 50, w: 100, h: 200 });
    expect((rotationOf(store.require(rect.id).transform) * 180) / Math.PI).toBeCloseTo(90);
    // 尺寸本身没有变，变的只是方向
    expect(store.require(rect.id).size).toEqual([200, 100]);
  });

  it('多个对象绕同一个点旋转，相对位置保持不变', () => {
    const { editor, store, board } = setup();
    const a = addRect(store, board.id, 0, 0, 100, 100);
    const b = addRect(store, board.id, 200, 0, 100, 100);
    rotate(editor, [a.id, b.id], { x: 1150, y: 550 }, 180);
    // a 原来在左边，转 180° 后到了右边，b 到了左边
    expectRect(bounds(editor, a.id), { x: 1200, y: 500, w: 100, h: 100 });
    expectRect(bounds(editor, b.id), { x: 1000, y: 500, w: 100, h: 100 });
  });

  it('每一帧都从原始状态算，转回 0° 就是原样', () => {
    const { store, board } = setup();
    const rect = addRect(store, board.id, 100, 100, 200, 100);
    const originals = captureOriginals(store, [rect.id]);
    for (const angle of [0.3, 1.1, 2.9, -0.7, 0]) {
      store.transact('r', (tx) => rotateNodes(tx, store, originals, [rect.id], { x: 1200, y: 650 }, angle));
    }
    store.require(rect.id).transform.forEach((v, i) => expect(v).toBeCloseTo(rect.transform[i]!, 9));
  });

  it('画板不能旋转', () => {
    const { editor, store, board } = setup();
    rotate(editor, [board.id], { x: 0, y: 0 }, 45);
    expect(store.require(board.id).transform).toEqual(board.transform);
    editor.select([board.id]);
    expect(editor.selectionFrame()!.rotatable).toBe(false);
    expect(editor.commands.canRun('arrange.rotate', 45)).toBe(false);
  });
});

describe('沿对象自己的方向缩放', () => {
  function rotatedRect() {
    const env = setup();
    const rect = addRect(env.store, env.board.id, 300, 200, 200, 100);
    const b = bounds(env.editor, rect.id);
    rotate(env.editor, [rect.id], { x: b.x + 100, y: b.y + 50 }, 30);
    return { ...env, rect };
  }

  it('拖右下角：左上角在画布上纹丝不动，角度不变', () => {
    const { store, rect } = rotatedRect();
    const fixed = worldPoint(store, rect.id, 0, 0);
    const originals = captureOriginals(store, [rect.id]);
    const box = { x: 0, y: 0, w: 200, h: 100 };
    const next = resizeBounds(box, 'se', { x: 320, y: 170 }, false);
    store.transact('resize', (tx) => resizeLocal(tx, store, originals, rect.id, box, next));
    const node = store.require(rect.id);
    expect(node.size).toEqual([320, 170]);
    expectPoint(worldPoint(store, rect.id, 0, 0), fixed);
    expect((rotationOf(node.transform) * 180) / Math.PI).toBeCloseTo(30);
  });

  it('拖左上角：右下角在画布上纹丝不动', () => {
    const { store, rect } = rotatedRect();
    const fixed = worldPoint(store, rect.id, 200, 100);
    const originals = captureOriginals(store, [rect.id]);
    const box = { x: 0, y: 0, w: 200, h: 100 };
    const next = resizeBounds(box, 'nw', { x: -60, y: 40 }, false);
    store.transact('resize', (tx) => resizeLocal(tx, store, originals, rect.id, box, next));
    const node = store.require(rect.id);
    expect(node.size).toEqual([260, 60]);
    expectPoint(worldPoint(store, rect.id, node.size[0], node.size[1]), fixed);
  });

  it('路径的锚点跟着缩放', () => {
    const { store, board } = setup();
    const path = store.transact('path', (tx) =>
      tx.create(
        createNode('path', {
          parent: board.id,
          index: 'a5',
          seq: 1,
          size: [100, 50],
          subpaths: [
            {
              closed: false,
              anchors: [
                { x: 0, y: 0, inX: 0, inY: 0, outX: 20, outY: 0 },
                { x: 100, y: 50, inX: 80, inY: 50, outX: 100, outY: 50 },
              ],
            },
          ],
          fillRule: 'nonzero',
          fill: null,
          stroke: { color: rgba(0, 0, 0), width: 2 },
        }),
      ),
    );
    const originals = captureOriginals(store, [path.id]);
    const box = { x: 0, y: 0, w: 100, h: 50 };
    store.transact('resize', (tx) => resizeLocal(tx, store, originals, path.id, box, { x: 0, y: 0, w: 200, h: 150 }));
    const node = store.require(path.id);
    if (node.type !== 'path') throw new Error('expected a path');
    expect(node.subpaths[0]!.anchors[1]).toEqual({ x: 200, y: 150, inX: 160, inY: 150, outX: 200, outY: 150 });
    // 描边粗细不跟着变
    expect(node.stroke!.width).toBe(2);
  });

  it('控制柄的鼠标指针跟着选区框一起转', () => {
    expect(handleCursor('e')).toBe('ew-resize');
    expect(handleCursor('se')).toBe('nwse-resize');
    expect(handleCursor('n')).toBe('ns-resize');
    expect(handleCursor('ne')).toBe('nesw-resize');
    // 框转了 90° 之后，原来的"右边"朝下了
    expect(handleCursor('e', Math.PI / 2)).toBe('ns-resize');
    expect(handleCursor('se', Math.PI / 4)).toBe('ns-resize');
  });
});

describe('多选缩放', () => {
  it('没旋转的对象按比例精确落位', () => {
    const { editor, store, board } = setup();
    const a = addRect(store, board.id, 0, 0, 100, 100);
    const b = addRect(store, board.id, 200, 100, 100, 100);
    const ids = [a.id, b.id];
    const from = { x: 1000, y: 500, w: 300, h: 200 };
    const to = { x: 1000, y: 500, w: 600, h: 300 };
    const originals = captureOriginals(store, ids);
    store.transact('resize', (tx) => resizeInWorld(tx, store, originals, ids, from, to));
    expectRect(bounds(editor, a.id), { x: 1000, y: 500, w: 200, h: 150 });
    expectRect(bounds(editor, b.id), { x: 1400, y: 650, w: 200, h: 150 });
  });

  it('转了 90° 的对象：横向拉伸落在它自己的"高"上', () => {
    const { editor, store, board } = setup();
    const rect = addRect(store, board.id, 100, 100, 200, 100);
    const b0 = bounds(editor, rect.id);
    rotate(editor, [rect.id], { x: b0.x + 100, y: b0.y + 50 }, 90);
    const from = bounds(editor, rect.id);
    const originals = captureOriginals(store, [rect.id]);
    store.transact('resize', (tx) => resizeInWorld(tx, store, originals, [rect.id], from, { ...from, w: from.w * 2 }));
    expect(store.require(rect.id).size[0]).toBeCloseTo(200);
    expect(store.require(rect.id).size[1]).toBeCloseTo(200);
    expectRect(bounds(editor, rect.id), { ...from, w: from.w * 2 });
  });
});

describe('翻转', () => {
  it('水平翻转：对象到了轴的另一侧；翻两次回到原样', () => {
    const { editor, store, board } = setup();
    const rect = addRect(store, board.id, 100, 100, 200, 100);
    const pivot = { x: 1400, y: 600 };
    store.transact('flip', (tx) => flipNodes(tx, store, [rect.id], 'horizontal', pivot));
    expectRect(bounds(editor, rect.id), { x: 1500, y: 600, w: 200, h: 100 });
    store.transact('flip', (tx) => flipNodes(tx, store, [rect.id], 'horizontal', pivot));
    store.require(rect.id).transform.forEach((v, i) => expect(v).toBeCloseTo(rect.transform[i]!, 9));
  });

  it('命令以选区中心为轴，所以单个对象翻转后位置不变', () => {
    const { editor, store, board } = setup();
    const rect = addRect(store, board.id, 100, 100, 200, 100);
    const before = bounds(editor, rect.id);
    editor.select([rect.id]);
    editor.commands.run('arrange.flip', 'vertical');
    expectRect(bounds(editor, rect.id), before);
    expect(store.require(rect.id).transform[3]).toBeCloseTo(-1);
    editor.commands.run('edit.undo');
    expect(store.require(rect.id).transform).toEqual(rect.transform);
  });
});

describe('编组', () => {
  function threeRects() {
    const env = setup();
    const a = addRect(env.store, env.board.id, 0, 0, 100, 100);
    const b = addRect(env.store, env.board.id, 200, 50, 100, 100);
    const c = addRect(env.store, env.board.id, 500, 500, 50, 50);
    return { ...env, a, b, c };
  }

  it('编组后对象的位置不变，组的边界是成员的并集，层序保持', () => {
    const { editor, store, board, a, b, c } = threeRects();
    const before = [a, b].map((n) => bounds(editor, n.id));
    editor.select([b.id, a.id]);
    expect(editor.commands.run('group.create')).toBe(true);

    const group = editor.selectedNodes()[0]!;
    expect(group.type).toBe('group');
    expect(group.parent).toBe(board.id);
    expect(store.children(group.id).map((n) => n.id)).toEqual([a.id, b.id]);
    [a, b].forEach((n, i) => expectRect(bounds(editor, n.id), before[i]!));
    expectRect(bounds(editor, group.id), { x: 1000, y: 500, w: 300, h: 150 });
    // 组占据最上面那个成员原来的层位：仍然在 c 的下面
    expect(store.children(board.id).map((n) => n.id)).toEqual([group.id, c.id]);

    editor.commands.run('edit.undo');
    expect(store.has(group.id)).toBe(false);
    expect(store.require(a.id).parent).toBe(board.id);
    expect(store.children(board.id).map((n) => n.id)).toEqual([a.id, b.id, c.id]);
  });

  it('整组旋转后取消编组：成员留在转过之后的位置', () => {
    const { editor, store, board, a, b } = threeRects();
    editor.select([a.id, b.id]);
    editor.commands.run('group.create');
    const group = editor.selectedNodes()[0]!;
    editor.commands.run('arrange.rotate', 90);
    const rotated = [a, b].map((n) => bounds(editor, n.id));
    expect(rotated[0]!.w).toBeCloseTo(100);

    expect(editor.commands.run('group.release')).toBe(true);
    expect(store.has(group.id)).toBe(false);
    expect(editor.selection).toEqual([a.id, b.id]);
    [a, b].forEach((n, i) => {
      expect(store.require(n.id).parent).toBe(board.id);
      expectRect(bounds(editor, n.id), rotated[i]!);
    });
  });

  it('缩放整组：成员的位置和大小一起按比例变化', () => {
    const { editor, store, a, b } = threeRects();
    editor.select([a.id, b.id]);
    editor.commands.run('group.create');
    const group = editor.selectedNodes()[0]!;
    const frame = editor.selectionFrame()!.single!;
    expectRect(frame.box, { x: 0, y: 0, w: 300, h: 150 });

    const originals = captureOriginals(store, [group.id]);
    store.transact('resize', (tx) =>
      resizeLocal(tx, store, originals, group.id, frame.box, { x: 0, y: 0, w: 600, h: 150 }),
    );
    expectRect(bounds(editor, a.id), { x: 1000, y: 500, w: 200, h: 100 });
    expectRect(bounds(editor, b.id), { x: 1400, y: 550, w: 200, h: 100 });
    expectRect(bounds(editor, group.id), { x: 1000, y: 500, w: 600, h: 150 });
  });

  it('从左边拖动整组：右边缘不动', () => {
    const { editor, store, a, b } = threeRects();
    editor.select([a.id, b.id]);
    editor.commands.run('group.create');
    const group = editor.selectedNodes()[0]!;
    const box = editor.selectionFrame()!.single!.box;
    const originals = captureOriginals(store, [group.id]);
    const next = resizeBounds(box, 'w', { x: 150, y: 0 }, false);
    store.transact('resize', (tx) => resizeLocal(tx, store, originals, group.id, box, next));
    const after = bounds(editor, group.id);
    expect(after.x + after.w).toBeCloseTo(1300);
    expect(after.w).toBeCloseTo(150);
  });

  it('默认点中组里的对象选的是整组；进入组之后点成员选的是成员', () => {
    const { editor, a, b } = threeRects();
    editor.select([a.id, b.id]);
    editor.commands.run('group.create');
    const group = editor.selectedNodes()[0]!;
    const onA = { x: 1050, y: 550 };
    const onB = { x: 1250, y: 600 };

    editor.clearSelection();
    expect(editor.pick(onA).node?.id).toBe(group.id);
    // 双击进入：选中鼠标下面的那个成员
    expect(editor.pickInside(onA, group.id)?.id).toBe(a.id);
    editor.select([a.id]);
    expect(editor.pick(onB).node?.id).toBe(b.id);
    // 选到组外面的东西，就算离开了这个组
    editor.clearSelection();
    expect(editor.pick(onB).node?.id).toBe(group.id);
  });

  it('组可以嵌套，画板不能进组', () => {
    const { editor, store, board, a, b, c } = threeRects();
    editor.select([a.id, b.id]);
    editor.commands.run('group.create');
    const inner = editor.selectedNodes()[0]!;
    editor.select([inner.id, c.id]);
    editor.commands.run('group.create');
    const outer = editor.selectedNodes()[0]!;
    expect(store.require(inner.id).parent).toBe(outer.id);
    expect(store.children(outer.id).map((n) => n.id)).toEqual([inner.id, c.id]);

    editor.select([board.id]);
    expect(editor.commands.canRun('group.create')).toBe(false);
  });
});
