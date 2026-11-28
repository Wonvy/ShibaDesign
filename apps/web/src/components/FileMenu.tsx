import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@shiba/editor';
import { useEditor } from '../editor/context';
import { exportImage, openDocument, saveDocument, saveDocumentAs, useFileState } from '../files';
import { ExportSvgDialog } from './ExportSvgDialog';
import { ExportVideoDialog } from './ExportVideoDialog';
import { NewDocumentDialog } from './NewDocumentDialog';
import { SaveTemplateDialog } from './SaveTemplateDialog';

/**
 * 文件名、文件相关的对话框和快捷键。菜单项在菜单栏的"文件"一栏里（menus/definitions.ts），
 * 要打开对话框时调 openFileDialog
 */

export type FileDialog = 'new' | 'template' | 'svg' | 'video';

let dialog: FileDialog | null = null;
const listeners = new Set<() => void>();

/** 打开文件相关的对话框（新建、存为模板、导出 SVG、导出视频）；null 关掉 */
export function openFileDialog(next: FileDialog | null): void {
  dialog = next;
  for (const listener of [...listeners]) listener();
}

function useFileDialog(): FileDialog | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => dialog,
  );
}

const SHORTCUTS: Record<string, (editor: Editor) => void> = {
  'mod+o': (editor) => void openDocument(editor),
  'mod+s': (editor) => void saveDocument(editor),
  'mod+shift+s': (editor) => void saveDocumentAs(editor),
  'mod+shift+e': (editor) => void exportImage(editor, 'png', 1),
};

/**
 * 文件相关的全局快捷键。
 * 这些快捷键在输入框里也要生效（否则会弹出浏览器自己的"保存网页"），所以单独监听，不走编辑器的快捷键表。
 * 粘贴图片和文件在 clipboard.ts 里
 */
function useFileShortcuts(editor: Editor): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const run = SHORTCUTS[`mod+${event.shiftKey ? 'shift+' : ''}${key}`];
      if (!run) return;
      event.preventDefault();
      run(editor);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [editor]);
}

export function FileMenu(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const file = useFileState();
  const open = useFileDialog();
  useFileShortcuts(editor);
  const close = (): void => openFileDialog(null);

  return (
    <>
      <span className="file-name" title={file.dirty ? t('file.unsaved') : undefined}>
        {file.name ?? t('file.untitled')}
        {file.dirty && <span className="dirty-dot" role="img" aria-label={t('file.unsaved')} />}
      </span>
      {open === 'new' && <NewDocumentDialog onClose={close} />}
      {open === 'template' && <SaveTemplateDialog onClose={close} />}
      {open === 'svg' && <ExportSvgDialog onClose={close} />}
      {open === 'video' && <ExportVideoDialog onClose={close} />}
    </>
  );
}
