import { hasLiveAppearance, type TextNode } from '@shiba/core';
import type { NodeTypeDef } from '../node-types';
import { toSkColor } from '../skia';
import type { TextAppearances } from '../text/appearance';
import type { TextLayouts } from '../text/layout';

/**
 * 文本节点。排版结果来自 TextLayouts，所以这个类型要带着它创建，
 * 不在 registerBuiltinNodeTypes 里，而是由编辑器在准备好字体之后单独注册。
 *
 * 有保真外观（从 PDF 导入、还没改过的文字）时按原文件的字形画，见 core 的 text-appearance.ts。
 */
export function createTextNodeType(layouts: TextLayouts, appearances: TextAppearances): NodeTypeDef<TextNode> {
  /** 按保真外观显示时的字形路径；该正常排版时返回 null */
  const frozen = (node: TextNode) => (hasLiveAppearance(node) ? appearances.path(node) : null);

  return {
    type: 'text',
    children: 'none',
    // 轮廓是整个文本框：用于选区框和命中测试，点在字与字之间的空白处也算点中
    outline(node, { ck }) {
      const box = frozen(node) ? { width: node.size[0], height: node.size[1] } : layouts.get(node);
      const builder = new ck.PathBuilder();
      builder.addRect(ck.XYWHRect(0, 0, Math.max(box.width, 1), Math.max(box.height, 1)));
      const path = builder.detach();
      builder.delete();
      return path;
    },
    draw(node, { ck, canvas, paint, opacity, blendMode }) {
      if (!node.fill) return;
      const glyphs = frozen(node);
      if (glyphs) {
        paint.setStyle(ck.PaintStyle.Fill);
        paint.setColor(toSkColor(ck, node.fill.color, opacity));
        paint.setBlendMode(blendMode);
        canvas.drawPath(glyphs, paint);
        return;
      }
      canvas.drawParagraph(layouts.get(node).paragraph, 0, 0);
    },
  };
}
