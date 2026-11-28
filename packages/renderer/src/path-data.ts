import type { CanvasKit, Path } from 'canvaskit-wasm';

/**
 * Skia 路径 → 导入器用的那种路径数据（0 移动、1 直线、2 三次、3 二次、4 闭合），导出 PDF、SVG 时用。
 * Skia 的椭圆和圆角用的是圆锥曲线，PDF 没有，换成三次曲线：
 * 对 90° 的圆弧这正是通常画圆用的那组控制点，对更小的弧误差也远小于一个像素。
 */
export function toPathData(ck: CanvasKit, path: Path): number[] {
  const cmds = path.toCmds();
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < cmds.length;) {
    const verb = cmds[i++]!;
    if (verb === ck.MOVE_VERB || verb === ck.LINE_VERB) {
      x = cmds[i++]!;
      y = cmds[i++]!;
      out.push(verb === ck.MOVE_VERB ? 0 : 1, x, y);
    } else if (verb === ck.QUAD_VERB) {
      out.push(3, cmds[i]!, cmds[i + 1]!, cmds[i + 2]!, cmds[i + 3]!);
      x = cmds[i + 2]!;
      y = cmds[i + 3]!;
      i += 4;
    } else if (verb === ck.CONIC_VERB) {
      const [cx, cy, ex, ey, w] = [cmds[i]!, cmds[i + 1]!, cmds[i + 2]!, cmds[i + 3]!, cmds[i + 4]!];
      i += 5;
      const k = (4 * w) / (3 * (1 + w));
      out.push(2, x + k * (cx - x), y + k * (cy - y), ex + k * (cx - ex), ey + k * (cy - ey), ex, ey);
      x = ex;
      y = ey;
    } else if (verb === ck.CUBIC_VERB) {
      out.push(2, cmds[i]!, cmds[i + 1]!, cmds[i + 2]!, cmds[i + 3]!, cmds[i + 4]!, cmds[i + 5]!);
      x = cmds[i + 4]!;
      y = cmds[i + 5]!;
      i += 6;
    } else if (verb === ck.CLOSE_VERB) {
      out.push(4);
    } else {
      break;
    }
  }
  return out;
}
