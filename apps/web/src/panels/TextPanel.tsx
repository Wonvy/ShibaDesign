import {
  Bold,
  Italic,
  Strikethrough,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  hasLiveAppearance,
  rangeStyle,
  rgba,
  type CharacterStyle,
  type TextAlign,
  type TextNode,
  type TextStyle,
} from '@shiba/core';
import type { TextToggle } from '@shiba/editor';
import { useEditorState } from '../editor/context';
import { ColorField, IconButton, NumberField } from '../ui/controls';
import type { PanelProps } from './registry';

const ALIGN: { align: TextAlign; icon: LucideIcon; labelKey: string }[] = [
  { align: 'left', icon: TextAlignStart, labelKey: 'text.alignLeft' },
  { align: 'center', icon: TextAlignCenter, labelKey: 'text.alignCenter' },
  { align: 'right', icon: TextAlignEnd, labelKey: 'text.alignRight' },
  { align: 'justify', icon: TextAlignJustify, labelKey: 'text.alignJustify' },
];

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** 快捷键在当前系统上的写法 */
function shortcut(key: string, shift = false): string {
  return IS_MAC ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

const TOGGLES: { key: TextToggle; icon: LucideIcon; labelKey: string; shortcut: string }[] = [
  { key: 'bold', icon: Bold, labelKey: 'text.bold', shortcut: shortcut('B') },
  { key: 'italic', icon: Italic, labelKey: 'text.italic', shortcut: shortcut('I') },
  { key: 'underline', icon: Underline, labelKey: 'text.underline', shortcut: shortcut('U') },
  { key: 'strikethrough', icon: Strikethrough, labelKey: 'text.strikethrough', shortcut: shortcut('X', true) },
];

const SIZING: TextNode['sizing'][] = ['auto', 'fixed'];
const MIXED = '';

/**
 * 文本属性。
 * 字体、字号、粗细、斜体、下划线、删除线、颜色、字距可以按字设置：编辑文字时改的是选中的那几个字
 * （没选中时是接下来要打的字），没在编辑时改选中文本的全部文字。行高、对齐、宽度模式是整段的。
 * 范围里不一致的项显示为空白。多选时显示第一个文本的值，修改作用于选中的全部文本。
 */
export function TextPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const editing = useEditorState((s) => s.textEditing);
  const sealHistory = useCallback(() => editor.store.sealHistory(), [editor]);
  const first = nodes.find((n): n is TextNode => n.type === 'text');
  if (!first) return null;

  const target = editing?.nodeId === first.id ? editing : null;
  const caret = target !== null && target.start === target.end && first.text.length > 0;
  const { style, mixed } =
    target?.typing && caret
      ? { style: target.typing, mixed: new Set<keyof CharacterStyle>() }
      : target
        ? rangeStyle(first, target.start, target.end)
        : rangeStyle(first, 0, first.text.length);
  const families = editor.fonts.familyNames();

  const setChars = (patch: Partial<CharacterStyle>, options: { mergeKey?: string; refocus?: boolean } = {}): void => {
    editor.commands.run('text.style', { patch, ...options });
  };
  const update = (label: string, patch: (node: TextNode) => Partial<TextNode>): void => {
    editor.updateSelection(label, (node) => (node.type === 'text' ? patch(node) : null));
    editor.store.sealHistory();
  };
  const setParagraph = (patch: Partial<TextStyle>): void =>
    update('text style', (node) => ({ style: { ...node.style, ...patch } }));

  const active = (key: TextToggle): boolean => {
    if (key === 'bold') return style.fontWeight >= 600 && !mixed.has('fontWeight');
    return style[key] && !mixed.has(key);
  };

  const fontSelect = (slot: 'latin' | 'cjk', label: string): ReactNode => (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <div className="prop-controls">
        <select
          className="select"
          aria-label={label}
          value={mixed.has('fontFamily') ? MIXED : style.fontFamily[slot]}
          onChange={(e) => {
            if (e.target.value) setChars({ fontFamily: { ...style.fontFamily, [slot]: e.target.value } });
          }}
        >
          {mixed.has('fontFamily') && <option value={MIXED}>—</option>}
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
      {target && (
        <p className="menu-hint text-scope">
          {t(target.start < target.end ? 'text.scopeSelection' : caret ? 'text.scopeCaret' : 'text.scopeAll')}
        </p>
      )}
      {fontSelect('latin', t('text.fontLatin'))}
      {fontSelect('cjk', t('text.fontCjk'))}

      <div className="prop-row">
        <span className="prop-label">{t('text.size')}</span>
        <div className="prop-controls">
          <NumberField
            label=""
            value={style.fontSize}
            mixed={mixed.has('fontSize')}
            min={1}
            max={2000}
            onCommit={(v) => setChars({ fontSize: v })}
          />
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.decoration')}</span>
        <div className="prop-controls button-row">
          {TOGGLES.map(({ key, icon: Icon, labelKey, shortcut: keys }) => (
            <IconButton
              key={key}
              title={`${t(labelKey)} (${keys})`}
              active={active(key)}
              onClick={() => editor.commands.run('text.toggle', key)}
            >
              <Icon size={15} />
            </IconButton>
          ))}
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.color')}</span>
        <div className="prop-controls">
          <ColorField
            label={t('text.color')}
            value={style.color ?? rgba(0, 0, 0)}
            onChange={(color) => setChars({ color }, { mergeKey: 'text-color' })}
            onCommit={sealHistory}
          />
          {mixed.has('color') && <span className="field-note">{t('text.mixed')}</span>}
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.letterSpacing')}</span>
        <div className="prop-controls">
          <NumberField
            label=""
            value={style.letterSpacing}
            mixed={mixed.has('letterSpacing')}
            min={-100}
            max={500}
            onCommit={(v) => setChars({ letterSpacing: v })}
          />
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.lineHeight')}</span>
        <div className="prop-controls">
          <NumberField
            label=""
            value={first.style.lineHeight}
            min={0.5}
            max={10}
            onCommit={(v) => setParagraph({ lineHeight: v })}
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
