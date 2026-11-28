import { Download, Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EXPORT_FORMATS, EXPORT_SCALES, type ExportSetting } from '@shiba/core';
import { exportBySettings } from '../files';
import { IconButton } from '../ui/controls';
import type { PanelProps } from './registry';

/**
 * 导出设置：一个对象上记几条"导出成什么"（倍率、格式、后缀），存进文档；"导出"按钮马上按这几条导出选中的对象，
 * 文件菜单的"导出全部"导出文档里所有设置了的。几个对象一起选中时显示第一个的，改了统一成这一套。PDF 只对画板
 */
export function ExportPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const first = nodes[0];
  if (!first) return null;
  const settings = first.exports ?? [];
  const boardsOnly = nodes.every((n) => n.type === 'artboard');
  const write = (next: readonly ExportSetting[]): void => {
    editor.updateSelection('export settings', () => ({ exports: next.length > 0 ? next : undefined }));
    editor.store.sealHistory();
  };
  const update = (index: number, patch: Partial<ExportSetting>): void =>
    write(settings.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  return (
    <div className="export-settings">
      {settings.map((setting, index) => (
        <div className="export-row" key={index}>
          <select
            className="select"
            aria-label={t('export.scale')}
            value={setting.scale}
            disabled={setting.format === 'svg' || setting.format === 'pdf'}
            onChange={(event) => update(index, { scale: Number(event.target.value) })}
          >
            {EXPORT_SCALES.map((scale) => (
              <option key={scale} value={scale}>
                {scale}x
              </option>
            ))}
          </select>
          <input
            className="field-input export-suffix"
            aria-label={t('export.suffix')}
            title={t('export.suffixHint')}
            placeholder={t('export.suffix')}
            defaultValue={setting.suffix ?? ''}
            key={`${index}-${setting.suffix ?? ''}`}
            onBlur={(event) => {
              const text = event.target.value;
              const { suffix: _old, ...rest } = setting;
              write(settings.map((s, i) => (i === index ? (text ? { ...setting, suffix: text } : rest) : s)));
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <select
            className="select"
            aria-label={t('export.format')}
            value={setting.format}
            onChange={(event) => update(index, { format: event.target.value as ExportSetting['format'] })}
          >
            {EXPORT_FORMATS.filter((f) => f !== 'pdf' || boardsOnly || setting.format === 'pdf').map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
          <IconButton title={t('prop.remove')} onClick={() => write(settings.filter((_, i) => i !== index))}>
            <Minus size={14} />
          </IconButton>
        </div>
      ))}
      <div className="export-actions">
        <button
          type="button"
          className="effect-add"
          onClick={() => {
            // 再加一条时倍率往上加一档（1x → 2x → 3x），和设计软件一样
            const last = settings.at(-1);
            const scale = !last ? 1 : last.scale < 1 ? 1 : Math.min(4, Math.floor(last.scale) + 1);
            write([...settings, { scale, format: last?.format ?? 'png' }]);
          }}
        >
          <Plus size={14} />
          {t('export.add')}
        </button>
        {settings.length > 0 && (
          <button type="button" className="text-btn" onClick={() => void exportBySettings(editor, editor.selection)}>
            <Download size={14} />
            {t('export.run')}
          </button>
        )}
      </div>
    </div>
  );
}
