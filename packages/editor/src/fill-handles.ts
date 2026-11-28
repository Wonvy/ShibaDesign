import { gradientGeometry, type GradientFill, type ImageFill, type NodeId, type Point, type Rect } from '@shiba/core';
import { placeImage } from '@shiba/renderer';

/**
 * 在画布上直接调整填充：渐变的起点终点，图片在形状里的位置和大小。
 *
 * 渐变的起点终点常常正好落在选区框的角上、边的中点上，和缩放控制柄重叠，
 * 所以这是一个单独的状态（像 Figma 那样）：进入以后缩放、旋转控制柄换成填充的手柄，按 Esc、换选区、换工具退出。
 * 这个文件只管几何：手柄在哪、拖到某处时填充变成什么样，都在节点的本地坐标里算。
 */

export type FillEditKind = 'gradient' | 'image';

/** 正在画布上调整哪个节点的哪种填充 */
export interface FillEditing {
  id: NodeId;
  kind: FillEditKind;
}

export type GradientPoint = 'start' | 'end' | 'aspect';

/** 按住 Shift 拖动渐变手柄时方向按 45° 吸附 */
const SNAP = Math.PI / 4;
/** 图片在形状里最多放大几倍，和图片面板的滑块一致 */
export const MAX_IMAGE_ZOOM = 4;

/**
 * 渐变手柄在节点本地坐标里的位置：起点（径向渐变是圆心）、终点（圆周上的点），
 * 径向渐变还有一个调压扁比例的手柄，在垂直于终点方向、距离 半径 × 比例 的地方
 */
export function gradientHandlePoints(
  fill: GradientFill,
  box: Rect,
): { start: Point; end: Point; aspect: Point | null } {
  const g = gradientGeometry(fill, box);
  const start = { x: g.x0, y: g.y0 };
  const end = { x: g.x1, y: g.y1 };
  if (fill.kind !== 'radial') return { start, end, aspect: null };
  const aspect = fill.aspect ?? 1;
  // 把圆心到终点的方向转 90°
  return { start, end, aspect: { x: g.x0 - (g.y1 - g.y0) * aspect, y: g.y0 + (g.x1 - g.x0) * aspect } };
}

/**
 * 把某个渐变手柄拖到本地坐标里的 to 之后的渐变。
 * 线性渐变：起点、终点各自移动。径向渐变：拖圆心整个渐变一起移动，拖终点改半径和方向，拖第三个手柄改压扁比例。
 * Shift：线性渐变的方向、径向渐变终点的方向按 45° 吸附
 * @param original 开始拖动时的渐变
 */
export function dragGradientPoint(
  original: GradientFill,
  box: Rect,
  point: GradientPoint,
  to: Point,
  shift: boolean,
): GradientFill {
  const w = box.w || 1;
  const h = box.h || 1;
  const relative = (p: Point): Point => ({ x: (p.x - box.x) / w, y: (p.y - box.y) / h });
  const handles = gradientHandlePoints(original, box);

  if (point === 'aspect') {
    const { start, end } = handles;
    const radius = Math.hypot(end.x - start.x, end.y - start.y);
    if (radius < 1e-6) return original;
    // 拖到的点在"垂直于终点方向"上离圆心多远
    const nx = -(end.y - start.y) / radius;
    const ny = (end.x - start.x) / radius;
    const across = Math.abs((to.x - start.x) * nx + (to.y - start.y) * ny);
    const aspect = Math.max(0.01, Math.min(100, across / radius));
    return { ...original, aspect: Math.abs(aspect - 1) < 1e-3 ? undefined : round(aspect) };
  }

  if (original.kind === 'radial' && point === 'start') {
    const dx = to.x - handles.start.x;
    const dy = to.y - handles.start.y;
    return {
      ...original,
      start: relative({ x: handles.start.x + dx, y: handles.start.y + dy }),
      end: relative({ x: handles.end.x + dx, y: handles.end.y + dy }),
    };
  }

  // 另一头不动；Shift 时方向吸附到 45° 的倍数，长度不变
  const anchor = point === 'start' ? handles.end : handles.start;
  let target = to;
  if (shift) {
    const length = Math.hypot(to.x - anchor.x, to.y - anchor.y);
    const angle = Math.round(Math.atan2(to.y - anchor.y, to.x - anchor.x) / SNAP) * SNAP;
    target = { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length };
  }
  const moved = relative(target);
  return point === 'start' ? { ...original, start: roundPoint(moved) } : { ...original, end: roundPoint(moved) };
}

/** 图片整张在节点本地坐标里占的矩形（形状之外被裁掉的部分也算） */
export function imageRect(fill: ImageFill, box: Rect, image: { width: number; height: number }): Rect {
  const place = placeImage(image.width, image.height, box, fill);
  return { x: place.tx, y: place.ty, w: image.width * place.sx, h: image.height * place.sy };
}

/**
 * 在形状里拖动图片：位移换算成 panX / panY（-1 到 1，到头为止）。
 * 某个方向上图片和框一样大时那个方向不能挪
 */
export function panImage(
  original: ImageFill,
  box: Rect,
  image: { width: number; height: number },
  dx: number,
  dy: number,
): ImageFill {
  const rect = imageRect(original, box, image);
  const slackX = Math.abs(box.w - rect.w);
  const slackY = Math.abs(box.h - rect.h);
  const panX = slackX > 1e-6 ? clamp((original.panX ?? 0) + (2 * dx) / slackX) : 0;
  const panY = slackY > 1e-6 ? clamp((original.panY ?? 0) + (2 * dy) / slackY) : 0;
  return withFrame(original, { panX, panY });
}

/**
 * 缩放形状里的图片：放大 factor 倍（相对开始拖动时），1 到 MAX_IMAGE_ZOOM 倍之间。
 * 图片的中心尽量不动；挪到头了就贴着边
 */
export function zoomImage(
  original: ImageFill,
  box: Rect,
  image: { width: number; height: number },
  factor: number,
): ImageFill {
  const before = imageRect(original, box, image);
  const center = { x: before.x + before.w / 2, y: before.y + before.h / 2 };
  const zoom = Math.min(MAX_IMAGE_ZOOM, Math.max(1, (original.zoom ?? 1) * factor));
  const scaled = imageRect({ ...original, zoom, panX: 0, panY: 0 }, box, image);
  // 图片中心 = 框中心 + pan × |余量| / 2，反过来求 pan
  const pan = (c: number, boxStart: number, boxSize: number, size: number): number => {
    const slack = Math.abs(boxSize - size);
    return slack > 1e-6 ? clamp(((c - (boxStart + boxSize / 2)) * 2) / slack) : 0;
  };
  return withFrame(original, {
    zoom,
    panX: pan(center.x, box.x, box.w, scaled.w),
    panY: pan(center.y, box.y, box.h, scaled.h),
  });
}

/** 设置画面内的缩放平移；等于默认值的项去掉，文档里不留没有意义的数 */
function withFrame(fill: ImageFill, frame: { zoom?: number; panX: number; panY: number }): ImageFill {
  const { zoom: _zoom, panX: _panX, panY: _panY, ...rest } = fill;
  const zoom = frame.zoom ?? fill.zoom;
  return {
    ...rest,
    ...(zoom !== undefined && Math.abs(zoom - 1) > 1e-4 ? { zoom: round(zoom) } : {}),
    ...(Math.abs(frame.panX) > 1e-4 ? { panX: round(frame.panX) } : {}),
    ...(Math.abs(frame.panY) > 1e-4 ? { panY: round(frame.panY) } : {}),
  };
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function roundPoint(p: Point): Point {
  return { x: round(p.x), y: round(p.y) };
}
