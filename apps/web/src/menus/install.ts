import type { Editor } from '@shiba/editor';
import { showPanel, toggleHidden, togglePanel } from '../dock/store';
import { onRenameRequest, requestRename } from '../ui/rename';
import { selectionContext } from './context';
import { contextMenuId, registerBuiltinMenus } from './definitions';
import { openContextMenu, openOverlay } from './overlays';

let registered = false;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * 接上菜单：注册内置菜单和界面层的几个命令（重命名、命令面板、快捷键表），
 * 画布上右键时弹对应的菜单，键盘的菜单键和 Shift+F10 打开选区的菜单。返回取消监听的函数
 */
export function installMenus(editor: Editor): () => void {
  if (!registered) {
    registerBuiltinMenus();
    registered = true;
  }
  editor.commands
    .register({
      id: 'node.rename',
      enabled: (e) => e.selection.length === 1,
      run: (e) => requestRename(e.selection[0]!),
    })
    .register<string>({ id: 'dock.show', run: (_e, id) => showPanel(id) })
    .register<string>({ id: 'dock.toggle', run: (_e, id) => togglePanel(id) })
    .register({ id: 'dock.toggleHidden', run: () => toggleHidden() })
    .register({ id: 'help.commandPalette', run: () => openOverlay('palette') })
    .register({ id: 'help.shortcuts', run: () => openOverlay('shortcuts') });

  editor.contextMenuHandler = (info) => {
    openContextMenu({
      x: info.clientX,
      y: info.clientY,
      menuId: contextMenuId(info.target.kind),
      ctx: { editor, info },
    });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const isMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
    if (!isMenuKey || isEditable(event.target)) return;
    event.preventDefault();
    const ctx = selectionContext(editor);
    const bounds = editor.selectionBounds();
    const rect = editor.container?.getBoundingClientRect();
    const center = bounds
      ? editor.worldToScreen(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2)
      : { x: editor.viewport.width / 2, y: editor.viewport.height / 2 };
    openContextMenu({
      x: (rect?.left ?? 0) + center.x,
      y: (rect?.top ?? 0) + center.y,
      menuId: contextMenuId(ctx.info.target.kind),
      ctx,
      keyboard: true,
    });
  };
  window.addEventListener('keydown', onKeyDown);
  // 重命名要在图层面板里进行：先把它打开、切过去
  const stopRename = onRenameRequest(() => showPanel('layers'));
  return () => {
    stopRename();
    window.removeEventListener('keydown', onKeyDown);
    if (editor.contextMenuHandler) editor.contextMenuHandler = null;
  };
}
