import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, useEditorState } from '../editor/context';
import { historyName } from '../history';

/**
 * 撤销历史（窗口菜单里打开）：从早到晚列出做过的每一步，当前停在的那一步高亮，撤销掉还能重做的变灰；
 * 点哪一步就撤销或重做到那里。最上面一行是"打开时"，点它撤销全部
 */
export function HistoryPanel(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  useEditorState((s) => s.docVersion);
  const { labels, position } = editor.store.history();
  const row = (index: number, text: string) => (
    <button
      key={index}
      type="button"
      className={`history-row${index === position ? ' is-current' : ''}${index > position ? ' is-undone' : ''}`}
      onClick={() => editor.store.goToHistory(index)}
    >
      {text}
    </button>
  );
  return (
    <div className="history-panel">
      {row(0, t('history.start'))}
      {labels.map((label, i) => row(i + 1, historyName(label) ?? t('history.unnamed')))}
    </div>
  );
}
