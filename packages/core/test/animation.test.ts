import { describe, expect, it } from 'vitest';
import {
  DocStore,
  createNode,
  getEffect,
  listEffects,
  scheduleAnimations,
  stepDuration,
  validateDocument,
  type Rect,
  type SlideAnimation,
} from '../src';

const SLIDE = { width: 1280, height: 720 };
const BOX: Rect = { x: 200, y: 100, w: 300, h: 150 };
const boxes = new Map<string, Rect>([
  ['a', BOX],
  ['b', { x: 800, y: 400, w: 100, h: 100 }],
]);

let counter = 0;
function anim(target: string, effect: string, patch: Partial<SlideAnimation> = {}): SlideAnimation {
  return { id: `anim${counter++}`, target, effect, start: 'onClick', duration: 500, delay: 0, ...patch };
}

const schedule = (list: SlideAnimation[]) => scheduleAnimations(list, { slide: SLIDE, boxes });

describe('效果库', () => {
  it('每个进入效果都有一个对应的退出效果', () => {
    const entrances = listEffects('entrance').map((e) => e.id.replace('entrance.', ''));
    const exits = listEffects('exit').map((e) => e.id.replace('exit.', ''));
    expect(entrances).toEqual(['appear', 'fade', 'fly', 'float', 'zoom', 'wipe']);
    expect(exits).toEqual(['disappear', 'fade', 'fly', 'float', 'zoom', 'wipe']);
    expect(listEffects('emphasis').length).toBeGreaterThanOrEqual(4);
  });

  it('飞入：起点在幻灯片之外，终点在原位', () => {
    const ctx = { box: BOX, slide: SLIDE };
    const from = (direction: 'left' | 'right' | 'top' | 'bottom') =>
      getEffect('entrance.fly')!.build({ ...ctx, direction }).move![0]!.translate;
    // 从左边来：整个对象要移到 x < 0，所以向左移 x + w = 500
    expect(from('left')).toBe('-500px 0px');
    // 从右边来：对象左边缘要移到 x = 1280，所以向右移 1280 - 200 = 1080
    expect(from('right')).toBe('1080px 0px');
    expect(from('top')).toBe('0px -250px');
    expect(from('bottom')).toBe('0px 620px');
    expect(getEffect('entrance.fly')!.build({ ...ctx, direction: 'left' }).move![1]!.translate).toBe('0px 0px');
  });

  it('退出效果是进入效果倒过来', () => {
    const ctx = { box: BOX, slide: SLIDE, direction: 'right' as const };
    const enter = getEffect('entrance.fly')!.build(ctx).move!;
    const exit = getEffect('exit.fly')!.build(ctx).move!;
    expect(exit).toEqual([...enter].reverse());
    expect(getEffect('exit.fade')!.build(ctx).fx).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  });

  it('擦除用裁剪实现，方向决定从哪边露出来', () => {
    const wipe = getEffect('entrance.wipe')!;
    expect(wipe.build({ box: BOX, slide: SLIDE, direction: 'left' }).fx![0]!.clipPath).toBe('inset(0 100% 0 0)');
    expect(wipe.build({ box: BOX, slide: SLIDE, direction: 'bottom' }).fx![0]!.clipPath).toBe('inset(100% 0 0 0)');
  });
});

