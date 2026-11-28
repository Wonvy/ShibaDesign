import type { NodeId, Subpath } from './model';
import { MOTION_PRESETS, motionPathEnds, sampleMotionPath } from './motion';
import type { Point, Rect } from './rect';

/**
 * 幻灯片动画：数据模型、效果库、时间安排。
 *
 * 模型和 PPT 的"动画窗格"是一回事：每页幻灯片有一个切换效果，和一张按顺序排列的动画列表。
 * 每条动画作用于这一页上的一个对象，属于"进入、强调、退出、动作路径"四类之一。
 *
 * 这个模块全是纯数据和纯函数，不碰 DOM。它把动画列表算成一组"什么时候、对谁、播哪些关键帧"，
 * 关键帧用的是 Web Animations API 的格式，播放器拿到后直接交给浏览器执行。
 */

export const ANIMATION_KINDS = ['entrance', 'emphasis', 'exit', 'motion'] as const;
export type AnimationKind = (typeof ANIMATION_KINDS)[number];

export const ANIMATION_STARTS = ['onClick', 'withPrevious', 'afterPrevious'] as const;
/** 单击时 / 与上一动画同时 / 上一动画之后 */
export type AnimationStart = (typeof ANIMATION_STARTS)[number];

export const DIRECTIONS = ['left', 'right', 'top', 'bottom'] as const;
/** 进入时表示"从哪边来"，退出时表示"往哪边去" */
export type Direction = (typeof DIRECTIONS)[number];

export interface SlideAnimation {
  id: string;
  /** 作用的对象，必须是这一页幻灯片的直接子节点 */
  target: NodeId;
  /** 效果 id，见 effects 注册表 */
  effect: string;
  start: AnimationStart;
  /** 时长，毫秒 */
  duration: number;
  /** 开始前的等待，毫秒 */
  delay: number;
  direction?: Direction;
  /**
   * 动作路径：对象沿着走的线，锚点模型同钢笔路径。坐标是幻灯片坐标里相对对象中心的位移，起点通常是 (0, 0)。
   * 同一个对象有好几条动作路径时，后一条从前一条的终点接着走（见 scheduleAnimations）。只有动作路径效果用它
   */
  path?: Subpath;
}

export const TRANSITION_EFFECTS = ['none', 'fade', 'push', 'zoom', 'smooth'] as const;
/** smooth 是"平滑"：两页之间同一个对象自动补间移动，相当于 PPT 的平滑切换 */
export type TransitionEffect = (typeof TRANSITION_EFFECTS)[number];

/** 进入这一页时的切换效果 */
export interface SlideTransition {
  effect: TransitionEffect;
  /** 时长，毫秒 */
  duration: number;
  direction?: Direction;
}

export const DEFAULT_ANIMATION_DURATION = 500;
export const DEFAULT_TRANSITION: SlideTransition = { effect: 'none', duration: 600 };

// ───────────── 效果库 ─────────────

/** 一帧关键帧：CSS 属性名 → 值，可带 offset（0–1） */
export type Keyframe = Record<string, string | number>;

export interface EffectContext {
  /** 对象在幻灯片坐标里的外接矩形（前面的动作路径把它挪过的话，是挪过之后的位置） */
  box: Rect;
  slide: { width: number; height: number };
  direction: Direction;
  /** 这条动画的动作路径 */
  path?: Subpath;
}

export interface EffectFrames {
  /**
   * 作用在对象自身上的关键帧（缩放、旋转、透明度、裁剪），以对象中心为原点。
   * 省略表示这个效果没有这一部分。
   */
  fx?: Keyframe[];
  /** 让对象在幻灯片上整体平移的关键帧，用 CSS 的 translate 属性，单位是幻灯片坐标 */
  move?: Keyframe[];
  easing: string;
}

/**
 * 一个动画效果。新增效果：写一个 EffectDef，调用 registerEffect。
 * 播放器、编辑界面都不需要改——界面上的效果列表就是从注册表里读的。
 */
export interface EffectDef {
  id: string;
  kind: AnimationKind;
  /** 是否有方向可选（飞入、擦除这类） */
  directional?: boolean;
  /** 没有过程、瞬间完成的效果（出现、消失） */
  instant?: boolean;
  /** 动作路径效果：新加这条动画时给它的路径。自定义路径没有，要在画布上画 */
  defaultPath?(slide: { width: number; height: number }): Subpath;
  build(ctx: EffectContext): EffectFrames;
}

const effects = new Map<string, EffectDef>();

export function registerEffect(def: EffectDef): void {
  effects.set(def.id, def);
}

export function getEffect(id: string): EffectDef | undefined {
  return effects.get(id);
}

export function listEffects(kind?: AnimationKind): EffectDef[] {
  const all = [...effects.values()];
  return kind ? all.filter((e) => e.kind === kind) : all;
}

const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
const EASE_IN = 'cubic-bezier(0.7, 0, 0.84, 0)';
const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';

