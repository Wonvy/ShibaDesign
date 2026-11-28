import { TRANSITION_EFFECTS, type SlideTransition } from './animation';
import type { NodeId } from './model';

/**
 * 原型的交互：点一个对象跳到另一页（另一个屏幕），或者回到上一个看过的页，可以指定过渡效果。
 * 演示模式和导出的网页里点着玩；编辑时不起作用。目标页必须是一页幻灯片（播放器只播幻灯片）
 */

export type InteractionAction = { type: 'navigate'; target: NodeId } | { type: 'back' };

export interface Interaction {
  trigger: 'click';
  action: InteractionAction;
  /** 过渡效果；省略时用目标页自己的切换效果 */
  transition?: SlideTransition;
}

export const MAX_INTERACTIONS = 8;

export function isInteractionList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_INTERACTIONS) return false;
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const i = item as Record<string, unknown>;
    if (i.trigger !== 'click') return false;
    const action = i.action as Record<string, unknown> | undefined;
    if (typeof action !== 'object' || action === null) return false;
    if (action.type === 'navigate' ? typeof action.target !== 'string' : action.type !== 'back') return false;
    if (i.transition === undefined) return true;
    const t = i.transition as Record<string, unknown>;
    return (
      typeof t === 'object' &&
      t !== null &&
      (TRANSITION_EFFECTS as readonly unknown[]).includes(t.effect) &&
      typeof t.duration === 'number' &&
      Number.isFinite(t.duration) &&
      t.duration >= 0 &&
      (t.direction === undefined || ['left', 'right', 'top', 'bottom'].includes(t.direction as string))
    );
  });
}

/** 一个对象点击时做什么（第一条点击交互）；没有时返回 null */
export function clickInteraction(node: { interactions?: readonly Interaction[] }): Interaction | null {
  return node.interactions?.find((i) => i.trigger === 'click') ?? null;
}
