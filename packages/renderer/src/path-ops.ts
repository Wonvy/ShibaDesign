import type { CanvasKit, Path, StrokeCap, StrokeJoin as SkStrokeJoin } from 'canvaskit-wasm';
import {
  dashPattern,
  toSubpaths,
  type PathNode,
  type Rect,
  type Stroke,
  type StrokeJoin,
  type Subpath,
} from '@shiba/core';
import { toPathData } from './path-data';

/**
 * 生成新路径的几何运算：把描边变成轮廓、偏移路径、把 Skia 路径存回文档。
 * 编辑器的"轮廓化描边""偏移路径""文字转轮廓"都靠这里，结果是普通的钢笔路径，之后可以随便改。
 */

/** Skia 描边的默认斜接限制。画布上画描边用的就是它，转出来的轮廓也要一样 */
const MITER_LIMIT = 4;
/**
 * 描边、偏移的精度。Skia 把曲线的偏移线近似成一段段二次曲线，这个数越大分得越细；
 * 1 是按"一个单位一个像素"给的精度，转出来的路径会被放大看，多给一些
 */
const STROKE_PRECISION = 4;
/** 一条路径最多拆成多少段虚线。再多的话转出来的路径太大，放弃（画布上的虚线不受影响） */
const MAX_DASH_SEGMENTS = 10_000;

/** 路径存回文档用的几何：锚点平移到外框左上角为原点，box 是原来坐标里的紧致外框 */
export interface PathGeometry {
  subpaths: Subpath[];
  box: Rect;
  /** 布尔运算（PathOps）算出来的路径按奇偶规则填充，内外轮廓的方向不一定相反，要原样带上 */
  fillRule: PathNode['fillRule'];
}

/** 把 Skia 路径转成文档里钢笔路径的锚点。路径是空的或者没有面积也没有长度时返回 null */
export function pathGeometry(ck: CanvasKit, path: Path): PathGeometry | null {
  const subpaths = toSubpaths(toPathData(ck, path));
  if (subpaths.length === 0) return null;
  const [x0, y0, x1, y1] = path.computeTightBounds();
  const box = { x: x0!, y: y0!, w: x1! - x0!, h: y1! - y0! };
  if (!(box.w >= 0 && box.h >= 0) || (box.w === 0 && box.h === 0)) return null;
  const shift = (sub: Subpath): Subpath => ({
    closed: sub.closed,
    anchors: sub.anchors.map((a) => ({
      x: a.x - box.x,
      y: a.y - box.y,
      inX: a.inX - box.x,
      inY: a.inY - box.y,
      outX: a.outX - box.x,
      outY: a.outY - box.y,
    })),
  });
  const fillRule = path.getFillType() === ck.FillType.EvenOdd ? 'evenodd' : 'nonzero';
  return { subpaths: subpaths.map(shift), box, fillRule };
}

/**
 * 把路径按虚线拆成一段段。规则和 Skia 的虚线效果（SkDashPath）一样，所以转出来的样子和画布上画的一致：
 * - 起始偏移先按间隔总长取余，找到从第几段、这一段还剩多长开始；
 * - 每个子路径各自从头开始数；
 * - 闭合的子路径先跳过开头那一段实线，绕一圈回来再补上，和最后一段实线连成一笔（拐角处不会断开）；
 * - 长度为 0 的实线段留成一个点，配上圆头、方头端点时画出来是一个点。
 * 拆得太碎（超过 MAX_DASH_SEGMENTS 段）时返回 null。返回的路径由调用方 delete
 */
export function dashPath(ck: CanvasKit, path: Path, intervals: readonly number[], offset: number): Path | null {
  const total = intervals.reduce((sum, v) => sum + v, 0);
  if (!(total > 0) || intervals.length % 2 !== 0) return null;
  let phase = offset;
  if (phase < 0) {
    phase = -phase;
    if (phase > total) phase %= total;
    phase = total - phase;
    if (phase === total) phase = 0;
  } else if (phase >= total) {
    phase %= total;
  }
  // 起点落在第几段、这一段还剩多长
  let initialIndex = 0;
  let initialLength = intervals[0]!;
  for (let i = 0, rest = phase; i < intervals.length; i++) {
    const gap = intervals[i]!;
    if (rest > gap || (rest === gap && gap !== 0)) {
      rest -= gap;
    } else {
      initialIndex = i;
      initialLength = gap - rest;
      break;
    }
  }

  const builder = new ck.PathBuilder();
  const iter = new ck.ContourMeasureIter(path, false, STROKE_PRECISION);
  let segments = 0;
  try {
    for (let contour = iter.next(); contour; contour = iter.next()) {
      const length = contour.length();
      const closed = contour.isClosed();
      let skipFirst = closed;
      let added = false;
      let distance = 0;
      let index = initialIndex;
      let dashLength = initialLength;
      while (distance < length) {
        added = false;
        if (index % 2 === 0 && !skipFirst) {
          added = true;
          if (++segments > MAX_DASH_SEGMENTS) {
            contour.delete();
            builder.delete();
            return null;
          }
          const piece = contour.getSegment(distance, distance + dashLength, true);
          builder.addPath(piece);
          piece.delete();
        }
        distance += dashLength;
        skipFirst = false;
        index = (index + 1) % intervals.length;
        dashLength = intervals[index]!;
      }
      // 闭合的子路径：补上开头跳过的那段实线。上一段是实线时接着它画，不另起一笔
      if (closed && initialIndex % 2 === 0 && initialLength >= 0) {
        const piece = contour.getSegment(0, initialLength, true);
        builder.addPath(piece, added);
        piece.delete();
      }
      contour.delete();
    }
  } finally {
    iter.delete();
  }
  const out = builder.detach();
  builder.delete();
  return out;
}

