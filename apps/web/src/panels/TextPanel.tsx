import {
  Bold,
  Italic,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
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
  MAX_LIST_LEVEL,
  hasLiveAppearance,
  rangeParagraphStyle,
  rangeStyle,
  rgba,
  type CharacterStyle,
  type ListKind,
  type ParagraphOverride,
  type TextAlign,
  type TextNode,
  type TextStyle,
} from '@shiba/core';
import type { TextToggle } from '@shiba/editor';
import { useEditorState } from '../editor/context';
import { ColorField, IconButton, NumberField } from '../ui/controls';
import type { PanelProps } from './registry';
import { ColorStyleField, TextStyleRow } from './StylePickers';

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

const LISTS: { kind: ListKind; icon: LucideIcon; labelKey: string }[] = [
  { kind: 'bullet', icon: List, labelKey: 'text.bullets' },
  { kind: 'number', icon: ListOrdered, labelKey: 'text.numbering' },
];

const SIZING: TextNode['sizing'][] = ['auto', 'fixed'];
const MIXED = '';

/**
 * 文本属性。
 * 字体、字号、粗细、斜体、下划线、删除线、颜色、字距可以按字设置：编辑文字时改的是选中的那几个字
 * （没选中时是接下来要打的字），没在编辑时改选中文本的全部文字。
 * 对齐、列表、缩进、段距按段落设置：编辑时改选区碰到的那几段（没选中时是光标所在的一段），没在编辑时改全部段落。
 * 行高、宽度模式是整个文本的。范围里不一致的项显示为空白。多选时显示第一个文本的值，修改作用于选中的全部文本。
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
  const paragraph = target
    ? rangeParagraphStyle(first, target.start, target.end)
    : rangeParagraphStyle(first, 0, first.text.length);
  const setParagraphs = (patch: ParagraphOverride): void => {
    editor.commands.run('text.paragraph', { patch, refocus: true });
  };
  const listOn = (kind: ListKind): boolean => paragraph.style.list === kind && !paragraph.mixed.has('list');
  const inList = paragraph.style.list !== null && !paragraph.mixed.has('list');
  const lengthField = (
    key: 'indent' | 'firstLine' | 'spaceBefore' | 'spaceAfter',
    labelKey: string,
    disabled = false,
  ): ReactNode => (
    <NumberField
      label={t(labelKey)}
      value={paragraph.style[key]}
      mixed={paragraph.mixed.has(key)}
      min={0}
      max={10000}
      disabled={disabled}
      onCommit={(v) => editor.commands.run('text.paragraph', { patch: { [key]: v } })}
    />
  );

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
      <TextStyleRow editor={editor} node={first} />
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
          <ColorStyleField
            editor={editor}
            target="fill"
            label={t('text.color')}
            value={style.color ?? rgba(0, 0, 0)}
            // 颜色样式管的是整段的颜色：在改一部分字时显示这几个字自己的颜色
            linked={target ? undefined : first.fill?.colorStyle}
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

      <p className="menu-hint text-scope">
        {t(
          target
            ? target.start < target.end
              ? 'text.paragraphScopeSelection'
              : 'text.paragraphScopeCaret'
            : 'text.paragraphScopeAll',
        )}
      </p>

      <div className="prop-row">
        <span className="prop-label">{t('text.align')}</span>
        <div className="prop-controls button-row">
          {ALIGN.map(({ align, icon: Icon, labelKey }) => (
            <IconButton
              key={align}
              title={t(labelKey)}
              active={paragraph.style.align === align && !paragraph.mixed.has('align')}
              onClick={() => setParagraphs({ align })}
            >
              <Icon size={15} />
            </IconButton>
          ))}
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.list')}</span>
        <div className="prop-controls button-row">
          {LISTS.map(({ kind, icon: Icon, labelKey }) => (
            <IconButton
              key={kind}
              title={t(labelKey)}
              active={listOn(kind)}
              onClick={() => editor.commands.run('text.list', kind)}
            >
              <Icon size={15} />
            </IconButton>
          ))}
          <span className="row-divider" />
          <IconButton
            title={`${t('text.outdent')} (⇧Tab)`}
            disabled={!inList || paragraph.style.level <= 0}
            onClick={() => editor.commands.run('text.listLevel', -1)}
          >
            <ListIndentDecrease size={15} />
          </IconButton>
          <IconButton
            title={`${t('text.indentMore')} (Tab)`}
            disabled={!inList || paragraph.style.level >= MAX_LIST_LEVEL}
            onClick={() => editor.commands.run('text.listLevel', 1)}
          >
            <ListIndentIncrease size={15} />
          </IconButton>
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('text.indent')}</span>
        <div className="prop-controls field-grid">
          {lengthField('indent', 'text.indentLeft')}
          {lengthField('firstLine', 'text.firstLine', inList)}
        </div>
      </div>
      {!inList && (
        <div className="prop-row">
          <span className="prop-label" />
          <div className="prop-controls">
            <button
              type="button"
              className="text-btn text-btn-small"
              onClick={() => setParagraphs({ firstLine: style.fontSize * 2 })}
            >
              {t('text.firstLineTwo')}
            </button>
          </div>
        </div>
      )}

      <div className="prop-row">
        <span className="prop-label">{t('text.spacing')}</span>
        <div className="prop-controls field-grid">
          {lengthField('spaceBefore', 'text.spaceBefore')}
          {lengthField('spaceAfter', 'text.spaceAfter')}
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
