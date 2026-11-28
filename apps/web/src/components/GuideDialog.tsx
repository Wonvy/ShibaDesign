import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Guide, NodeId } from '@shiba/core';
import { useEditor } from '../editor/context';
import { Dialog } from '../ui/Dialog';

/** 双击辅助线时打开的对话框：输入它的位置（相对所在的画板，页面上的辅助线是画布坐标） */

let editing: { container: NodeId; id: string } | null = null;
const listeners = new Set<() => void>();

export function openGuideDialog(guide: { container: NodeId; id: string } | null): void {
  editing = guide;
  for (const listener of [...listeners]) listener();
}

export function GuideDialog(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const target = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => editing,
  );
  const node = target ? (editor.store.get(target.container) as { guides?: readonly Guide[] } | undefined) : undefined;
  const guide = node?.guides?.find((g) => g.id === target?.id);
  const [value, setValue] = useState('');
  useEffect(() => setValue(guide ? String(Math.round(guide.offset * 100) / 100) : ''), [guide]);

  useEffect(() => {
    editor.guideEditHandler = (g) => openGuideDialog(g);
    return () => {
      editor.guideEditHandler = null;
    };
  }, [editor]);

  if (!target || !guide) return null;
  const close = (): void => openGuideDialog(null);
  return (
    <Dialog
      title={t(guide.axis === 'x' ? 'guide.vertical' : 'guide.horizontal')}
      submitLabel={t('path.apply')}
      cancelLabel={t('path.cancel')}
      onClose={close}
      onSubmit={() => {
        const offset = Number(value);
        if (Number.isFinite(offset)) editor.commands.run('guides.set', { ...target, offset });
        close();
      }}
    >
      <label className="dialog-field guide-field">
        <span>{t(guide.axis === 'x' ? 'guide.xPosition' : 'guide.yPosition')}</span>
        <input
          className="field-input"
          type="number"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
      </label>
    </Dialog>
  );
}