describe('时间安排', () => {
  it('没有动画时只有一个空的自动步骤', () => {
    expect(schedule([])).toEqual({ steps: [[]], hiddenAtStart: [] });
  });

  it('每个"单击时"开启新的一步', () => {
    const { steps } = schedule([anim('a', 'entrance.fade'), anim('b', 'entrance.fade'), anim('a', 'emphasis.pulse')]);
    expect(steps.map((s) => s.length)).toEqual([0, 1, 1, 1]);
    expect(steps[1]![0]!.target).toBe('a');
    expect(steps[2]![0]!.target).toBe('b');
  });

  it('"与上一动画同时"和上一条同时开始，"上一动画之后"接在它后面', () => {
    const { steps } = schedule([
      anim('a', 'entrance.fade', { duration: 400 }),
      anim('b', 'entrance.fade', { start: 'withPrevious', duration: 900 }),
      anim('a', 'emphasis.pulse', { start: 'afterPrevious', duration: 300 }),
    ]);
    expect(steps).toHaveLength(2);
    const starts = steps[1]!.map((s) => s.start);
    // 第三条接在第二条（0–900）之后
    expect(starts).toEqual([0, 0, 900]);
    expect(stepDuration(steps[1]!)).toBe(1200);
  });

  it('延迟加在各自的起点上，并影响后面"之后"的动画', () => {
    const { steps } = schedule([
      anim('a', 'entrance.fade', { delay: 200, duration: 300 }),
      anim('b', 'entrance.fade', { start: 'afterPrevious', delay: 100, duration: 300 }),
      anim('a', 'emphasis.spin', { start: 'withPrevious', delay: 50 }),
    ]);
    // a: 200–500；b: 500+100=600；最后一条与 b 同时开始再加 50
    expect(steps[1]!.map((s) => s.start)).toEqual([200, 600, 650]);
  });

  it('开头不是"单击时"的动画属于第 0 步，进入页面后自动播放', () => {
    const { steps } = schedule([
      anim('a', 'entrance.fade', { start: 'afterPrevious' }),
      anim('b', 'entrance.fade', { start: 'withPrevious' }),
      anim('a', 'exit.fade'),
    ]);
    expect(steps.map((s) => s.length)).toEqual([2, 1]);
    expect(steps[0]!.map((s) => s.start)).toEqual([0, 0]);
  });

  it('第一条动画是进入效果的对象，一开始是藏起来的', () => {
    const { hiddenAtStart, steps } = schedule([
      anim('a', 'entrance.fly'),
      anim('b', 'emphasis.pulse'),
      anim('b', 'entrance.fade'),
      anim('a', 'exit.fade'),
    ]);
    // b 的第一条是强调，说明它一开始就在页面上
    expect(hiddenAtStart).toEqual(['a']);
    expect(steps[1]![0]).toMatchObject({ show: true, hide: false });
    expect(steps[4]![0]).toMatchObject({ show: false, hide: true });
  });

  it('"出现"和"消失"是瞬间完成的', () => {
    const { steps } = schedule([anim('a', 'entrance.appear', { duration: 800 }), anim('a', 'exit.disappear')]);
    expect(steps[1]![0]).toMatchObject({ duration: 0, show: true });
    expect(steps[1]![0]!.fx).toBeUndefined();
    expect(steps[2]![0]).toMatchObject({ duration: 0, hide: true });
  });

  it('对象已不存在或效果不认识的动画被忽略，不影响其他动画', () => {
    const { steps } = schedule([
      anim('gone', 'entrance.fade'),
      anim('a', 'entrance.does-not-exist'),
      anim('a', 'entrance.fade'),
    ]);
    expect(steps.map((s) => s.length)).toEqual([0, 1]);
  });

  it('负的时长和延迟按 0 处理', () => {
    const { steps } = schedule([anim('a', 'entrance.fade', { duration: -50, delay: -200 })]);
    expect(steps[1]![0]).toMatchObject({ start: 0, duration: 0 });
  });
});

describe('文档校验', () => {
  function documentWithDeck(deck: unknown) {
    const store = DocStore.create();
    store.transact('board', (tx) =>
      tx.create(
        createNode('artboard', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [100, 100],
          fill: null,
          deck: { order: 'a0', notes: '' },
        }),
      ),
    );
    const data = JSON.parse(JSON.stringify(store.toJSON()));
    const board = Object.values(data.nodes).find((n) => (n as { type: string }).type === 'artboard') as {
      deck: unknown;
    };
    board.deck = deck;
    return data;
  }

  it('接受带切换效果和动画的幻灯片', () => {
    const deck = {
      order: 'a0',
      notes: '',
      transition: { effect: 'smooth', duration: 600 },
      animations: [anim('x', 'entrance.fly', { direction: 'left' })],
    };
    expect(() => validateDocument(documentWithDeck(deck))).not.toThrow();
  });

  it('拒绝结构不对的动画数据', () => {
    const base = { order: 'a0', notes: '' };
    expect(() => validateDocument(documentWithDeck({ ...base, animations: 'lots' }))).toThrow(/badNode/);
    expect(() => validateDocument(documentWithDeck({ ...base, animations: [{ id: 'x' }] }))).toThrow(/badNode/);
    expect(() => validateDocument(documentWithDeck({ ...base, transition: { effect: 3 } }))).toThrow(/badNode/);
    expect(() =>
      validateDocument(
        documentWithDeck({ ...base, animations: [{ ...anim('x', 'entrance.fade'), duration: 'slow' }] }),
      ),
    ).toThrow(/badNode/);
  });
});
