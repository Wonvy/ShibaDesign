import type { Color, SceneNode } from './model';

/**
 * 效果：投影、内阴影、图层模糊、背景模糊，一个对象可以叠好几个。
 *
 * 模糊的大小和设计软件、CSS 的写法一致：阴影的 blur 是 CSS box-shadow 的模糊半径，换成高斯模糊的标准差是 blur / 2；
 * 图层模糊、背景模糊的 radius 同理。扩展（spread）把形状先往外扩（负数往里缩）再投影。
 */

export const EFFECT_TYPES = ['dropShadow', 'innerShadow', 'layerBlur', 'backgroundBlur'] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

export interface ShadowEffect {
  type: 'dropShadow' | 'innerShadow';
  color: Color;
  x: number;
  y: number;
  blur: number;
  spread: number;
  /** 暂时关掉（面板里的眼睛）。省略表示打开 */
  hidden?: boolean;
}

export interface BlurEffect {
  type: 'layerBlur' | 'backgroundBlur';
  radius: number;
  hidden?: boolean;
}

export type Effect = ShadowEffect | BlurEffect;

export const MAX_EFFECTS = 16;

/** 模糊半径 → 高斯模糊的标准差 */
export function blurSigma(radius: number): number {
  return Math.max(0, radius) / 2;
}

/** 打开着的效果；画板和页面不画效果 */
export function activeEffects(node: SceneNode): Effect[] {
  if (!node.effects || node.type === 'artboard' || node.type === 'page') return [];
  return node.effects.filter((e) => !e.hidden);
}

export function isShadow(effect: Effect): effect is ShadowEffect {
  return effect.type === 'dropShadow' || effect.type === 'innerShadow';
}

/** 新加的效果的默认值：一个淡淡的往下的投影，模糊用 4 */
export function defaultEffect(type: EffectType): Effect {
  if (type === 'dropShadow' || type === 'innerShadow') {
    return { type, color: { r: 0, g: 0, b: 0, a: 0.25 }, x: 0, y: 4, blur: 8, spread: 0 };
  }
  return { type, radius: 8 };
}

/**
 * 效果让画出来的范围往四周多出多少（本地坐标）：投影按偏移、扩展和三倍标准差往外扩，图层模糊再往四周扩三倍标准差。
 * 内阴影、背景模糊不出范围
 */
export function effectOutset(effects: readonly Effect[]): { left: number; top: number; right: number; bottom: number } {
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  for (const e of effects) {
    if (e.type !== 'dropShadow') continue;
    const reach = Math.max(0, e.spread) + blurSigma(e.blur) * 3;
    left = Math.max(left, reach - e.x);
    right = Math.max(right, reach + e.x);
    top = Math.max(top, reach - e.y);
    bottom = Math.max(bottom, reach + e.y);
  }
  const blur = effects.find((e): e is BlurEffect => e.type === 'layerBlur');
  const extra = blur ? blurSigma(blur.radius) * 3 : 0;
  return { left: left + extra, top: top + extra, right: right + extra, bottom: bottom + extra };
}

function isColor(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return ['r', 'g', 'b', 'a'].every((k) => typeof c[k] === 'number' && (c[k] as number) >= 0 && (c[k] as number) <= 1);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 文件校验：认识的类型、有限的数字、模糊不是负数 */
export function isEffectList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_EFFECTS) return false;
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const e = item as Record<string, unknown>;
    if (e.hidden !== undefined && typeof e.hidden !== 'boolean') return false;
    if (e.type === 'dropShadow' || e.type === 'innerShadow') {
      return isColor(e.color) && finite(e.x) && finite(e.y) && finite(e.blur) && e.blur >= 0 && finite(e.spread);
    }
    if (e.type === 'layerBlur' || e.type === 'backgroundBlur') return finite(e.radius) && e.radius >= 0;
    return false;
  });
}