function skCap(ck: CanvasKit, cap: Stroke['cap']): StrokeCap {
  return cap === 'round' ? ck.StrokeCap.Round : cap === 'square' ? ck.StrokeCap.Square : ck.StrokeCap.Butt;
}

function skJoin(ck: CanvasKit, join: StrokeJoin | undefined): SkStrokeJoin {
  return join === 'round' ? ck.StrokeJoin.Round : join === 'bevel' ? ck.StrokeJoin.Bevel : ck.StrokeJoin.Miter;
}

/**
 * 描边画出来的那块区域，变成一条可以填色的路径（轮廓化描边）。端点、拐角、虚线、斜接限制都和画布上一样。
 * 描边宽度不是正数、虚线拆得太碎、或者算不出来时返回 null。返回的路径由调用方 delete
 */
export function strokeOutline(ck: CanvasKit, path: Path, stroke: Stroke): Path | null {
  if (!(stroke.width > 0)) return null;
  const dash = dashPattern(stroke);
  const source = dash ? dashPath(ck, path, dash, stroke.dashOffset ?? 0) : path;
  if (!source) return null;
  try {
    const stroked = source.makeStroked({
      width: stroke.width,
      miter_limit: MITER_LIMIT,
      precision: STROKE_PRECISION,
      cap: skCap(ck, stroke.cap),
      join: skJoin(ck, stroke.join),
    });
    if (!stroked) return null;
    // 描边的轮廓自己会重叠（拐角、虚线首尾相接处），合并成互不重叠的轮廓，之后改起来干净。
    // 类型声明里的 makeSimplified 在 0.42 的默认构建里没有，和一条空路径求并集是同样的效果
    const empty = new ck.Path();
    const simple: Path | null = ck.Path.MakeFromOp(stroked, empty, ck.PathOp.Union);
    empty.delete();
    if (!simple) return stroked;
    stroked.delete();
    return simple;
  } finally {
    if (source !== path) source.delete();
  }
}

/**
 * 描边画出来的范围（路径自己的坐标），端点、拐角、斜接都算；虚线按实线算（虚线只会更小）。
 * 只要外框的时候用它，比 strokeOutline 省掉了合并轮廓那一步。描边宽度不是正数或者算不出来时返回 null
 */
export function strokeBounds(ck: CanvasKit, path: Path, stroke: Stroke): Rect | null {
  if (!(stroke.width > 0)) return null;
  const stroked = path.makeStroked({
    width: stroke.width,
    miter_limit: MITER_LIMIT,
    cap: skCap(ck, stroke.cap),
    join: skJoin(ck, stroke.join),
  });
  if (!stroked) return null;
  const [x0, y0, x1, y1] = stroked.computeTightBounds();
  stroked.delete();
  return { x: x0!, y: y0!, w: x1! - x0!, h: y1! - y0! };
}

/**
 * 偏移路径：distance 为正时往外扩，为负时往里缩，拐角按 join 处理（尖角的斜接限制同描边）。
 * 做法是用 2 倍距离的描边和原来的形状合并（外扩）或者相减（内缩）。没闭合的路径按填充时的样子（首尾连起来）算面积，
 * 外扩时两头是平的（圆角时是圆的）。算不出来或者缩没了时返回 null。返回的路径由调用方 delete
 */
export function offsetOutline(ck: CanvasKit, path: Path, distance: number, join: StrokeJoin): Path | null {
  if (!Number.isFinite(distance) || distance === 0) return null;
  const band = path.makeStroked({
    width: Math.abs(distance) * 2,
    miter_limit: MITER_LIMIT,
    precision: STROKE_PRECISION,
    cap: join === 'round' ? ck.StrokeCap.Round : ck.StrokeCap.Butt,
    join: skJoin(ck, join),
  });
  if (!band) return null;
  const result: Path | null = ck.Path.MakeFromOp(path, band, distance > 0 ? ck.PathOp.Union : ck.PathOp.Difference);
  band.delete();
  if (!result) return null;
  if (result.isEmpty()) {
    result.delete();
    return null;
  }
  return result;
}
