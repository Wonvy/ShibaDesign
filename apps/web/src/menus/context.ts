import type { Editor } from '@shiba/editor';
import type { MenuContext } from './model';
import { openContextMenu } from './overlays';

/** 顶部菜单栏、命令面板用的菜单上下文：按当前选区算，右键位置取选区中间 */
export function selectionContext(editor: Editor): MenuContext {
  const info = editor.contextForSelection();
  return { editor, info: { ...info, stack: [] } };
}

/** 面板里右键：按当前选区算上下文，带上点到的那一项，在鼠标处弹菜单 */
export function openPanelMenu(
  event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number },
  editor: Editor,
  menuId: string,
  subject?: string,
): void {
  event.preventDefault();
  event.stopPropagation();
  openContextMenu({ x: event.clientX, y: event.clientY, menuId, ctx: { ...selectionContext(editor), subject } });
}
