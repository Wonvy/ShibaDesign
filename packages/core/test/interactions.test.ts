import { describe, expect, it } from 'vitest';
import { clickInteraction, isInteractionList } from '../src';

describe('原型的交互', () => {
  it('点击跳到某一页或者返回；过渡效果可选', () => {
    expect(
      isInteractionList([
        { trigger: 'click', action: { type: 'navigate', target: 'abc' } },
        {
          trigger: 'click',
          action: { type: 'back' },
          transition: { effect: 'push', duration: 300, direction: 'left' },
        },
      ]),
    ).toBe(true);
    expect(isInteractionList([{ trigger: 'hover', action: { type: 'back' } }])).toBe(false);
    expect(isInteractionList([{ trigger: 'click', action: { type: 'navigate' } }])).toBe(false);
    expect(
      isInteractionList([{ trigger: 'click', action: { type: 'back' }, transition: { effect: 'spin', duration: 1 } }]),
    ).toBe(false);
    expect(
      isInteractionList([{ trigger: 'click', action: { type: 'back' }, transition: { effect: 'fade', duration: -1 } }]),
    ).toBe(false);
  });

  it('取第一条点击交互', () => {
    const back = { trigger: 'click' as const, action: { type: 'back' as const } };
    expect(clickInteraction({ interactions: [back] })).toBe(back);
    expect(clickInteraction({})).toBeNull();
  });
});
