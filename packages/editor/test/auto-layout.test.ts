import { beforeAll, describe, expect, it } from 'vitest';
import {
  createNode,
  rgba,
  solid,
  translation,
  type AutoLayout,
  type FrameNode,
  type GroupNode,
  type NodeId,
  type SceneNode,
} from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { canvasKit, pointer, scene, type Scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

const pos = (s: Scene, id: NodeId) => {
  const n = s.store.get(id) as SceneNode;
  return [n.transform[4], n.transform[5]];
};
const frameOf = (s: Scene, id: NodeId) => s.store.get(id) as FrameNode;

/** 三个高低不一的矩形横着排，⇧A 包成自动布局画框 */
function wrapped() {
  const s = scene(ck, [
    [300, 100, 40, 40],
    [100, 100, 60, 30],
    [200, 110, 50, 20],
  ]);
  s.editor.select([...s.rects]);
  s.editor.commands.run('frame.autoLayout');
  return { ...s, frame: s.editor.selection[0]! };
}

function setLayout(s: Scene, frame: NodeId, patch: Partial<AutoLayout>) {
  const f = frameOf(s, frame);
  s.store.transact('layout', (tx) => tx.update(frame, { layout: { ...f.layout!, ...patch } }));
  s.store.sealHistory();
}

describe('加自动布局', () => {
  it('⇧A 把选中的对象包进画框：按位置排先后，间距取平均空隙，画框包住内容；一步撤销', () => {
    const s = wrapped();
    const frame = frameOf(s, s.frame);
    expect(frame.layout).toMatchObject({ direction: 'horizontal', gap: 45, padding: [0, 0, 0, 0] });
    expect(frame.layout!.sizing).toEqual({ h: 'hug', v: 'hug' });
    // 层序按从左到右：第二个（x=100）、第三个（x=200）、第一个（x=300）
    expect(s.store.children(s.frame).map((n) => n.id)).toEqual([s.rects[1], s.rects[2], s.rects[0]]);
    // 排好以后：靠上对齐，一个接一个，间距 45（原来的两个空隙 40 和 50 的平均）
    expect(pos(s, s.rects[1]!)).toEqual([0, 0]);
    expect(pos(s, s.rects[2]!)).toEqual([105, 0]);
    expect(pos(s, s.rects[0]!)).toEqual([200, 0]);
    expect(frame.size).toEqual([240, 40]);
    s.store.undo();
    expect(s.store.get(s.frame)).toBeUndefined();
    expect(pos(s, s.rects[0]!)).toEqual([300, 100]);
  });

  it('改间距、方向、对齐时里面的东西重新排；去掉自动布局后东西留在原处', () => {
    const s = wrapped();
    setLayout(s, s.frame, { gap: 10, align: 'end' });
    expect(pos(s, s.rects[2]!)).toEqual([70, 20]);
    expect(frameOf(s, s.frame).size).toEqual([170, 40]);
    setLayout(s, s.frame, { direction: 'vertical', align: 'start' });
    expect(pos(s, s.rects[2]!)).toEqual([0, 40]);
    expect(frameOf(s, s.frame).size).toEqual([60, 110]);
    s.editor.select([s.frame]);
    s.editor.commands.run('frame.removeAutoLayout');
    expect(frameOf(s, s.frame).layout).toBeUndefined();
    expect(pos(s, s.rects[2]!)).toEqual([0, 40]);
  });

  it('子对象变大，后面的往后挪，包住内容的画框跟着变大', () => {
    const s = wrapped();
    s.store.transact('grow', (tx) => tx.update(s.rects[1]!, { size: [100, 30] }));
    expect(pos(s, s.rects[2]!)).toEqual([145, 0]);
    expect(frameOf(s, s.frame).size[0]).toBe(280);
  });

  it('填满：占满固定大小的画框剩下的空间；用户自己拖它的大小就变回固定', () => {
    const s = wrapped();
    const f = frameOf(s, s.frame);
    s.store.transact('fixed', (tx) => {
      tx.update(s.frame, { size: [400, 60], layout: { ...f.layout!, sizing: { h: 'fixed', v: 'fixed' } } });
      tx.update(s.rects[2]!, { layoutSizing: { h: 'fill', v: 'fill' } });
    });
    // 可用 400 - 60 - 40 - 两个间距 90 = 210
    expect((s.store.get(s.rects[2]!) as SceneNode).size).toEqual([210, 60]);
    expect(pos(s, s.rects[0]!)).toEqual([360, 0]);
    s.store.transact('user resize', (tx) => tx.update(s.rects[2]!, { size: [100, 60] }));
    expect(s.store.get(s.rects[2]!)?.layoutSizing).toEqual({ h: 'fixed', v: 'fill' });
    expect((s.store.get(s.rects[2]!) as SceneNode).size[0]).toBe(100);
  });

  it('用户拖包住内容的画框，它就变成固定大小', () => {
    const s = wrapped();
    s.store.transact('user resize', (tx) => tx.update(s.frame, { size: [500, 40] }));
    expect(frameOf(s, s.frame).layout!.sizing).toEqual({ h: 'fixed', v: 'hug' });
    expect(frameOf(s, s.frame).size).toEqual([500, 40]);
  });

  it('不参与自动布局的子对象不动，也不占位置', () => {
    const s = wrapped();
    s.store.transact('ignore', (tx) => tx.update(s.rects[2]!, { layoutIgnore: true, transform: translation(5, 80) }));
    expect(pos(s, s.rects[2]!)).toEqual([5, 80]);
    expect(pos(s, s.rects[0]!)).toEqual([105, 0]);
  });

  it('嵌套：里层包住内容的画框变大，外层跟着重新排', () => {
    const s = wrapped();
    const outer = s.store.transact('outer', (tx) => {
      const node = tx.create(
        createNode('frame', {
          parent: s.board,
          index: 'z0',
          seq: 9,
          transform: translation(0, 300),
          size: [10, 10],
          fill: null,
          stroke: null,
          cornerRadius: 0,
          clip: false,
          layout: {
            direction: 'vertical',
            gap: 5,
            padding: [10, 10, 10, 10],
            justify: 'start',
            align: 'start',
            sizing: { h: 'hug', v: 'hug' },
          },
        }),
      );
      tx.update(s.frame, { parent: node.id, index: 'a0' });
      return node.id;
    });
    expect(frameOf(s, outer).size).toEqual([260, 60]);
    s.store.transact('grow', (tx) => tx.update(s.rects[0]!, { size: [40, 100] }));
    expect(frameOf(s, s.frame).size).toEqual([240, 100]);
    expect(frameOf(s, outer).size).toEqual([260, 120]);
  });
});

describe('在自动布局里拖动', () => {
  it('拖子对象越过旁边的：调整顺序；拖动中画框暂停排列，松手后排回去；一步撤销', () => {
    const s = wrapped();
    const select = s.editor.tools.get('select')!;
    s.editor.select([s.rects[1]!]);
    // 第一个（0..60）的中心是世界坐标 (130, 115)，往右拖过第二个的中心（230）
    select.onPointerDown!(pointer({ x: 130, y: 115 }), s.editor);
    select.onPointerMove!(pointer({ x: 180, y: 115 }), s.editor);
    select.onPointerMove!(pointer({ x: 240, y: 115 }, { mod: true }), s.editor);
    expect(s.editor.layoutPaused.has(s.frame)).toBe(true);
    expect(pos(s, s.rects[1]!)).toEqual([110, 0]);
    select.onPointerUp!(pointer({ x: 240, y: 115 }, { mod: true, down: false }), s.editor);
    expect(s.editor.layoutPaused.size).toBe(0);
    expect(s.store.children(s.frame).map((n) => n.id)).toEqual([s.rects[2], s.rects[1], s.rects[0]]);
    expect(pos(s, s.rects[2]!)).toEqual([0, 0]);
    expect(pos(s, s.rects[1]!)).toEqual([95, 0]);
    s.store.undo();
    expect(s.store.children(s.frame).map((n) => n.id)).toEqual([s.rects[1], s.rects[2], s.rects[0]]);
    expect(pos(s, s.rects[1]!)).toEqual([0, 0]);
  });

  it('从外面拖进来：按位置插进两个之间；拖出去：空位收起来', () => {
    const s = wrapped();
    const extra = s.store.transact('extra', (tx) =>
      tx.create(
        createNode('rect', {
          parent: s.board,
          index: 'z9',
          seq: 9,
          transform: translation(100, 400),
          size: [20, 20],
          cornerRadius: 0,
          fill: solid(rgba(0, 1, 0)),
          stroke: null,
        }),
      ),
    ).id;
    s.store.sealHistory();
    const select = s.editor.tools.get('select')!;
    s.editor.select([extra]);
    // 拖到第一个和第二个之间（画框在 100,100；第一个 0..60，第二个 105..155）
    select.onPointerDown!(pointer({ x: 110, y: 410 }), s.editor);
    select.onPointerMove!(pointer({ x: 150, y: 300 }), s.editor);
    select.onPointerMove!(pointer({ x: 190, y: 115 }, { mod: true }), s.editor);
    select.onPointerUp!(pointer({ x: 190, y: 115 }, { mod: true, down: false }), s.editor);
    expect(s.store.get(extra)?.parent).toBe(s.frame);
    expect(s.store.children(s.frame).map((n) => n.id)).toEqual([s.rects[1], extra, s.rects[2], s.rects[0]]);
    expect(pos(s, extra)).toEqual([105, 0]);
    expect(pos(s, s.rects[2]!)).toEqual([170, 0]);

    // 再拖出去
    select.onPointerDown!(pointer({ x: 210, y: 110 }), s.editor);
    select.onPointerMove!(pointer({ x: 210, y: 300 }), s.editor);
    select.onPointerMove!(pointer({ x: 210, y: 450 }, { mod: true }), s.editor);
    select.onPointerUp!(pointer({ x: 210, y: 450 }, { mod: true, down: false }), s.editor);
    expect(s.store.get(extra)?.parent).toBe(s.board);
    expect(pos(s, s.rects[2]!)).toEqual([105, 0]);
  });
});

describe('组件里的自动布局', () => {
  it('实例里的东西被改大，实例自己重新排，排出来的位置不记成覆盖；主组件改间距，实例照着改', () => {
    const s = wrapped();
    s.editor.select([s.frame]);
    s.editor.commands.run('component.create');
    const main = s.store.get(s.editor.selection[0]!) as GroupNode;
    s.editor.commands.run('component.place', { componentId: main.id, at: { x: 600, y: 400 } });
    const instance = s.editor.selection[0]!;
    const copyFrame = s.store.children(instance)[0]!;
    const [first, second] = s.store.children(copyFrame.id);
    s.store.transact('override', (tx) => tx.update(first!.id, { size: [100, 30] }));
    s.store.sealHistory();
    expect(s.store.get(first!.id)?.overrides).toContain('size');
    expect(pos(s, second!.id)).toEqual([145, 0]);
    expect(s.store.get(second!.id)?.overrides ?? []).not.toContain('transform');
    // 主组件改间距：实例的画框照着改，按自己被改大的那个重新排
    setLayout(s, s.frame, { gap: 10 });
    expect(frameOf(s, copyFrame.id).layout!.gap).toBe(10);
    expect(pos(s, second!.id)).toEqual([110, 0]);
    expect(pos(s, s.rects[2]!)).toEqual([70, 0]);
  });
});
