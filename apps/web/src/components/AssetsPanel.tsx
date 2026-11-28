import { Crosshair, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  colorStyles,
  components,
  rgba,
  textStyles,
  toHex,
  parseHex,
  type ColorStyleDef,
  type GroupNode,
  type TextStyleDef,
} from '@shiba/core';
import { selectionColor, type Editor } from '@shiba/editor';
import { useEditor, useEditorState, useSelectedNodes } from '../editor/context';
import { openPanelMenu } from '../menus/context';
import { displayName } from '../names';
import { nextStyleName as nextName } from '../panels/StylePickers';

/** 拖组件到画布上时 dataTransfer 里用的类型，CanvasHost 认这个 */
export const COMPONENT_DRAG_TYPE = 'application/x-shiba-component';

const THUMB_SIZE = 72;
const THUMB_DELAY = 150;

/** 主组件的小缩略图 */
function ComponentThumb({ id }: { id: string }): ReactNode {
  const editor = useEditor();
  const version = useEditorState((s) => s.docVersion);
  const resourceEpoch = useEditorState((s) => s.resourceEpoch);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const canvas = ref.current;
      const bitmap = editor.renderThumbnail(id, THUMB_SIZE, THUMB_SIZE);
      if (!canvas || !bitmap) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.putImageData(new ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
    }, THUMB_DELAY);
    return () => clearTimeout(timer);
  }, [editor, id, version, resourceEpoch]);
  return (
    <span className="asset-thumb-box">
      <canvas ref={ref} />
    </span>
  );
}

/** 可以双击改名的名字 */
function EditableName(props: {
  value: string;
  title: string;
  onClick?: () => void;
  onRename: (name: string) => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        className="field-input layer-rename"
        defaultValue={props.value}
        autoFocus
        aria-label={props.title}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => {
          setEditing(false);
          const name = e.target.value.trim();
          if (name && name !== props.value) props.onRename(name);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="layer-main"
      title={props.title}
      onClick={props.onClick}
      onDoubleClick={() => setEditing(true)}
    >
      <span className="layer-name">{props.value}</span>
    </button>
  );
}

/** 色块：点开系统取色器改颜色样式。拖动取色器的整个过程是一步撤销 */
function StyleSwatch({ editor, style }: { editor: Editor; style: ColorStyleDef }): ReactNode {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const [mergeKey] = useState(() => editor.newMergeKey('color-style'));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const seal = (): void => editor.store.sealHistory();
    el.addEventListener('change', seal);
    return () => el.removeEventListener('change', seal);
  }, [editor]);
  return (
    <input
      ref={ref}
      type="color"
      className="color-swatch style-swatch"
      aria-label={`${t('style.editColor')}: ${style.name}`}
      title={t('style.editColor')}
      value={toHex(style.color)}
      onChange={(e) => {
        const parsed = parseHex(e.target.value);
        if (parsed) {
          editor.commands.run('style.color.update', {
            id: style.id,
            color: { ...parsed, a: style.color.a },
            mergeKey,
          });
        }
      }}
    />
  );
}

/** 文字样式的一行说明：字体、字号/行高 */
function textMeta(style: TextStyleDef['style']): string {
  return `${style.fontFamily.latin} · ${style.fontSize}/${style.lineHeight}`;
}

/**
 * 资源：文档里的主组件、颜色样式、文字样式。
 * 单击组件放一个实例到画布中间，也可以拖到画布上；单击样式套用到选中的对象；双击名字改名。
 */
