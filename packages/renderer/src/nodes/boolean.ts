import type { CanvasKit, Path, PathOp } from 'canvaskit-wasm';
import type { BooleanNode, BooleanOp } from '@shiba/core';
import type { NodeTypeDef } from '../node-types';
import { toSkMatrix } from '../skia';

/**
 * 非破坏性布尔组。结果路径由子节点的轮廓按层叠顺序依次运算得到：
 * 最底层的形状是被操作对象，上面的形状逐个与它运算。
 */
export const booleanType: NodeTypeDef<BooleanNode> = {
  type: 'boolean',
  children: 'consume',
  outlineDeps(node, ctx) {
    return ctx.children(node);
  },
  outline(node, ctx) {
    const { ck } = ctx;
    const op = toPathOp(ck, node.op);
    let result: Path | null = null;
    for (const child of ctx.children(node)) {
      if (!child.visible) continue;
      const operand = transformed(ck, ctx.outlineOf(child), toSkMatrix(child.transform));
      if (!result) {
        result = operand;
        continue;
      }
      // 类型声明里的 path.makeCombined 在 0.42 的默认构建里并不存在，实测可用的是这个静态方法
      const combined: Path | null = ck.Path.MakeFromOp(result, operand, op);
      operand.delete();
      if (combined) {
        result.delete();
        result = combined;
      } else {
        // PathOps 在边几乎重合等情况下可能失败；保留上一步结果并记录，后续会接 Clipper2 回退
        booleanFailures.count += 1;
        console.warn(`[shiba] 布尔运算失败：节点 ${node.id}，操作 ${node.op}`);
      }
    }
    return result ?? new ck.Path();
  },
};

/** 运行期统计，供稳健性测试读取 */
export const booleanFailures = { count: 0 };

export function toPathOp(ck: CanvasKit, op: BooleanOp): PathOp {
  switch (op) {
    case 'union':
      return ck.PathOp.Union;
    case 'subtract':
      return ck.PathOp.Difference;
    case 'intersect':
      return ck.PathOp.Intersect;
    case 'exclude':
      return ck.PathOp.XOR;
  }
}

/** 返回变换后的新路径；Path 不可变，所以要经过 PathBuilder */
export function transformed(ck: CanvasKit, path: Path, matrix: number[]): Path {
  const builder = new ck.PathBuilder(path);
  builder.setFillType(path.getFillType());
  builder.transform(matrix);
  const out = builder.detach();
  builder.delete();
  return out;
}
