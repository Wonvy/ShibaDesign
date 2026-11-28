import { beforeAll, describe, expect, it } from 'vitest';
import {
  createNode,
  rgba,
  solid,
  translation,
  type Constraints,
  type NodeId,
  type RectNode,
  type SceneNode,
} from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { captureOriginals, resizeLocal, type ContentMode } from '../src';
import { canvasKit, scene, type Scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

/** 画板里 (100,100) 起一个 400 × 300 的画框，里面一个 (20,20) 起 100 × 50 的矩形，矩形带着给定的约束 */
function setup(constraints?: Constraints) {
  const s = scene(ck, []);
  const ids = s.store.transact('setup', (tx) => {
    const frame = tx.create(
      createNode('frame', {
        parent: s.board,
        index: 'a0',
        seq: 1,
        transform: translation(100, 100),
        size: [400, 300],
        fill: solid(rgba(1, 1, 1)),
        stroke: null,
        cornerRadius: 0,
        clip: true,
      }),
    );
    const rect = tx.create(
      createNode('rect', {
        parent: frame.id,
        index: 'a0',
        seq: 1,
        transform: translation(20, 20),
        size: [100, 50],
        cornerRadius: 0,
        fill: solid(rgba(1, 0, 0)),
        stroke: null,
        ...(constraints ? { constraints } : {}),
      }),
    );
    return { frame: frame.id, rect: rect.id };
  });
  s.store.sealHistory();
  return { ...s, ...ids };
}

/** 把画框（或别的节点）从现在的大小改成 w × h，左上角不动 */
function resize(s: Scene, id: NodeId, w: number, h: number, mode?: ContentMode) {
  const originals = captureOriginals(s.store, [id]);
  const node = s.store.get(id)!;
  const box = { x: 0, y: 0, w: node.size[0], h: node.size[1] };
  s.store.transact('resize', (tx) => resizeLocal(tx, s.store, originals, id, box, { x: 0, y: 0, w, h }, mode));
  s.store.sealHistory();
}

const rectOf = (s: Scene, id: NodeId) => {
  const node = s.store.get(id) as SceneNode;
  return { x: node.transform[4], y: node.transform[5], w: node.size[0], h: node.size[1] };
};

describe('约束', () => {
  it('默认靠左靠上：画框改大小时里面的东西不动', () => {
    const s = setup();
    resize(s, s.frame, 600, 400);
    expect(s.store.get(s.frame)?.size).toEqual([600, 400]);
    expect(rectOf(s, s.rect)).toEqual({ x: 20, y: 20, w: 100, h: 50 });
  });

  it('靠右靠下：保持到右边、下边的距离', () => {
    const s = setup({ h: 'right', v: 'bottom' });
    resize(s, s.frame, 600, 400);
    expect(rectOf(s, s.rect)).toEqual({ x: 220, y: 120, w: 100, h: 50 });
  });

  it('左右、上下都靠：大小跟着变，两边的距离不变', () => {
    const s = setup({ h: 'leftRight', v: 'topBottom' });
    resize(s, s.frame, 600, 400);
    expect(rectOf(s, s.rect)).toEqual({ x: 20, y: 20, w: 300, h: 150 });
  });

  it('居中和按比例', () => {
    const s = setup({ h: 'center', v: 'scale' });
    resize(s, s.frame, 600, 600);
    const r = rectOf(s, s.rect);
    expect(r.x).toBeCloseTo(120, 9);
    expect(r.w).toBeCloseTo(100, 9);
    expect(r.y).toBeCloseTo(40, 9);
    expect(r.h).toBeCloseTo(100, 9);
  });

  it('按住 ⌘（fixed）时里面的东西不动；等比缩放（scale）时整体按比例', () => {
    const s = setup({ h: 'right', v: 'bottom' });
    resize(s, s.frame, 600, 400, 'fixed');
    expect(rectOf(s, s.rect)).toEqual({ x: 20, y: 20, w: 100, h: 50 });
    resize(s, s.frame, 300, 200, 'scale');
    const r = rectOf(s, s.rect);
    expect(r.x).toBeCloseTo(10, 9);
    expect(r.w).toBeCloseTo(50, 9);
  });

  it('嵌套：里层画框左右都靠时，它里面靠右的东西也跟着走', () => {
    const s = setup({ h: 'leftRight', v: 'top' });
    // 把矩形换成一个画框，里面再放一个靠右的小矩形
    const inner = s.store.transact('inner', (tx) => {
      tx.remove(s.rect);
      const frame = tx.create(
        createNode('frame', {
          parent: s.frame,
          index: 'a1',
          seq: 2,
          transform: translation(20, 20),
          size: [360, 60],
          fill: null,
          stroke: null,
          cornerRadius: 0,
          clip: true,
          constraints: { h: 'leftRight', v: 'top' },
        }),
      );
      const dot = tx.create(
        createNode('rect', {
          parent: frame.id,
          index: 'a0',
          seq: 2,
          transform: translation(320, 10),
          size: [30, 30],
          cornerRadius: 0,
          fill: null,
          stroke: null,
          constraints: { h: 'right', v: 'top' },
        }),
      );
      return { frame: frame.id, dot: dot.id };
    });
    resize(s, s.frame, 600, 300);
    expect(s.store.get(inner.frame)?.size).toEqual([560, 60]);
    expect(rectOf(s, inner.dot).x).toBe(520);
  });

  it('画板也一样：改画板大小时靠右下角的东西跟着走', () => {
    const s = scene(ck, [[900, 500, 50, 50]]);
    s.store.transact('c', (tx) => tx.update(s.rects[0]!, { constraints: { h: 'right', v: 'bottom' } }));
    resize(s, s.board, 1200, 800);
    expect(rectOf(s, s.rects[0]!)).toMatchObject({ x: 1100, y: 700 });
    // 没设约束的画板内容照旧不动（以前的行为）
    const t = scene(ck, [[900, 500, 50, 50]]);
    resize(t, t.board, 1200, 800);
    expect(rectOf(t, t.rects[0]!)).toMatchObject({ x: 900, y: 500 });
  });

  it('编组按约束拉伸时组里的东西一起缩放；一步撤销', () => {
    const s = setup({ h: 'leftRight', v: 'top' });
    s.editor.select([s.rect]);
    s.editor.commands.run('group.create');
    const group = s.editor.selection[0]!;
    s.store.transact('c', (tx) => tx.update(group, { constraints: { h: 'leftRight', v: 'top' } }));
    s.store.sealHistory();
    resize(s, s.frame, 600, 300);
    expect((s.store.get(s.rect) as RectNode).size).toEqual([300, 50]);
    s.store.undo();
    expect((s.store.get(s.rect) as RectNode).size).toEqual([100, 50]);
  });
});