/** 把对象从某个方向完全移出幻灯片需要的位移 */
function offscreen(ctx: EffectContext): { x: number; y: number } {
  const { box, slide } = ctx;
  switch (ctx.direction) {
    case 'left':
      return { x: -(box.x + box.w), y: 0 };
    case 'right':
      return { x: slide.width - box.x, y: 0 };
    case 'top':
      return { x: 0, y: -(box.y + box.h) };
    case 'bottom':
      return { x: 0, y: slide.height - box.y };
  }
}

/** 从某个方向把对象整个裁掉时的 clip-path */
function clippedFrom(direction: Direction): string {
  switch (direction) {
    case 'left':
      return 'inset(0 100% 0 0)';
    case 'right':
      return 'inset(0 0 0 100%)';
    case 'top':
      return 'inset(0 0 100% 0)';
    case 'bottom':
      return 'inset(100% 0 0 0)';
  }
}

const SHOWN = 'inset(0 0 0 0)';
const px = (x: number, y: number): string => `${x}px ${y}px`;
const REST = px(0, 0);

/** 把一个进入效果倒过来，就是对应的退出效果 */
function reversed(frames: EffectFrames): EffectFrames {
  return {
    fx: frames.fx ? [...frames.fx].reverse() : undefined,
    move: frames.move ? [...frames.move].reverse() : undefined,
    easing: EASE_IN,
  };
}

