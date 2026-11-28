import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FrameNode } from '@shiba/core';
import type { PanelProps } from './registry';

/** 画框：裁不裁剪超出范围的内容。圆角在位置与大小一节里改，填充描边在外观一节里改 */
export function FramePanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const frames = nodes.filter((n): n is FrameNode => n.type === 'frame');
  if (frames.length === 0) return null;
  const clip = frames[0]!.clip;
  const mixed = frames.some((f) => f.clip !== clip);
  return (
    <label className="check-row">
      <input
        type="checkbox"
        checked={clip}
        ref={(el) => {
          if (el) el.indeterminate = mixed;
        }}
        onChange={(event) => {
          const next = event.target.checked;
          editor.updateSelection('frame clip', (node) => (node.type === 'frame' ? { clip: next } : null));
          editor.store.sealHistory();
        }}
      />
      {t('prop.clipContent')}
    </label>
  );
}
