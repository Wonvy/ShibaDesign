import { roundPolygon } from './corners';
import type { PolygonNode, Subpath } from './model';

/**
 * 多边形和星形：在节点的外框里画内切的正多边形（第一个顶点朝上）；有 innerRatio 时是星形，
 * 外顶点和内顶点交替，内顶点到中心的距离是外顶点的 innerRatio 倍。圆角用 corners.ts
 */

export const MIN_SIDES = 3;
export const MAX_SIDES = 60;

/** 顶点（节点本地坐标），按顺时针 */
export function polygonPoints(w: number, h: number, sides: number, innerRatio?: number): { x: number; y: number }[] {
  const n = Math.max(MIN_SIDES, Math.min(MAX_SIDES, Math.round(sides)));
  const cx = w / 2;
  const cy = h / 2;
  const star = innerRatio !== undefined;
  const count = star ? n * 2 : n;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const k = star && i % 2 === 1 ? Math.max(0.01, Math.min(1, innerRatio!)) : 1;
    out.push({ x: cx + Math.cos(angle) * cx * k, y: cy + Math.sin(angle) * cy * k });
  }
  return out;
}

/** 多边形节点的轮廓 */
export function polygonOutline(
  node: Pick<PolygonNode, 'size' | 'sides' | 'innerRatio' | 'cornerRadius' | 'cornerStyle' | 'cornerSmoothing'>,
): Subpath {
  const [w, h] = node.size;
  return roundPolygon(
    polygonPoints(w, h, node.sides, node.innerRatio).map((p) => ({ ...p, radius: node.cornerRadius })),
    true,
    { style: node.cornerStyle, smoothing: node.cornerSmoothing },
  );
}
