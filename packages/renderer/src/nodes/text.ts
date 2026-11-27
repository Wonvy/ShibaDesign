import type { TextNode } from '@shiba/core';
import type { NodeTypeDef } from '../node-types';
import type { TextLayouts } from '../text/layout';

/**
 * 文本节点。排版结果来自 TextLayouts，所以这个类型要带着它创建，
 * 不在 registerBuiltinNodeTypes 里，而是由编辑器在准备好字体之后单独注册。
 */
export function createTextNodeType(layouts: TextLayouts): NodeTypeDef<TextNode> {
  return {
    type: 'text',
    children: 'none',
    // 轮廓是整个文本框：用于选区框和命中测试，点在字与字之间的空白处也算点中
    outline(node, { ck }) {
      const { width, height } = layouts.get(node);
      const builder = new ck.PathBuilder();
      builder.addRect(ck.XYWHRect(0, 0, Math.max(width, 1), Math.max(height, 1)));
      const path = builder.detach();
      builder.delete();
      return path;
    },
    draw(node, { canvas }) {
      if (!node.fill) return;
      canvas.drawParagraph(layouts.get(node).paragraph, 0, 0);
    },
  };
}
