import { SquareDashed, SquareSquare, TypeOutline, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { hasShapeStyle } from '@shiba/core';
import type { Editor } from '@shiba/editor';
import { OffsetPathDialog } from '../components/OffsetPathDialog';
import { toast } from '../ui/toast';
import type { PanelProps } from './registry';

/**
 * 文字转轮廓。直接调编辑器而不是走命令：要等它做完，看有没有转不了的（字形读不出来），
 * 转不了的提示一下，不然按了没反应
 */
async function outlineText(editor: Editor, failed: string): Promise<void> {
  const ids = editor
    .selectedNodes()
    .filter((node) => node.type === 'text' && !node.locked && node.fill)
    .map((node) => node.id);
  try {
    const done = await editor.outlineText(ids);
    if (done.length < ids.length) toast(failed, 'error');
  } catch (error) {
    console.error(error);
    toast(failed, 'error');
  }
}

/**
 * 生成路径：文字转轮廓、轮廓化描边、偏移路径。结果都是普通的钢笔路径。
 * 只列和选区有关的按钮：选了文字才有"文字转轮廓"，选了形状才有另外两个
 */
export function PathPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const [offsetOpen, setOffsetOpen] = useState(false);
  const hasText = nodes.some((n) => n.type === 'text');
  const hasShape = nodes.some(hasShapeStyle);

  const button = (label: string, Icon: LucideIcon, hint: string, enabled: boolean, onClick: () => void): ReactNode => (
    <button type="button" className="text-btn path-action" title={hint} disabled={!enabled} onClick={onClick}>
      <Icon size={14} />
      {label}
    </button>
  );

  return (
    <div className="path-panel">
      {hasText &&
        button(
          t('path.outlineText'),
          TypeOutline,
          t('path.outlineTextHint'),
          editor.commands.canRun('text.outline'),
          () => void outlineText(editor, t('path.outlineTextFailed')),
        )}
      {hasShape &&
        button(
          t('path.outlineStroke'),
          SquareDashed,
          t('path.outlineStrokeHint'),
          editor.commands.canRun('path.outlineStroke'),
          () => editor.commands.run('path.outlineStroke'),
        )}
      {hasShape &&
        button(t('path.offset'), SquareSquare, t('path.offsetHint'), editor.commands.canRun('path.offset'), () =>
          setOffsetOpen(true),
        )}
      {offsetOpen && <OffsetPathDialog onClose={() => setOffsetOpen(false)} />}
    </div>
  );
}
