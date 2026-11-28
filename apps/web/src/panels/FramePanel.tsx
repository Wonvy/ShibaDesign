import { Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutoLayout, FrameNode } from '@shiba/core';
import { IconButton } from '../ui/controls';
import { FrameLayoutFields } from './LayoutFields';
import type { PanelProps } from './registry';

/** 画框：裁不裁剪超出范围的内容，自动布局。圆角在位置与大小一节里改，填充描边在外观一节里改 */
export function FramePanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const frames = nodes.filter((n): n is FrameNode => n.type === 'frame');
  if (frames.length === 0) return null;
  const clip = frames[0]!.clip;
  const mixed = frames.some((f) => f.clip !== clip);
  const withLayout = frames.filter((f): f is FrameNode & { layout: AutoLayout } => f.layout !== undefined);
  const allLayout = withLayout.length === frames.length;
  return (
    <div className="frame-panel">
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
      <div className="layout-row layout-toggle">
        <span className="prop-label">{t('layout.title')}</span>
        {allLayout ? (
          <IconButton title={t('frame.removeAutoLayout')} onClick={() => editor.commands.run('frame.removeAutoLayout')}>
            <Minus size={14} />
          </IconButton>
        ) : (
          <IconButton title={t('frame.autoLayout')} onClick={() => editor.commands.run('frame.autoLayout')}>
            <Plus size={14} />
          </IconButton>
        )}
      </div>
      {allLayout && <FrameLayoutFields editor={editor} frames={withLayout} />}
    </div>
  );
}
