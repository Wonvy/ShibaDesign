import { Menu as MenuIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@shiba/editor';
import { useEditor } from '../editor/context';
import {
  exportHtml,
  exportPdf,
  exportImage,
  isImageFile,
  openDocument,
  placeImageFiles,
  saveDocument,
  saveDocumentAs,
  useFileState,
} from '../files';
import { Menu } from '../ui/Menu';
import { ExportSvgDialog } from './ExportSvgDialog';
import { ExportVideoDialog } from './ExportVideoDialog';
import { NewDocumentDialog } from './NewDocumentDialog';
import { SaveTemplateDialog } from './SaveTemplateDialog';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** 把 'mod+shift+s' 这样的写法变成当前系统上的显示方式 */
function shortcut(keys: string): string {
  return keys
    .split('+')
    .map((key) => {
      if (key === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (key === 'shift') return IS_MAC ? '⇧' : 'Shift';
      return key.toUpperCase();
    })
    .join(IS_MAC ? '' : '+');
}

/** 菜单项要打开的对话框 */
interface MenuActions {
  newDocument(): void;
  saveTemplate(): void;
  exportSvg(): void;
  exportVideo(): void;
}

interface Item {
  labelKey: string;
  keys?: string;
  run(editor: Editor, actions: MenuActions): void;
}

const GROUPS: Item[][] = [
  [
    { labelKey: 'file.new', run: (_editor, actions) => actions.newDocument() },
    { labelKey: 'file.open', keys: 'mod+o', run: (editor) => void openDocument(editor) },
  ],
  [
    { labelKey: 'file.save', keys: 'mod+s', run: (editor) => void saveDocument(editor) },
    { labelKey: 'file.saveAs', keys: 'mod+shift+s', run: (editor) => void saveDocumentAs(editor) },
    { labelKey: 'file.saveAsTemplate', run: (_editor, actions) => actions.saveTemplate() },
  ],
  [
    { labelKey: 'file.exportPdf', run: (editor) => void exportPdf(editor) },
    { labelKey: 'file.exportSvg', run: (_editor, actions) => actions.exportSvg() },
    { labelKey: 'file.exportPng', keys: 'mod+shift+e', run: (editor) => void exportImage(editor, 'png', 1) },
    { labelKey: 'file.exportPng2x', run: (editor) => void exportImage(editor, 'png', 2) },
    { labelKey: 'file.exportJpeg', run: (editor) => void exportImage(editor, 'jpeg', 1) },
    { labelKey: 'file.exportJpeg2x', run: (editor) => void exportImage(editor, 'jpeg', 2) },
    { labelKey: 'file.exportHtml', run: (editor) => void exportHtml(editor) },
    { labelKey: 'file.exportVideo', run: (_editor, actions) => actions.exportVideo() },
  ],
];

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * 文件相关的全局快捷键和粘贴图片。
 * 这些快捷键在输入框里也要生效（否则会弹出浏览器自己的"保存网页"），所以单独监听，不走编辑器的快捷键表。
 */
function useFileShortcuts(editor: Editor, actions: MenuActions): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const pressed = `mod+${event.shiftKey ? 'shift+' : ''}${key}`;
      const item = GROUPS.flat().find((candidate) => candidate.keys === pressed);
      if (!item) return;
      event.preventDefault();
      item.run(editor, actions);
    };
    const onPaste = (event: ClipboardEvent): void => {
      // 正在输入文字时，粘贴交给输入框自己处理
      if (isEditable(event.target)) return;
      const images = [...(event.clipboardData?.files ?? [])].filter(isImageFile);
      if (images.length === 0) return;
      event.preventDefault();
      void placeImageFiles(editor, images);
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('paste', onPaste);
    };
  }, [editor, actions]);
}

export function FileMenu(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const file = useFileState();
  const [dialog, setDialog] = useState<'new' | 'template' | 'svg' | 'video' | null>(null);
  const [actions] = useState<MenuActions>(() => ({
    newDocument: () => setDialog('new'),
    saveTemplate: () => setDialog('template'),
    exportSvg: () => setDialog('svg'),
    exportVideo: () => setDialog('video'),
  }));
  useFileShortcuts(editor, actions);

  return (
    <>
      <Menu label={t('file.menu')} align="left" trigger={<MenuIcon size={16} />}>
        {(close) =>
          GROUPS.map((group, index) => (
            <div key={index}>
              {index > 0 && <div className="menu-separator" />}
              {group.map((item) => (
                <button
                  key={item.labelKey}
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    close();
                    item.run(editor, actions);
                  }}
                >
                  <span className="menu-text">{t(item.labelKey)}</span>
                  {item.keys && <span className="menu-shortcut">{shortcut(item.keys)}</span>}
                </button>
              ))}
            </div>
          ))
        }
      </Menu>
      <span className="file-name" title={file.dirty ? t('file.unsaved') : undefined}>
        {file.name ?? t('file.untitled')}
        {file.dirty && <span className="dirty-dot" role="img" aria-label={t('file.unsaved')} />}
      </span>
      {dialog === 'new' && <NewDocumentDialog onClose={() => setDialog(null)} />}
      {dialog === 'template' && <SaveTemplateDialog onClose={() => setDialog(null)} />}
      {dialog === 'svg' && <ExportSvgDialog onClose={() => setDialog(null)} />}
      {dialog === 'video' && <ExportVideoDialog onClose={() => setDialog(null)} />}
    </>
  );
}
