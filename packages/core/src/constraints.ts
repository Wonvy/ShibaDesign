/**
 * 约束：画框、画板改大小时，里面的对象怎么跟着变（做界面时常用：按钮靠右下角、标题栏左右拉伸）。
 * 每个方向一个：靠左（上）、靠右（下）、左右（上下）都靠、居中、按比例。省略等于靠左靠上，也就是以前的行为：
 * 容器改大小，里面的东西不动
 */

export const H_CONSTRAINTS = ['left', 'right', 'leftRight', 'center', 'scale'] as const;
export const V_CONSTRAINTS = ['top', 'bottom', 'topBottom', 'center', 'scale'] as const;
export type HConstraint = (typeof H_CONSTRAINTS)[number];
export type VConstraint = (typeof V_CONSTRAINTS)[number];

export interface Constraints {
  h: HConstraint;
  v: VConstraint;
}

export const DEFAULT_CONSTRAINTS: Constraints = { h: 'left', v: 'top' };

export function isConstraints(value: unknown): value is Constraints {
  if (typeof value !== 'object' || value === null) return false;
  const { h, v } = value as Record<string, unknown>;
  return (H_CONSTRAINTS as readonly unknown[]).includes(h) && (V_CONSTRAINTS as readonly unknown[]).includes(v);
}

/** 两个方向的约束统一成"靠起点、靠终点、两头都靠、居中、按比例" */
function axisMode(mode: HConstraint | VConstraint): 'start' | 'end' | 'both' | 'center' | 'scale' {
  switch (mode) {
    case 'left':
    case 'top':
      return 'start';
    case 'right':
    case 'bottom':
      return 'end';
    case 'leftRight':
    case 'topBottom':
      return 'both';
    default:
      return mode;
  }
}

/**
 * 一个方向上：容器的长度从 oldParent 变成 newParent 时，对象在容器里的起点和长度。
 * 靠起点不动；靠终点保持到终点的距离；两头都靠保持两边的距离（长度跟着变，至少 1）；
 * 居中保持中心到容器中心的距离；按比例起点和长度都乘上比例
 */
export function constrainAxis(
  mode: HConstraint | VConstraint,
  start: number,
  length: number,
  oldParent: number,
  newParent: number,
): { start: number; length: number } {
  const delta = newParent - oldParent;
  switch (axisMode(mode)) {
    case 'start':
      return { start, length };
    case 'end':
      return { start: start + delta, length };
    case 'both':
      return { start, length: Math.max(1, length + delta) };
    case 'center':
      return { start: start + delta / 2, length };
    case 'scale': {
      const k = oldParent > 0 ? newParent / oldParent : 1;
      return { start: start * k, length: length * k };
    }
  }
}
