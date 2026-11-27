import { Bold, TextAlignCenter, TextAlignEnd, TextAlignJustify, TextAlignStart, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { hasLiveAppearance, type TextAlign, type TextNode, type TextStyle } from '@shiba/core';
import { IconButton, NumberField } from '../ui/controls';
import type { PanelProps } from './registry';

const ALIGN: { align: TextAlign; icon: LucideIcon; labelKey: string }[] = [
  { align: 'left', icon: TextAlignStart, labelKey: 'text.alignLeft' },
  { align: 'center', icon: TextAlignCenter, labelKey: 'text.alignCenter' },
  { align: 'right', icon: TextAlignEnd, labelKey: 'text.alignRight' },
  { align: 'justify', icon: TextAlignJustify, labelKey: 'text.alignJustify' },
];

const SIZING: TextNode['sizing'][] = ['auto', 'fixed'];

/** 文本属性。多选时显示第一个文本的值，修改作用于选中的全部文本 */
export function TextPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const first = nodes.find((n) => n.type === 'text');
  if (!first) return null;
  const { style } = first;
  const families = editor.fonts.familyNames();

  const update = (label: string, patch: (node: TextNode) => Partial<TextNode>): void => {
    editor.updateSelection(label, (node) => (node.type === 'text' ? patch(node) : null));
    editor.store.sealHistory();
  };
  const setStyle = (patch: Partial<TextStyle>): void =>
    update('text style', (node) => ({ style: { ...node.style, ...patch } }));

  const fontSelect = (slot: 'latin' | 'cjk', label: string): ReactNode => (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <div className="prop-controls">
        <select
          className="select"
          aria-label={label}
          value={style.fontFamily[slot]}
          onChange={(e) => setStyle({ fontFamily: { ...style.fontFamily, [slot]: e.target.value } })}
        >
          {families.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  return (
    <div className="appearance">
      {hasLiveAppearance(first) && <p className="menu-hint frozen-hint">{t('text.frozenHint')}</p>}
      {fontSelect('latin', t('text.fontLatin'))}
      {fontSelect('cjk', t('text.fontCjk'))}

      <div className="prop-row">
        <span className="prop-label">{t('text.size')}</span>
        <div className="prop-controls">
          <NumberField label="" value={style.fontSize} min={1} max={2000} onCommit={(v) => setStyle({ fontSize: v })} />
          <IconButton
            title={t('text.bold')}
            active={style.fontWeight >= 600}
            onClick={() => setStyle({ fontWeight: style.fontWeight >= 600 ? 400 : 700 })}
          >
            <Bold size={15} />
          </IconButton>
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.lineHeight')}</span>
        <div className="prop-controls">
          <NumberField
            label=""
            value={style.lineHeight}
            min={0.5}
            max={10}
            onCommit={(v) => setStyle({ lineHeight: v })}
          />
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.letterSpacing')}</span>
        <div className="prop-controls">
          <NumberField
            label=""
            value={style.letterSpacing}
            min={-100}
            max={500}
            onCommit={(v) => setStyle({ letterSpacing: v })}
          />
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.align')}</span>
        <div className="prop-controls button-row">
          {ALIGN.map(({ align, icon: Icon, labelKey }) => (
            <IconButton
              key={align}
              title={t(labelKey)}
              active={first.align === align}
              onClick={() => update('text align', () => ({ align }))}
            >
              <Icon size={15} />
            </IconButton>
          ))}
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.sizing')}</span>
        <div className="prop-controls">
          <div className="segmented segmented-small" role="radiogroup" aria-label={t('text.sizing')}>
            {SIZING.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={first.sizing === mode}
                className={first.sizing === mode ? 'is-active' : ''}
                onClick={() =>
                  update('text sizing', (node) => ({
                    sizing: mode,
                    // 从自动宽度切到固定宽度时，以当前排出来的宽度作为起始宽度，画面不会跳
                    size: mode === 'fixed' ? [editor.textLayouts.get(node).width, 0] : node.size,
                  }))
                }
              >
                {t(mode === 'auto' ? 'text.autoWidth' : 'text.fixedWidth')}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
