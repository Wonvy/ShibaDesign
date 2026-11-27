import type { SceneNode } from '@shiba/core';

/**
 * 节点的显示名：用户起过名就用它，否则按当前语言生成"矩形 3"这样的默认名。
 * 用图片作填充的形状在用户眼里就是一张图片，所以叫"图片"。
 */
export function displayName(node: SceneNode, t: (key: string) => string): string {
  if (node.name) return node.name;
  const kind = 'fill' in node && node.fill?.type === 'image' ? 'image' : node.type;
  return `${t(`node.${kind}`)} ${node.seq}`;
}
