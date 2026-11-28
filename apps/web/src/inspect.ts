import { cssText, nodeCss, topLevelOnly, type CssDeclaration, type SceneNode } from '@shiba/core';
import type { Editor } from '@shiba/editor';
import { i18n } from './i18n';
import { displayName } from './names';

/** 一个对象的 CSS：宽高按画出来的（自动宽度的文字按排版出来的宽度），在自动布局里时带上 flex 的写法 */
export function cssOf(editor: Editor, node: SceneNode): CssDeclaration[] {
  const bounds = editor.geometry.localBounds(node);
  const parent = node.parent ? editor.store.get(node.parent) : undefined;
  const parentLayout = parent?.type === 'frame' && parent.layout ? parent.layout.direction : null;
  return nodeCss(node, { width: bounds.w, height: bounds.h, parentLayout });
}

/** 选中的对象写成一段 CSS：一个对象就是一串属性；几个对象时每个前面一行注释写它的名字 */
export function selectionCss(editor: Editor): string {
  const t = i18n.t.bind(i18n);
  const nodes = topLevelOnly(editor.store, editor.selection)
    .map((id) => editor.store.get(id))
    .filter((n): n is SceneNode => !!n);
  if (nodes.length === 1) return cssText(cssOf(editor, nodes[0]!));
  return nodes
    .map((node) => `/* ${displayName(node, t, editor.store)} */\n${cssText(cssOf(editor, node))}`)
    .join('\n\n');
}
