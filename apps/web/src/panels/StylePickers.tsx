import { Palette, Plus, Unlink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { colorStyles, findColorStyle, textStyles, toCssColor, type Color, type TextNode } from '@shiba/core';
import type { ColorTarget, Editor } from '@shiba/editor';
import { ColorField, IconButton } from '../ui/controls';
import { Menu, MenuItem } from '../ui/Menu';

/** 列表里第一个没被用过的名字，比如"颜色 3" */
export function nextStyleName(existing: readonly { name: string }[], make: (n: number) => string): string {
  const names = new Set(existing.map((s) => s.name));
  for (let n = existing.length + 1; ; n++) if (!names.has(make(n))) return make(n);
}

/** 选颜色样式的下拉菜单：套用某个样式，或者用当前的颜色新建一个并链接上 */
function ColorStyleMenu(props: { editor: Editor; target: ColorTarget; linked?: string; color: Color }): ReactNode {
  const { t } = useTranslation();
  const { editor, target } = props;
  const styles = colorStyles(editor.store);
  return (
    <Menu label={t('style.pickColor')} trigger={<Palette size={14} />}>
      {(close) => (
        <>
          {styles.length === 0 && <p className="menu-hint">{t('style.noColors')}</p>}
          {styles.map((style) => (
            <MenuItem
              key={style.id}
              checked={props.linked === style.id}
              onClick={() => {
                close();
                editor.commands.run('style.color.apply', { id: style.id, target });
              }}
            >
              <span className="menu-swatch" style={{ background: toCssColor(style.color) }} />
              {style.name}
            </MenuItem>
          ))}
          <div className="menu-separator" />
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              close();
              editor.commands.run('style.color.add', {
                name: nextStyleName(styles, (n) => t('style.colorName', { n })),
                color: props.color,
                link: target,
              });
            }}
          >
            <span className="menu-check">
              <Plus size={12} />
            </span>
            <span className="menu-text">{t('style.newFromColor')}</span>
          </button>
        </>
      )}
    </Menu>
  );
}

/**
 * 颜色输入，带颜色样式：链接了样式时显示样式的名字和断开按钮，没链接时是普通的颜色输入。
 * 两种情况都可以从菜单里换一个样式或者新建样式。
 */
export function ColorStyleField(props: {
  editor: Editor;
  target: ColorTarget;
  label: string;
  value: Color;
  /** 链接的样式 id */
  linked?: string;
  onChange: (color: Color) => void;
  onCommit: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const { editor, target } = props;
  const style = findColorStyle(editor.store, props.linked);
  if (style) {
    return (
      <>
        <span className="style-chip" title={t('style.linkedTo', { name: style.name })}>
          <span className="menu-swatch" style={{ background: toCssColor(style.color) }} />
          <span className="style-chip-name">{style.name}</span>
        </span>
        <ColorStyleMenu editor={editor} target={target} linked={style.id} color={style.color} />
        <IconButton title={t('style.detach')} onClick={() => editor.commands.run('style.color.detach', { target })}>
          <Unlink size={14} />
        </IconButton>
      </>
    );
  }
  return (
    <>
      <ColorField label={props.label} value={props.value} onChange={props.onChange} onCommit={props.onCommit} />
      <ColorStyleMenu editor={editor} target={target} color={props.value} />
    </>
  );
}

/** 文本面板顶上的文字样式：选一个套用（选"无"断开），或者用这段文字新建一个 */
export function TextStyleRow({ editor, node }: { editor: Editor; node: TextNode }): ReactNode {
  const { t } = useTranslation();
  const styles = textStyles(editor.store);
  const linked = styles.some((s) => s.id === node.textStyle) ? node.textStyle! : '';
  return (
    <div className="prop-row">
      <span className="prop-label">{t('style.textStyle')}</span>
      <div className="prop-controls">
        <select
          className="select"
          aria-label={t('style.textStyle')}
          value={linked}
          onChange={(e) => {
            if (e.target.value) editor.commands.run('style.text.apply', { id: e.target.value });
            else editor.commands.run('style.text.detach');
          }}
        >
          <option value="">{t('style.none')}</option>
          {styles.map((style) => (
            <option key={style.id} value={style.id}>
              {style.name}
            </option>
          ))}
        </select>
        <IconButton
          title={t('style.newFromText')}
          onClick={() =>
            editor.commands.run('style.text.add', {
              name: nextStyleName(styles, (n) => t('style.textName', { n })),
              link: true,
            })
          }
        >
          <Plus size={14} />
        </IconButton>
      </div>
    </div>
  );
}
