import type { Rect } from './rect';

/**
 * 自动布局：画框里的子对象按一个方向排成一行（或一列），间距、内边距、对齐由画框决定；
 * 画框自己的宽高可以固定，也可以"包住内容"；子对象的宽高可以固定，也可以"填满"剩下的空间。
 * 不参与自动布局的子对象（layoutIgnore）照常按自己的位置和约束放。
 *
 * 这里只有纯计算：给出画框和每个子对象现在的大小，算出画框的新大小和每个子对象的位置大小。
 * 算出来的结果由编辑器的整理器写回节点的 transform 和 size，所以渲染、导出、播放器都不用认识自动布局。
 * 换行以后再做
 */

export const LAYOUT_DIRECTIONS = ['horizontal', 'vertical'] as const;
export const LAYOUT_JUSTIFY = ['start', 'center', 'end', 'spaceBetween'] as const;
export const LAYOUT_ALIGN = ['start', 'center', 'end'] as const;

export type LayoutDirection = (typeof LAYOUT_DIRECTIONS)[number];
export type LayoutJustify = (typeof LAYOUT_JUSTIFY)[number];
export type LayoutAlign = (typeof LAYOUT_ALIGN)[number];
/** 画框自己在一个方向上的尺寸：固定，或者包住内容 */
export type FrameSizing = 'fixed' | 'hug';
/** 子对象在一个方向上的尺寸：固定，或者填满画框里剩下的空间 */
export type ItemSizing = 'fixed' | 'fill';

export interface AutoLayout {
  direction: LayoutDirection;
  gap: number;
  /** 上、右、下、左 */
  padding: readonly [number, number, number, number];
  /** 主轴（排列的方向）上怎么放 */
  justify: LayoutJustify;
  /** 交叉轴上怎么放 */
  align: LayoutAlign;
  /** 画框的宽、高 */
  sizing: { readonly h: FrameSizing; readonly v: FrameSizing };
}

export interface ItemLayoutSizing {
  h: ItemSizing;
  v: ItemSizing;
}

export const DEFAULT_ITEM_SIZING: ItemLayoutSizing = { h: 'fixed', v: 'fixed' };

/** 参与排列的一个子对象：它现在的大小，和两个方向的尺寸方式 */
export interface LayoutItem {
  id: string;
  width: number;
  height: number;
  sizing: ItemLayoutSizing;
}

export interface LayoutResult {
  /** 画框的新大小 */
  size: [number, number];
  /** 每个子对象在画框坐标里的外框 */
  boxes: Map<string, Rect>;
}

/**
 * 算一次自动布局。
 * @param size 画框现在的大小（固定的方向按它）
 * @param items 参与排列的子对象，按排列顺序
 * @param measure 子对象在某个方向填满、宽度变了以后的新高度（文字折行后变高）。不给时高度不变
 */