export function AssetsPanel(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const version = useEditorState((s) => s.docVersion);
  const selected = useSelectedNodes();
  const { store } = editor;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mains = useMemo<GroupNode[]>(() => components(store), [store, version]);
  const colors = colorStyles(store);
  const texts = textStyles(store);
  const hasSelection = selected.length > 0;
  const hasText = selected.some((n) => n.type === 'text');

  const rename = (node: GroupNode, name: string): void => {
    store.transact('rename', (tx) => tx.update(node.id, { name }));
    store.sealHistory();
  };

  const addColor = (): void => {
    const name = nextName(colors, (n) => t('style.colorName', { n }));
    const color = selectionColor(editor, 'fill');
    editor.commands.run('style.color.add', {
      name,
      color: color ?? rgba(0.15, 0.39, 0.92),
      link: color ? 'fill' : undefined,
    });
  };

  const addText = (): void => {
    editor.commands.run('style.text.add', { name: nextName(texts, (n) => t('style.textName', { n })), link: true });
  };

  return (
    <div className="panel-body assets" role="tabpanel">
      <section className="asset-section">
        <h3 className="asset-heading">
          {t('component.title')}
          <button
            type="button"
            className="icon-btn"
            title={t('component.create')}
            aria-label={t('component.create')}
            disabled={!editor.commands.canRun('component.create')}
            onClick={() => editor.commands.run('component.create')}
          >
            <Plus size={14} />
          </button>
        </h3>
        {mains.length === 0 && <p className="empty-note">{t('component.empty')}</p>}
        {mains.map((main) => {
          const name = displayName(main, t);
          return (
            <div
              key={main.id}
              className="layer-row asset-row is-component"
              onContextMenu={(event) => openPanelMenu(event, editor, 'asset.component', main.id)}
              draggable
              title={t('component.placeHint')}
              onDragStart={(e) => {
                e.dataTransfer.setData(COMPONENT_DRAG_TYPE, main.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <ComponentThumb id={main.id} />
              <EditableName
                value={name}
                title={t('component.placeHint')}
                onClick={() => editor.commands.run('component.place', { componentId: main.id })}
                onRename={(value) => rename(main, value)}
              />
              <button
                type="button"
                className="layer-eye"
                title={t('component.goToMain')}
                aria-label={`${t('component.goToMain')}: ${name}`}
                onClick={() => editor.reveal(main.id)}
              >
                <Crosshair size={14} />
              </button>
            </div>
          );
        })}
      </section>

      <section className="asset-section">
        <h3 className="asset-heading">
          {t('style.colors')}
          <button
            type="button"
            className="icon-btn"
            title={t('style.addColor')}
            aria-label={t('style.addColor')}
            onClick={addColor}
          >
            <Plus size={14} />
          </button>
        </h3>
        {colors.length === 0 && <p className="empty-note">{t('style.noColors')}</p>}
        {colors.map((style) => (
          <div
            key={style.id}
            className="layer-row asset-row"
            onContextMenu={(event) => openPanelMenu(event, editor, 'asset.colorStyle', style.id)}
          >
            <StyleSwatch editor={editor} style={style} />
            <EditableName
              value={style.name}
              title={hasSelection ? t('style.applyHint') : t('style.renameHint')}
              onClick={() => hasSelection && editor.commands.run('style.color.apply', { id: style.id, target: 'fill' })}
              onRename={(name) => editor.commands.run('style.color.update', { id: style.id, name })}
            />
            <span className="asset-meta">{toHex(style.color).toUpperCase()}</span>
            <button
              type="button"
              className="layer-eye"
              title={t('style.delete')}
              aria-label={`${t('style.delete')}: ${style.name}`}
              onClick={() => editor.commands.run('style.color.remove', { id: style.id })}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </section>

      <section className="asset-section">
        <h3 className="asset-heading">
          {t('style.texts')}
          <button
            type="button"
            className="icon-btn"
            title={hasText ? t('style.addText') : t('style.addTextHint')}
            aria-label={t('style.addText')}
            disabled={!hasText}
            onClick={addText}
          >
            <Plus size={14} />
          </button>
        </h3>
        {texts.length === 0 && <p className="empty-note">{t('style.noTexts')}</p>}
        {texts.map((style) => (
          <div
            key={style.id}
            className="layer-row asset-row text-style-row"
            onContextMenu={(event) => openPanelMenu(event, editor, 'asset.textStyle', style.id)}
          >
            <span
              className="text-style-sample"
              aria-hidden="true"
              style={{
                fontWeight: style.style.fontWeight,
                fontStyle: style.style.italic ? 'italic' : undefined,
              }}
            >
              Aa
            </span>
            <EditableName
              value={style.name}
              title={hasText ? t('style.applyHint') : t('style.renameHint')}
              onClick={() => hasText && editor.commands.run('style.text.apply', { id: style.id })}
              onRename={(name) => editor.commands.run('style.text.update', { id: style.id, name })}
            />
            <span className="asset-meta">{textMeta(style.style)}</span>
            <button
              type="button"
              className="layer-eye"
              title={t('style.redefine')}
              aria-label={`${t('style.redefine')}: ${style.name}`}
              disabled={!hasText}
              onClick={() => editor.commands.run('style.text.redefine', { id: style.id })}
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              className="layer-eye"
              title={t('style.delete')}
              aria-label={`${t('style.delete')}: ${style.name}`}
              onClick={() => editor.commands.run('style.text.remove', { id: style.id })}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
