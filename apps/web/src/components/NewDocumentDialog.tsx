import { Download, FileUp, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor } from '../editor/context';
import {
  importTemplateFiles,
  newBlankDocument,
  newFromBuiltin,
  newFromUserTemplate,
  exportUserTemplate,
} from '../files';
import { BUILTIN_TEMPLATES, type TemplateDef } from '../templates/builtin';
import {
  MAX_TEMPLATE_NAME,
  deleteTemplate,
  listTemplates,
  renameTemplate,
  subscribeTemplates,
  type TemplateMeta,
} from '../templates/library';
import { BLANK_PRESETS, type BlankPreset } from '../templates/presets';
import { documentThumbnail } from '../templates/preview';

const PREVIEW_SIZE = 360;

/** 内置模板的预览图，按模板和语言缓存（示例文字跟着语言变），关掉对话框再打开不用重画 */
const previewCache = new Map<string, Promise<string | null>>();

function useBuiltinPreview(template: TemplateDef): string | null {
  const editor = useEditor();
  const { t, i18n } = useTranslation();
  const key = `${template.id}:${i18n.language}`;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let pending = previewCache.get(key);
    if (!pending) {
      pending = documentThumbnail(editor.ck, template.build(t), [], PREVIEW_SIZE)
        .then((blob) => (blob ? URL.createObjectURL(blob) : null))
        .catch((error: unknown) => {
          console.error(error);
          return null;
        });
      previewCache.set(key, pending);
    }
    void pending.then((value) => alive && setUrl(value));
    return () => {
      alive = false;
    };
  }, [editor, key, template, t]);
  return url;
}

/** 一张 Blob 缩略图的临时地址，组件卸载时释放 */
function useBlobUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  return url;
}

/** 空白尺寸的卡片：按比例画一个框 */
function PresetCard(props: { preset: BlankPreset; onPick: () => void }): ReactNode {
  const { t } = useTranslation();
  const { preset } = props;
  const [w, h] = preset.size;
  const scale = 56 / Math.max(w, h);
  return (
    <button type="button" className="template-card preset-card" onClick={props.onPick}>
      <span className="preset-frame">
        <span style={{ width: Math.round(w * scale), height: Math.round(h * scale) }} />
      </span>
      <span className="template-name">{t(`template.preset.${preset.id}`)}</span>
      <span className="template-hint">
        {w} × {h}
      </span>
    </button>
  );
}

function BuiltinCard(props: { template: TemplateDef; onPick: () => void }): ReactNode {
  const { t } = useTranslation();
  const url = useBuiltinPreview(props.template);
  const { id } = props.template;
  return (
    <button type="button" className="template-card" onClick={props.onPick}>
      <span className="template-thumb">{url ? <img src={url} alt="" /> : <span className="template-loading" />}</span>
      <span className="template-name">{t(`template.builtin.${id}`)}</span>
      <span className="template-hint">{t(`template.builtin.${id}Hint`)}</span>
    </button>
  );
}

function UserCard(props: { template: TemplateMeta; onPick: () => void }): ReactNode {
  const { t } = useTranslation();
  const { template } = props;
  const url = useBlobUrl(template.thumbnail);
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="template-card user-card">
      <button type="button" className="template-thumb" aria-label={template.name} onClick={props.onPick}>
        {url ? <img src={url} alt="" /> : <span className="template-loading is-empty" />}
      </button>
      {renaming ? (
        <input
          className="field-input"
          defaultValue={template.name}
          maxLength={MAX_TEMPLATE_NAME}
          autoFocus
          aria-label={t('template.rename')}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            setRenaming(false);
            const name = e.target.value.trim();
            if (name && name !== template.name) void renameTemplate(template.id, name);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="template-name template-name-btn"
          title={t('template.rename')}
          onDoubleClick={() => setRenaming(true)}
          onClick={props.onPick}
        >
          {template.name}
        </button>
      )}
      <span className="template-actions">
        <span className="template-hint">
          {template.slides > 0 ? t('template.slideCount', { count: template.slides }) : t('template.design')}
        </span>
        <button
          type="button"
          className="icon-btn"
          title={t('template.export')}
          aria-label={`${t('template.export')}: ${template.name}`}
          onClick={() => void exportUserTemplate(template)}
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t('template.delete')}
          aria-label={`${t('template.delete')}: ${template.name}`}
          onClick={() => {
            if (window.confirm(t('template.deleteConfirm', { name: template.name }))) void deleteTemplate(template.id);
          }}
        >
          <Trash2 size={14} />
        </button>
      </span>
    </div>
  );
}

/**
 * 新建：空白尺寸、内置模板、我的模板。选一个就换成新文档（当前文档有没保存的修改时先问）。
 * 我的模板可以改名（双击名字）、导出成 .shiba 文件、删除，也可以导入 .shiba 文件当模板
 */
export function NewDocumentDialog(props: { onClose: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const { onClose } = props;
  const [mine, setMine] = useState<TemplateMeta[] | null>(null);
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // 焦点放进对话框：Esc 才能关掉它，按键也不会传到画布的快捷键
  useEffect(() => panelRef.current?.focus(), []);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      listTemplates()
        .then((list) => alive && setMine(list))
        .catch((error: unknown) => {
          console.error(error);
          if (alive) setFailed(true);
        });
    };
    load();
    const unsubscribe = subscribeTemplates(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const finish = (created: boolean): void => {
    if (created) onClose();
  };

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="dialog gallery"
        role="dialog"
        aria-modal="true"
        aria-label={t('template.title')}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="gallery-header">
          <h2 className="dialog-title">{t('template.title')}</h2>
          <button
            type="button"
            className="icon-btn"
            title={t('template.close')}
            aria-label={t('template.close')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <h3 className="gallery-heading">{t('template.blank')}</h3>
        <div className="template-grid presets">
          {BLANK_PRESETS.filter((p) => !p.group).map((preset) => (
            <PresetCard key={preset.id} preset={preset} onPick={() => finish(newBlankDocument(editor, preset))} />
          ))}
        </div>

        <h3 className="gallery-heading">{t('template.uiTitle')}</h3>
        <div className="template-grid presets">
          {BLANK_PRESETS.filter((p) => p.group === 'ui').map((preset) => (
            <PresetCard key={preset.id} preset={preset} onPick={() => finish(newBlankDocument(editor, preset))} />
          ))}
        </div>

        <h3 className="gallery-heading">{t('template.builtinTitle')}</h3>
        <div className="template-grid">
          {BUILTIN_TEMPLATES.map((template) => (
            <BuiltinCard
              key={template.id}
              template={template}
              onPick={() => finish(newFromBuiltin(editor, template))}
            />
          ))}
        </div>

        <h3 className="gallery-heading">
          {t('template.mine')}
          <button type="button" className="text-btn action-btn" onClick={() => void importTemplateFiles(editor)}>
            <FileUp size={13} />
            {t('template.import')}
          </button>
        </h3>
        {failed && <p className="empty-note">{t('template.unavailable')}</p>}
        {mine && mine.length === 0 && <p className="empty-note">{t('template.mineEmpty')}</p>}
        {mine && mine.length > 0 && (
          <>
            <div className="template-grid">
              {mine.map((template) => (
                <UserCard
                  key={template.id}
                  template={template}
                  onPick={() => void newFromUserTemplate(editor, template).then(finish)}
                />
              ))}
            </div>
            <p className="dialog-hint">{t('template.backupHint')}</p>
          </>
        )}
      </div>
    </div>
  );
}
