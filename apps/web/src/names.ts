import type { SceneNode } from '@shiba/core';

/** 用文字内容当名字时最多显示多少个字 */
const TEXT_NAME_LENGTH = 40;

/**
 * 节点的显示名：用户起过名就用它，否则按当前语言生成"矩形 3"这样的默认名。
 * 用图片作填充的形状在用户眼里就是一张图片，所以叫"图片"。
 * 文本直接显示它的第一行文字，在图层列表里一眼就能认出是哪段。
 */
export function displayName(node: SceneNode, t: (key: string) => string): string {
  if (node.name) return node.name;
  if (node.type === 'text') {
    const line = node.text
      .split('\n')
      .find((l) => l.trim())
      ?.trim();
    if (line) return line.length > TEXT_NAME_LENGTH ? `${line.slice(0, TEXT_NAME_LENGTH)}…` : line;
  }
  const kind =
    'fill' in node && node.fill?.type === 'image'
      ? 'image'
      : node.type === 'group' && node.mask
        ? 'maskGroup'
        : node.type;
  return `${t(`node.${kind}`)} ${node.seq}`;
}
