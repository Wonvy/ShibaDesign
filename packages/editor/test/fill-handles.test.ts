import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DocStore,
  createNode,
  rgba,
  solid,
  translation,
  type GradientFill,
  type ImageFill,
  type SceneNode,
} from '@shiba/core';
import { loadCanvasKit, type CanvasKit } from '@shiba/renderer';
import {
  createEditor,
  dragGradientPoint,
  gradientHandlePoints,
  imageRect,
  panImage,
  reparentByPosition,
  zoomImage,
} from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

const box = { x: 0, y: 0, w: 200, h: 100 };
const stops = [
  { offset: 0, color: rgba(1, 0, 0) },
  { offset: 1, color: rgba(0, 0, 1) },
];
const linear: GradientFill = {
  type: 'gradient',
  kind: 'linear',
  start: { x: 0, y: 0.5 },
  end: { x: 1, y: 0.5 },
  stops,
};
const radial: GradientFill = {
  type: 'gradient',
  kind: 'radial',
  start: { x: 0.5, y: 0.5 },
  end: { x: 1, y: 0.5 },
  stops,
};

describe('在画布上拖渐变', () => {
  it('手柄的位置：起点、终点，径向渐变还有压扁比例的手柄（转 90°，距离是半径 × 比例）', () => {
    expect(gradientHandlePoints(linear, box)).toEqual({ start: { x: 0, y: 50 }, end: { x: 200, y: 50 }, aspect: null });
    expect(gradientHandlePoints({ ...radial, aspect: 0.5 }, box)).toEqual({
      start: { x: 100, y: 50 },
      end: { x: 200, y: 50 },
      aspect: { x: 100, y: 100 },
    });
  });

  it('拖线性渐变的终点；按住 Shift 方向吸附到 45°，长度不变', () => {
    expect(dragGradientPoint(linear, box, 'end', { x: 150, y: 100 }, false)).toMatchObject({
      start: { x: 0, y: 0.5 },
      end: { x: 0.75, y: 1 },
    });
    const snapped = dragGradientPoint(linear, box, 'end', { x: 100, y: 60 }, true);
    // 从 (0,50) 往 (100,60) 的方向离 0° 最近，吸附成水平
    expect(snapped.end.y).toBeCloseTo(0.5, 3);
    expect(snapped.end.x).toBeCloseTo(Math.hypot(100, 10) / 200, 3);
  });

  it('拖径向渐变的圆心整个渐变一起挪；第三个手柄改压扁比例', () => {
    const moved = dragGradientPoint(radial, box, 'start', { x: 120, y: 40 }, false);
    expect(moved.start).toEqual({ x: 0.6, y: 0.4 });
    expect(moved.end).toEqual({ x: 1.1, y: 0.4 });
    expect(dragGradientPoint(radial, box, 'aspect', { x: 100, y: 75 }, false).aspect).toBeCloseTo(0.25, 4);
    // 拖回正圆时去掉这个字段
    expect(dragGradientPoint(radial, box, 'aspect', { x: 100, y: 150 }, false).aspect).toBeUndefined();
  });
});

describe('在画布上调整图片', () => {
  const image = { width: 400, height: 400 };
  const fill: ImageFill = { type: 'image', assetId: 'a', fit: 'cover' };

  it('图片整张的范围：铺满时宽对齐框，上下各伸出去一截', () => {
    expect(imageRect(fill, box, image)).toEqual({ x: 0, y: -50, w: 200, h: 200 });
  });

  it('拖动换算成 pan，到头为止；和框一样大的方向不能挪', () => {
    // 上下的余量是 100，往下拖 25 就是 pan 0.5
    expect(panImage(fill, box, image, 30, 25)).toEqual({ ...fill, panY: 0.5 });
    expect(panImage(fill, box, image, 0, 500)).toEqual({ ...fill, panY: 1 });
  });

  it('缩放时图片中心尽量不动，最多放大 4 倍', () => {
    const shifted = { ...fill, panY: 0.5 };
    const before = imageRect(shifted, box, image);
    const zoomed = zoomImage(shifted, box, image, 2);
    expect(zoomed.zoom).toBe(2);
    const after = imageRect(zoomed, box, image);
    // pan 存的是四位小数，差不到 0.01 个单位
    expect(after.y + after.h / 2).toBeCloseTo(before.y + before.h / 2, 1);
    expect(after.x + after.w / 2).toBeCloseTo(100, 6);
    expect(zoomImage(fill, box, image, 10).zoom).toBe(4);
    // 缩回 1 倍时去掉这个字段
    expect(zoomImage({ ...fill, zoom: 2 }, box, image, 0.1).zoom).toBeUndefined();
  });
});