const ENTRANCES: Omit<EffectDef, 'kind'>[] = [
  { id: 'appear', instant: true, build: () => ({ easing: 'linear' }) },
  { id: 'fade', build: () => ({ fx: [{ opacity: 0 }, { opacity: 1 }], easing: 'ease-out' }) },
  {
    id: 'fly',
    directional: true,
    build(ctx) {
      const from = offscreen(ctx);
      return { move: [{ translate: px(from.x, from.y) }, { translate: REST }], easing: EASE_OUT };
    },
  },
  {
    id: 'float',
    directional: true,
    build(ctx) {
      // 从指定方向浮进来一小段距离，同时淡入
      const sign = ctx.direction === 'left' || ctx.direction === 'top' ? -1 : 1;
      const horizontal = ctx.direction === 'left' || ctx.direction === 'right';
      const distance = 0.06 * Math.min(ctx.slide.width, ctx.slide.height);
      const from = horizontal ? px(sign * distance, 0) : px(0, sign * distance);
      return {
        move: [{ translate: from }, { translate: REST }],
        fx: [{ opacity: 0 }, { opacity: 1 }],
        easing: EASE_OUT,
      };
    },
  },
  {
    id: 'zoom',
    build: () => ({
      fx: [
        { transform: 'scale(0.3)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      easing: EASE_OUT,
    }),
  },
  {
    id: 'wipe',
    directional: true,
    build: (ctx) => ({ fx: [{ clipPath: clippedFrom(ctx.direction) }, { clipPath: SHOWN }], easing: EASE_IN_OUT }),
  },
];

for (const def of ENTRANCES) {
  registerEffect({ ...def, kind: 'entrance', id: `entrance.${def.id}` });
  // 每个进入效果都有一个倒放的退出效果。出现的反面叫消失，其余同名
  const exitId = def.id === 'appear' ? 'disappear' : def.id;
  registerEffect({ ...def, kind: 'exit', id: `exit.${exitId}`, build: (ctx) => reversed(def.build(ctx)) });
}

registerEffect({
  id: 'emphasis.pulse',
  kind: 'emphasis',
  build: () => ({
    fx: [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
    easing: EASE_IN_OUT,
  }),
});
registerEffect({
  id: 'emphasis.spin',
  kind: 'emphasis',
  build: () => ({ fx: [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], easing: EASE_IN_OUT }),
});
registerEffect({
  id: 'emphasis.shake',
  kind: 'emphasis',
  build: () => ({
    fx: [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(-6deg)' },
      { transform: 'rotate(5deg)' },
      { transform: 'rotate(-3deg)' },
      { transform: 'rotate(2deg)' },
      { transform: 'rotate(0deg)' },
    ],
    easing: 'ease-in-out',
  }),
});
registerEffect({
  id: 'emphasis.flash',
  kind: 'emphasis',
  build: () => ({
    fx: [{ opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }],
    easing: 'linear',
  }),
});

// ───────────── 动作路径 ─────────────

/** 坐标保留两位小数，导出的网页里关键帧不会是一长串数字 */
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 沿路径按弧长等分取点，排成 translate 关键帧。路径没有长度时停在起点 */
function motionFrames(ctx: EffectContext): EffectFrames {
  const points = ctx.path ? sampleMotionPath(ctx.path) : [];
  if (points.length === 0) return { easing: EASE_IN_OUT };
  if (points.length === 1) points.push(points[0]!);
  const n = points.length - 1;
  return {
    move: points.map((p, i) => ({ translate: px(round2(p.x), round2(p.y)), offset: i / n })),
    easing: EASE_IN_OUT,
  };
}

for (const id of ['line', 'arc', 'circle'] as const) {
  registerEffect({ id: `motion.${id}`, kind: 'motion', defaultPath: MOTION_PRESETS[id], build: motionFrames });
}
/** 自定义路径：在画布上从对象中心开始画 */
export const CUSTOM_MOTION_EFFECT = 'motion.custom';
registerEffect({ id: CUSTOM_MOTION_EFFECT, kind: 'motion', build: motionFrames });

/** 把关键帧里的 translate 整体挪一段（前面的动作路径把对象挪走了，后面的平移从那里算起） */
function shiftMove(frames: Keyframe[] | undefined, by: Point): Keyframe[] | undefined {
  if (!frames || (by.x === 0 && by.y === 0)) return frames;
  return frames.map((frame) => {
    const match = typeof frame.translate === 'string' ? /^(\S+)px (\S+)px$/.exec(frame.translate) : null;
    if (!match) return frame;
    return { ...frame, translate: px(round2(Number(match[1]) + by.x), round2(Number(match[2]) + by.y)) };
  });
}

// ───────────── 时间安排 ─────────────

/** 排好时间的一条动画，播放器直接执行 */
export interface ScheduledAnimation {
  /** 作用的对象 */
  target: NodeId;
  /** 相对这一步开始的时刻，毫秒 */
  start: number;
  duration: number;
  easing: string;
  fx?: Keyframe[];
  move?: Keyframe[];
  /** 开始时把对象显示出来（进入效果） */
  show: boolean;
  /** 结束时把对象藏起来（退出效果） */
  hide: boolean;
}

export interface SlideSchedule {
  /**
   * 一页的动画分成若干步。第 0 步在进入这一页后自动播放，之后每单击一次播放一步。
   * 第 0 步可能是空的。
   */
  steps: ScheduledAnimation[][];
  /** 进入这一页时应该先藏起来的对象：它们的第一条动画是进入效果 */
  hiddenAtStart: NodeId[];
}

export interface ScheduleInput {
  slide: { width: number; height: number };
  /** 这一页上每个可以做动画的对象在幻灯片坐标里的外接矩形。不在这里面的对象，对应的动画会被忽略 */
  boxes: ReadonlyMap<NodeId, Rect>;
}

/**
 * 把动画列表排成播放步骤。规则和 PPT 一致：
 * - "单击时"开启新的一步；
 * - "与上一动画同时"和上一条动画同一时刻开始；
 * - "上一动画之后"等上一条动画播完再开始；
 * - 每条动画自己的延迟再往后加；
 * - 动作路径播完对象停在终点。同一个对象后面的动画（下一条路径、飞出等平移）按列表顺序从这个位置接着算。
 */
export function scheduleAnimations(animations: readonly SlideAnimation[], input: ScheduleInput): SlideSchedule {
  const steps: ScheduledAnimation[][] = [[]];
  const hiddenAtStart: NodeId[] = [];
  const seen = new Set<NodeId>();
  /** 每个对象被前面的动作路径挪了多远 */
  const moved = new Map<NodeId, Point>();
  let previous: { start: number; end: number } | null = null;

  for (const animation of animations) {
    const def = getEffect(animation.effect);
    const box = input.boxes.get(animation.target);
    if (!def || !box) continue;

    if (animation.start === 'onClick') {
      steps.push([]);
      previous = null;
    }
    const base: number = !previous ? 0 : animation.start === 'afterPrevious' ? previous.end : previous.start;
    const start: number = base + Math.max(0, animation.delay);
    const duration = def.instant ? 0 : Math.max(0, animation.duration);
    const offset = moved.get(animation.target) ?? { x: 0, y: 0 };
    const frames = def.build({
      box: { ...box, x: box.x + offset.x, y: box.y + offset.y },
      slide: input.slide,
      direction: animation.direction ?? 'left',
      path: animation.path,
    });
    if (def.kind === 'motion' && animation.path) {
      const { end } = motionPathEnds(animation.path);
      moved.set(animation.target, { x: offset.x + end.x, y: offset.y + end.y });
    }

    steps[steps.length - 1]!.push({
      target: animation.target,
      start,
      duration,
      easing: frames.easing,
      fx: frames.fx,
      move: shiftMove(frames.move, offset),
      show: def.kind === 'entrance',
      hide: def.kind === 'exit',
    });
    previous = { start, end: start + duration };

    if (!seen.has(animation.target)) {
      seen.add(animation.target);
      if (def.kind === 'entrance') hiddenAtStart.push(animation.target);
    }
  }
  return { steps, hiddenAtStart };
}

/** 一步动画从开始到全部播完要多久，毫秒 */
export function stepDuration(step: readonly ScheduledAnimation[]): number {
  return step.reduce((max, a) => Math.max(max, a.start + a.duration), 0);
}
