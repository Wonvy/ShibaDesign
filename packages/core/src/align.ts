import { unionRects, type Rect } from './rect';

/**
 * 对齐与分布。全部是纯函数：输入每个对象的外接矩形，输出每个对象该移动多少。
 * 坐标系由调用方决定（通常是世界坐标）。
 */

export const ALIGN_MODES = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'] as const;
export type AlignMode = (typeof ALIGN_MODES)[number];

export const DISTRIBUTE_MODES = ['hspacing', 'vspacing', 'hcenters', 'vcenters'] as const;
export type DistributeMode = (typeof DISTRIBUTE_MODES)[number];

export interface Box extends Rect {
  id: string;
}

export interface Delta {
  id: string;
  dx: number;
  dy: number;
}

/** 把每个盒子对齐到 reference 的某条边或中线 */
export function align(boxes: readonly Box[], mode: AlignMode, reference: Rect): Delta[] {
  return boxes.map((box) => {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case 'left':
        dx = reference.x - box.x;
        break;
      case 'hcenter':
        dx = reference.x + reference.w / 2 - (box.x + box.w / 2);
        break;
      case 'right':
        dx = reference.x + reference.w - (box.x + box.w);
        break;
      case 'top':
        dy = reference.y - box.y;
        break;
      case 'vcenter':
        dy = reference.y + reference.h / 2 - (box.y + box.h / 2);
        break;
      case 'bottom':
        dy = reference.y + reference.h - (box.y + box.h);
        break;
    }
    return { id: box.id, dx, dy };
  });
}

/**
 * 分布。两端的对象不动，中间的对象重新排位。
 * - hspacing / vspacing：相邻对象之间的空隙相等
 * - hcenters / vcenters：相邻对象的中心距相等
 * 少于三个对象时没有可分布的东西，返回全零。
 */
export function distribute(boxes: readonly Box[], mode: DistributeMode): Delta[] {
  const horizontal = mode === 'hspacing' || mode === 'hcenters';
  const pos = (b: Box): number => (horizontal ? b.x : b.y);
  const len = (b: Box): number => (horizontal ? b.w : b.h);
  const center = (b: Box): number => pos(b) + len(b) / 2;
  const zero: Delta[] = boxes.map((b) => ({ id: b.id, dx: 0, dy: 0 }));
  if (boxes.length < 3) return zero;

  const byCenters = mode === 'hcenters' || mode === 'vcenters';
  const sorted = [...boxes].sort((a, b) => (byCenters ? center(a) - center(b) : pos(a) - pos(b)));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const shift = new Map<string, number>();

  if (byCenters) {
    const step = (center(last) - center(first)) / (sorted.length - 1);
    sorted.forEach((box, i) => shift.set(box.id, center(first) + step * i - center(box)));
  } else {
    const span = pos(last) + len(last) - pos(first);
    const total = sorted.reduce((sum, b) => sum + len(b), 0);
    const gap = (span - total) / (sorted.length - 1);
    let cursor = pos(first);
    for (const box of sorted) {
      shift.set(box.id, cursor - pos(box));
      cursor += len(box) + gap;
    }
  }

  return boxes.map((b) => {
    const d = shift.get(b.id) ?? 0;
    return horizontal ? { id: b.id, dx: d, dy: 0 } : { id: b.id, dx: 0, dy: d };
  });
}

/** 一组盒子的整体外接矩形 */
export function boundsOfBoxes(boxes: readonly Box[]): Rect | null {
  return unionRects(boxes);
}
