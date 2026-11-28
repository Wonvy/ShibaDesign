import type { Color } from './model';

/**
 * 版面网格：画框和画板上的列网格、行网格、方格网格，排版时对齐用（演示稿、海报的 12 列网格也是它）。
 * 只在编辑时画、吸附用，导出不画。
 *
 * 列（行）网格：count 列，列之间 gutter，两边各留 margin；size 省略时列宽拉伸到填满，
 * 给了 size 时列宽固定，整组按 align 放在靠前、居中、靠后
 */

export interface StripeGrid {
  type: 'columns' | 'rows';
  count: number;
  gutter: number;
  margin: number;
  /** 每列（行）的宽度；省略表示拉伸填满 */
  size?: number;
  /** 列宽固定时整组放在哪。省略是靠前 */
  align?: 'start' | 'center' | 'end';
  color: Color;
  hidden?: boolean;
}

export interface SquareGrid {
  type: 'grid';
  size: number;
  color: Color;
  hidden?: boolean;
}

export type LayoutGrid = StripeGrid | SquareGrid;

export const LAYOUT_GRID_TYPES = ['columns', 'rows', 'grid'] as const;
export const MAX_LAYOUT_GRIDS = 16;
export const MAX_GRID_COUNT = 200;

/** 新加的网格的默认值：淡红色，列网格 12 列拉伸、间隔和边距 20 */
export function defaultLayoutGrid(type: 'grid'): SquareGrid;
export function defaultLayoutGrid(type: 'columns' | 'rows'): StripeGrid;
export function defaultLayoutGrid(type: LayoutGrid['type']): LayoutGrid;
export function defaultLayoutGrid(type: LayoutGrid['type']): LayoutGrid {
  const color = { r: 1, g: 0.2, b: 0.2, a: 0.1 };
  if (type === 'grid') return { type, size: 10, color };
  return { type, count: type === 'columns' ? 12 : 6, gutter: 20, margin: 20, color };
}

/** 列（行）网格在一个方向上的每一条：起点和长度。length 是这个方向上容器的长度 */
export function stripeBands(grid: StripeGrid, length: number): { start: number; size: number }[] {
  const count = Math.max(1, Math.min(MAX_GRID_COUNT, Math.round(grid.count)));
  const gutter = Math.max(0, grid.gutter);
  const margin = Math.max(0, grid.margin);
  let size: number;
  let start: number;
  if (grid.size === undefined) {
    size = Math.max(0, (length - margin * 2 - gutter * (count - 1)) / count);
    start = margin;
  } else {
    size = Math.max(0, grid.size);
    const total = size * count + gutter * (count - 1);
    const align = grid.align ?? 'start';
    start = align === 'center' ? (length - total) / 2 : align === 'end' ? length - margin - total : margin;
  }
  return Array.from({ length: count }, (_, i) => ({ start: start + i * (size + gutter), size }));
}

function isColor(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return ['r', 'g', 'b', 'a'].every((k) => typeof c[k] === 'number' && (c[k] as number) >= 0 && (c[k] as number) <= 1);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isLayoutGridList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_LAYOUT_GRIDS) return false;
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const g = item as Record<string, unknown>;
    if (!isColor(g.color) || (g.hidden !== undefined && typeof g.hidden !== 'boolean')) return false;
    if (g.type === 'grid') return finite(g.size) && g.size > 0;
    if (g.type !== 'columns' && g.type !== 'rows') return false;
    return (
      finite(g.count) &&
      g.count >= 1 &&
      g.count <= MAX_GRID_COUNT &&
      finite(g.gutter) &&
      g.gutter >= 0 &&
      finite(g.margin) &&
      g.margin >= 0 &&
      (g.size === undefined || (finite(g.size) && g.size >= 0)) &&
      (g.align === undefined || g.align === 'start' || g.align === 'center' || g.align === 'end')
    );
  });
}
