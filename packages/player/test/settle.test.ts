import { describe, expect, it } from 'vitest';
import { settlePlayer } from '../src/settle';
import type { PlayerHandle, PlayerState } from '../src/types';

/**
 * 按播放器的规则模拟翻页：进一页先自动播第 0 步；前进时有动画在播就先播完，否则播下一步，这一页播完了翻到下一页。
 * 每一步都有动画（播的时候 busy），这样最能看出 settlePlayer 有没有把每一步播完
 */
function fakePlayer(steps: number[]): PlayerHandle & { calls: string[] } {
  let state: PlayerState = { slide: 0, slides: steps.length, step: 0, steps: steps[0]!, busy: true };
  const calls: string[] = [];
  const show = (slide: number): void => {
    state = { ...state, slide, step: 0, steps: steps[slide]!, busy: true };
  };
  return {
    calls,
    next() {
      calls.push('next');
      if (state.busy) state = { ...state, busy: false };
      else if (state.step + 1 < state.steps) state = { ...state, step: state.step + 1, busy: true };
      else if (state.slide + 1 < state.slides) show(state.slide + 1);
    },
    previous() {},
    goTo(slide) {
      calls.push(`goTo ${slide}`);
      show(slide);
    },
    state: () => state,
    advance() {},
    destroy() {},
  };
}

describe('演讲者视图的镜像播放器', () => {
  it('跳到指定的页，一步步播到指定的步骤，每一步都播完', () => {
    const player = fakePlayer([1, 4, 2]);
    settlePlayer(player, 1, 2);
    expect(player.state()).toMatchObject({ slide: 1, step: 2, busy: false });
  });

  it('已经在这一步上、播完了：什么都不做', () => {
    const player = fakePlayer([3]);
    settlePlayer(player, 0, 1);
    player.calls.length = 0;
    settlePlayer(player, 0, 1);
    expect(player.calls).toEqual([]);
  });

  it('观众那边往前播了一步：接着往前，不重新进这一页', () => {
    const player = fakePlayer([3]);
    settlePlayer(player, 0, 1);
    player.calls.length = 0;
    settlePlayer(player, 0, 2);
    expect(player.calls).not.toContain('goTo 0');
    expect(player.state()).toMatchObject({ step: 2, busy: false });
  });

  it('观众那边退回了这一页开头：重新进这一页', () => {
    const player = fakePlayer([3, 1]);
    settlePlayer(player, 0, 2);
    settlePlayer(player, 0, 0);
    expect(player.state()).toMatchObject({ slide: 0, step: 0, busy: false });
  });

  it('要的步骤超过了这一页的步数：停在最后一步，不翻到下一页', () => {
    const player = fakePlayer([2, 3]);
    settlePlayer(player, 0, 9);
    expect(player.state()).toMatchObject({ slide: 0, step: 1, busy: false });
  });
});