export function computeLayout(
  size: readonly [number, number],
  layout: AutoLayout,
  items: readonly LayoutItem[],
  measure?: (item: LayoutItem, width: number) => number,
): LayoutResult {
  const horizontal = layout.direction === 'horizontal';
  const [top, right, bottom, left] = layout.padding;
  const mainHug = (horizontal ? layout.sizing.h : layout.sizing.v) === 'hug';
  const crossHug = (horizontal ? layout.sizing.v : layout.sizing.h) === 'hug';
  const padMainStart = horizontal ? left : top;
  const padMainEnd = horizontal ? right : bottom;
  const padCrossStart = horizontal ? top : left;
  const padCrossEnd = horizontal ? bottom : right;
  const gap = Math.max(0, layout.gap);
  // 包住内容的方向上"填满"没有意义（画框的大小反过来由内容决定），按固定算
  const fillMain = (item: LayoutItem) => !mainHug && (horizontal ? item.sizing.h : item.sizing.v) === 'fill';
  const fillCross = (item: LayoutItem) => !crossHug && (horizontal ? item.sizing.v : item.sizing.h) === 'fill';
  const mainOf = (w: number, h: number) => (horizontal ? w : h);
  const crossOf = (w: number, h: number) => (horizontal ? h : w);

  const n = items.length;
  const gaps = n > 1 ? gap * (n - 1) : 0;
  const innerMain = Math.max(0, mainOf(size[0], size[1]) - padMainStart - padMainEnd);
  let innerCross = Math.max(0, crossOf(size[0], size[1]) - padCrossStart - padCrossEnd);
  // 高度由画框定（横排时交叉轴填满、竖排时主轴填满）的就不用再量
  const heightFilled = (item: LayoutItem) => (horizontal ? fillCross(item) : fillMain(item));
  const remeasure = (s: { item: LayoutItem; w: number; h: number }) => {
    if (measure && s.w !== s.item.width && !heightFilled(s.item)) s.h = measure(s.item, s.w);
  };

  // 先定交叉轴：填满的等于画框里的宽度（或高度）；宽度变了的重新量高度（文字折行）
  const sized = items.map((item) => ({ item, w: item.width, h: item.height }));
  for (const s of sized) {
    if (!fillCross(s.item)) continue;
    if (horizontal) s.h = innerCross;
    else s.w = innerCross;
    remeasure(s);
  }

  // 再定主轴：固定的先占，剩下的平分给填满的
  const fixedMain = sized.filter((s) => !fillMain(s.item)).reduce((sum, s) => sum + mainOf(s.w, s.h), 0);
  const fillCount = sized.filter((s) => fillMain(s.item)).length;
  const spaceBetween = layout.justify === 'spaceBetween' && !mainHug && fillCount === 0;
  const share = fillCount > 0 ? Math.max(1, (innerMain - fixedMain - gaps) / fillCount) : 0;
  for (const s of sized) {
    if (!fillMain(s.item)) continue;
    if (horizontal) s.w = share;
    else s.h = share;
    remeasure(s);
  }
  if (crossHug) innerCross = sized.reduce((max, s) => Math.max(max, crossOf(s.w, s.h)), 0);

  const used = sized.reduce((sum, s) => sum + mainOf(s.w, s.h), 0) + gaps;
  const mainLength = mainHug ? used + padMainStart + padMainEnd : mainOf(size[0], size[1]);
  const crossLength = crossHug ? innerCross + padCrossStart + padCrossEnd : crossOf(size[0], size[1]);
  const available = mainLength - padMainStart - padMainEnd;

  let cursor = padMainStart;
  let step = gap;
  if (!mainHug) {
    if (spaceBetween && n > 1) step = (available - (used - gaps)) / (n - 1);
    else if (layout.justify === 'center') cursor += (available - used) / 2;
    else if (layout.justify === 'end') cursor += available - used;
  }

  const boxes = new Map<string, Rect>();
  for (const s of sized) {
    const main = mainOf(s.w, s.h);
    const cross = crossOf(s.w, s.h);
    let crossStart = padCrossStart;
    if (layout.align === 'center') crossStart += (innerCross - cross) / 2;
    else if (layout.align === 'end') crossStart += innerCross - cross;
    boxes.set(
      s.item.id,
      horizontal ? { x: cursor, y: crossStart, w: s.w, h: s.h } : { x: crossStart, y: cursor, w: s.w, h: s.h },
    );
    cursor += main + step;
  }
  return { size: horizontal ? [mainLength, crossLength] : [crossLength, mainLength], boxes };
}

/**
 * 按子对象现在的摆放猜一套自动布局（⇧A 加自动布局时用）：横向铺得开就横排，间距取相邻两个之间的平均空隙，
 * 内边距取到画框四边最近的距离。boxes 是子对象在画框坐标里的外框
 */
export function inferLayout(size: readonly [number, number], boxes: readonly Rect[]): AutoLayout {
  const base: AutoLayout = {
    direction: 'horizontal',
    gap: 10,
    padding: [0, 0, 0, 0],
    justify: 'start',
    align: 'start',
    sizing: { h: 'hug', v: 'hug' },
  };
  if (boxes.length === 0) return base;
  const xs = boxes.map((b) => b.x + b.w / 2);
  const ys = boxes.map((b) => b.y + b.h / 2);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  const direction: LayoutDirection = spreadY > spreadX ? 'vertical' : 'horizontal';
  const sorted = [...boxes].sort((a, b) => (direction === 'horizontal' ? a.x - b.x : a.y - b.y));
  let gapSum = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    gapSum += direction === 'horizontal' ? cur.x - (prev.x + prev.w) : cur.y - (prev.y + prev.h);
  }
  const gap = sorted.length > 1 ? Math.max(0, Math.round(gapSum / (sorted.length - 1))) : base.gap;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const round = (v: number) => Math.max(0, Math.round(v));
  return {
    ...base,
    direction,
    gap,
    padding: [round(minY), round(size[0] - maxX), round(size[1] - maxY), round(minX)],
  };
}

export function isAutoLayout(value: unknown): value is AutoLayout {
  if (typeof value !== 'object' || value === null) return false;
  const l = value as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const sizing = l.sizing as Record<string, unknown> | undefined;
  return (
    (LAYOUT_DIRECTIONS as readonly unknown[]).includes(l.direction) &&
    finite(l.gap) &&
    Array.isArray(l.padding) &&
    l.padding.length === 4 &&
    l.padding.every((p) => finite(p) && (p as number) >= 0) &&
    (LAYOUT_JUSTIFY as readonly unknown[]).includes(l.justify) &&
    (LAYOUT_ALIGN as readonly unknown[]).includes(l.align) &&
    typeof sizing === 'object' &&
    sizing !== null &&
    (sizing.h === 'fixed' || sizing.h === 'hug') &&
    (sizing.v === 'fixed' || sizing.v === 'hug')
  );
}

export function isItemSizing(value: unknown): value is ItemLayoutSizing {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (s.h === 'fixed' || s.h === 'fill') && (s.v === 'fixed' || s.v === 'fill');
}
