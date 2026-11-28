import type { Anchor, Subpath } from './model';

/**
 * 路径数据：一串数，每条命令是一个编号后面跟它的坐标。
 * 打开 PDF、读字形轮廓、导出 PDF 和 SVG、把 Skia 路径存回文档都用这一种写法。
 */

/** 移动到 (x, y) */
export const PATH_MOVE = 0;
/** 直线到 (x, y) */
export const PATH_LINE = 1;
/** 三次曲线：两个控制点、终点 */
export const PATH_CUBIC = 2;
/** 二次曲线：一个控制点、终点 */
export const PATH_QUAD = 3;
/** 闭合当前子路径 */
export const PATH_CLOSE = 4;

const corner = (x: number, y: number): Anchor => ({ x, y, inX: x, inY: y, outX: x, outY: y });

/** 把路径数据转成文档模型的子路径。二次曲线升成三次曲线，只有一个点的子路径丢弃 */
export function toSubpaths(data: ArrayLike<number>): Subpath[] {
  const result: Subpath[] = [];
  let anchors: Anchor[] = [];
  let closed = false;
  let startX = 0;
  let startY = 0;

  const flush = (): void => {
    if (closed && anchors.length > 1) {
      // 最后一个点回到起点时，把它和起点合成一个锚点，否则闭合处会多出一条零长度的边
      const first = anchors[0]!;
      const last = anchors[anchors.length - 1]!;
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
        anchors[0] = { ...first, inX: last.inX, inY: last.inY };
        anchors.pop();
      }
    }
    if (anchors.length > 1) result.push({ closed, anchors });
    anchors = [];
    closed = false;
  };
  /** 闭合之后接着画，是从这个子路径的起点重新开始 */
  const resume = (): void => {
    if (closed || anchors.length === 0) {
      flush();
      anchors.push(corner(startX, startY));
    }
  };

  for (let i = 0; i < data.length;) {
    const command = data[i++]!;
    if (command === PATH_MOVE) {
      flush();
      startX = data[i++]!;
      startY = data[i++]!;
      anchors.push(corner(startX, startY));
    } else if (command === PATH_LINE) {
      resume();
      anchors.push(corner(data[i++]!, data[i++]!));
    } else if (command === PATH_CUBIC) {
      resume();
      const previous = anchors[anchors.length - 1]!;
      anchors[anchors.length - 1] = { ...previous, outX: data[i++]!, outY: data[i++]! };
      const inX = data[i++]!;
      const inY = data[i++]!;
      const x = data[i++]!;
      const y = data[i++]!;
      anchors.push({ x, y, inX, inY, outX: x, outY: y });
    } else if (command === PATH_QUAD) {
      resume();
      const previous = anchors[anchors.length - 1]!;
      const cx = data[i++]!;
      const cy = data[i++]!;
      const x = data[i++]!;
      const y = data[i++]!;
      anchors[anchors.length - 1] = {
        ...previous,
        outX: previous.x + ((cx - previous.x) * 2) / 3,
        outY: previous.y + ((cy - previous.y) * 2) / 3,
      };
      anchors.push({ x, y, inX: x + ((cx - x) * 2) / 3, inY: y + ((cy - y) * 2) / 3, outX: x, outY: y });
    } else if (command === PATH_CLOSE) {
      if (anchors.length > 0) closed = true;
    } else {
      break;
    }
  }
  flush();
  return result;
}