describe('编辑器', () => {
  function setup() {
    const store = DocStore.create();
    const editor = createEditor({
      ck,
      store,
      theme: { background: rgba(0, 0, 0), accent: '#00f', label: '#888', handleFill: '#fff' },
      defaultFonts: { latin: 'Inter', cjk: 'Noto Sans SC' },
    });
    const board = store.transact('board', (tx) =>
      tx.create(
        createNode('artboard', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [400, 300],
          fill: solid(rgba(1, 1, 1)),
          deck: null,
        }),
      ),
    );
    const add = (parent: string, x: number, fill: GradientFill | ReturnType<typeof solid>): SceneNode =>
      store.transact('rect', (tx) =>
        tx.create(
          createNode('rect', {
            parent,
            index: store.indexOnTop(parent),
            seq: 1,
            transform: translation(x, 20),
            size: [100, 60],
            fill,
            stroke: null,
            cornerRadius: 0,
          }),
        ),
      );
    return { store, editor, board, add };
  }

  it('进入、退出在画布上调整填充：换选区、换工具、换掉填充都会退出', () => {
    const { editor, store, board, add } = setup();
    const a = add(board.id, 20, linear);
    const b = add(board.id, 200, solid(rgba(0, 1, 0)));
    editor.setFillEditing({ id: a.id, kind: 'gradient' });
    expect(editor.selection).toEqual([a.id]);
    expect(editor.fillEditing).toEqual({ id: a.id, kind: 'gradient' });
    editor.select([b.id]);
    expect(editor.fillEditing).toBeNull();

    editor.setFillEditing({ id: a.id, kind: 'gradient' });
    editor.setTool('rect');
    expect(editor.fillEditing).toBeNull();

    editor.setTool('select');
    editor.setFillEditing({ id: a.id, kind: 'gradient' });
    store.transact('fill', (tx) => tx.update(a.id, { fill: solid(rgba(0, 0, 0)) }));
    expect(editor.fillEditing).toBeNull();
    // 没有这种填充的节点不进入
    editor.setFillEditing({ id: b.id, kind: 'gradient' });
    expect(editor.fillEditing).toBeNull();
  });

  it('拖动结束后按位置换归属：只管直接放在画板、页面上的对象，组里（包括蒙版组里）的成员留在组里', () => {
    const { editor, store, board, add } = setup();
    const group = store.transact('group', (tx) =>
      tx.create(createNode('group', { parent: board.id, index: store.indexOnTop(board.id), seq: 1, mask: 'shape' })),
    );
    const inner = add(group.id, 20, solid(rgba(1, 0, 0)));
    const loose = add(board.id, 20, solid(rgba(0, 0, 1)));
    // 两个都拖到画板外面
    store.transact('move', (tx) => {
      tx.update(inner.id, { transform: translation(900, 20) });
      tx.update(loose.id, { transform: translation(900, 20) });
    });
    store.transact('reparent', (tx) => reparentByPosition(editor, tx, [inner.id, loose.id]));
    expect(store.require(inner.id).parent).toBe(group.id);
    expect(store.require(loose.id).parent).toBe(store.root.id);
  });
});
