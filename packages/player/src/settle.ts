import type { PlayerHandle } from './types';

/**
 * 让一个播放器停在某一页的某一步上，这一步的动画直接播完。演讲者视图里"当前页"的镜像用它跟着观众看到的那个播放器：
 * 只要每一步播完的样子，不用跟着播动画。
 * 不在这一页、或者已经播过了头（观众那边退回了这一页开头），先跳到这一页开头，再一步步往前播，每一步都直接播完。
 * 不会翻到别的页去
 */
export function settlePlayer(handle: PlayerHandle, slide: number, step: number): void {
  const now = handle.state();
  if (now.slide !== slide || now.step > step) handle.goTo(slide);
  // 每一步最多要两下：一下开始，一下播完。上限只是防止意外的死循环
  for (let guard = 0; guard < 2000; guard++) {
    const state = handle.state();
    if (state.slide !== slide) return;
    const reached = state.step >= step || state.step + 1 >= state.steps;
    if (reached && !state.busy) return;
    handle.next();
  }
}
