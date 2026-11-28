import { describe, expect, it } from 'vitest';
import {
  DocStore,
  MOTION_PRESETS,
  createNode,
  getEffect,
  motionPathEnds,
  motionPathLength,
  reverseMotionPath,
  sampleMotionPath,
  scheduleAnimations,
  validateDocument,
  type Anchor,
  type SlideAnimation,
  type Subpath,
} from '../src';

const SLIDE = { width: 1280, height: 720 };
const corner = (x: number, y: number): Anchor => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const line = (x: number, y: number): Subpath => ({ closed: false, anchors: [corner(0, 0), corner(x, y)] });

/** "12.5px -3px" → [12.5, -3] */
function translate(frame: Record<string, string | number>): [number, number] {
  const [x, y] = String(frame.translate).split(' ');
  return [parseFloat(x!), parseFloat(y!)];
}

function animation(patch: Partial<SlideAnimation>): SlideAnimation {
  return { id: 'a', target: 'obj', effect: 'motion.line', start: 'onClick', duration: 1000, delay: 0, ...patch };
}

const boxes = new Map([['obj', { x: 100, y: 100, w: 50, h: 50 }]]);

describe('动作路径的几何', () => {
  it('按弧长等分取点：直线上的点间距相等，首尾是起点和终点', () => {
    const points = sampleMotionPath(line(300, 400), 10);
    expect(points).toHaveLength(11);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[10]!.x).toBeCloseTo(300, 6);
    expect(points[10]!.y).toBeCloseTo(400, 6);
    for (let i = 1; i <= 10; i++) {
      expect(Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)).toBeCloseTo(50, 4);
    }
  });

  it('曲线也按弧长等分：拐弯处不会忽快忽慢', () => {
    const arc = MOTION_PRESETS.arc(SLIDE);
    const points = sampleMotionPath(arc, 40);
    const steps = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    for (const step of steps) expect(Math.abs(step - mean) / mean).toBeLessThan(0.02);
  });

  it('圆形：闭合，绕一圈回到起点，长度接近 2πr', () => {
    const circle = MOTION_PRESETS.circle(SLIDE);
    const r = 720 / 8;
    expect(motionPathEnds(circle).end).toEqual({ x: 0, y: 0 });
    expect(motionPathLength(circle) / (2 * Math.PI * r)).toBeCloseTo(1, 3);
    const points = sampleMotionPath(circle);
    expect(points[points.length - 1]!.x).toBeCloseTo(0, 6);
    expect(points[points.length - 1]!.y).toBeCloseTo(0, 6);
  });

  it('反转：锚点倒序、控制柄对调，起点终点互换', () => {
    const arc = MOTION_PRESETS.arc(SLIDE);
    const reversed = reverseMotionPath(arc);
    expect(motionPathEnds(reversed).start).toEqual(motionPathEnds(arc).end);
    const a = sampleMotionPath(arc, 20);
    const b = sampleMotionPath(reversed, 20).reverse();
    a.forEach((p, i) => {
      expect(p.x).toBeCloseTo(b[i]!.x, 3);
      expect(p.y).toBeCloseTo(b[i]!.y, 3);
    });
  });
});

describe('动作路径的动画', () => {
  it('排成一串 translate 关键帧：offset 从 0 到 1，从原处走到终点，播完停在终点', () => {
    const { steps, hiddenAtStart } = scheduleAnimations([animation({ path: line(320, 0) })], { slide: SLIDE, boxes });
    const [played] = steps[1]!;
    expect(played!.move![0]).toMatchObject({ translate: '0px 0px', offset: 0 });
    expect(played!.move![played!.move!.length - 1]).toMatchObject({ translate: '320px 0px', offset: 1 });
    expect(played!.show).toBe(false);
    expect(played!.hide).toBe(false);
    expect(hiddenAtStart).toEqual([]);
    expect(getEffect('motion.line')!.kind).toBe('motion');
  });

  it('同一个对象的下一条路径从上一条的终点接着走；之后的飞出也从那里出发', () => {
    const list = [
      animation({ id: 'a', path: line(100, 0) }),
      animation({ id: 'b', path: line(0, 50), start: 'afterPrevious' }),
      animation({ id: 'c', effect: 'exit.fly', direction: 'left', start: 'afterPrevious' }),
    ];
    const { steps } = scheduleAnimations(list, { slide: SLIDE, boxes });
    const [first, second, fly] = steps[1]!;
    expect(translate(first!.move![first!.move!.length - 1]!)).toEqual([100, 0]);
    expect(translate(second!.move![0]!)).toEqual([100, 0]);
    expect(translate(second!.move![second!.move!.length - 1]!)).toEqual([100, 50]);
    // 飞出从 (100, 50) 出发；往左飞出幻灯片要走的距离按挪过之后的位置算：对象左边在 200，右边在 250
    expect(translate(fly!.move![0]!)).toEqual([100, 50]);
    expect(translate(fly!.move![1]!)).toEqual([100 - 250, 50]);
  });

  it('没有路径的动作路径动画不动；别的对象不受影响', () => {
    const others = new Map([...boxes, ['other', { x: 0, y: 0, w: 10, h: 10 }]]);
    const { steps } = scheduleAnimations(
      [animation({}), animation({ id: 'b', target: 'other', effect: 'entrance.fly', start: 'withPrevious' })],
      { slide: SLIDE, boxes: others },
    );
    expect(steps[1]![0]!.move).toBeUndefined();
    expect(translate(steps[1]![1]!.move![1]!)).toEqual([0, 0]);
  });
});

describe('文档校验', () => {
  function documentWith(path: unknown) {
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
      deck: Record<string, unknown>;
    };
    board.deck.animations = [{ ...animation({}), path }];
    return data;
  }

  it('接受动作路径，拒绝坏的路径', () => {
    expect(() => validateDocument(documentWith(line(10, 0)))).not.toThrow();
    expect(() => validateDocument(documentWith(undefined))).not.toThrow();
    expect(() => validateDocument(documentWith({ closed: false, anchors: [{ x: 'a' }] }))).toThrow(/badNode/);
    expect(() => validateDocument(documentWith([1, 2]))).toThrow(/badNode/);
  });
});

describe('备注的校验', () => {
  it('备注只能是文字', () => {
    const store = DocStore.create();
    store.transact('board', (tx) =>
      tx.create(
        createNode('artboard', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [100, 100],
          fill: null,
          deck: { order: 'a0', notes: '提示' },
        }),
      ),
    );
    const data = JSON.parse(JSON.stringify(store.toJSON()));
    expect(() => validateDocument(data)).not.toThrow();
    const board = Object.values(data.nodes).find((n) => (n as { type: string }).type === 'artboard') as {
      deck: Record<string, unknown>;
    };
    board.deck.notes = { html: '<b>x</b>' };
    expect(() => validateDocument(data)).toThrow(/badNode/);
  });
});
