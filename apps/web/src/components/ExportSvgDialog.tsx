import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor } from '../editor/context';
import { exportSvg, svgExportTargets, type SvgExportChoice } from '../files';

/** 上次的选择记在浏览器里，下次打开还是它 */
const STORAGE_KEY = 'shiba.svgExport';

function loadChoice(): SvgExportChoice {
  const fallback: SvgExportChoice = { scope: 'current', text: 'text' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<SvgExportChoice> | null;
    return {
      scope: saved?.scope === 'all' ? 'all' : fallback.scope,
      text: saved?.text === 'outline' ? 'outline' : fallback.text,
    };
  } catch {
    return fallback;
  }
}

function saveChoice(choice: SvgExportChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // 隐私模式下存不了，下次用默认值
  }
}

/** 导出 SVG 的选项：导出哪些画板，文字保留成文字还是转成轮廓 */
export function ExportSvgDialog(props: { onClose: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const { onClose } = props;
  const targets = useMemo(() => svgExportTargets(editor), [editor]);
  const [choice, setChoice] = useState<SvgExportChoice>(() => {
    const saved = loadChoice();
    if (!targets.current) return { ...saved, scope: 'all' };
    if (targets.all <= 1) return { ...saved, scope: 'current' };
    return saved;
  });
  const exportRef = useRef<HTMLButtonElement>(null);

  useEffect(() => exportRef.current?.focus(), []);

  const submit = (): void => {
    saveChoice(choice);
    onClose();
    // 保存位置的对话框只能在用户刚点过按钮时弹出，所以直接在这一下里开始导出
    void exportSvg(editor, choice);
  };

  const option = <K extends keyof SvgExportChoice>(
    key: K,
    value: SvgExportChoice[K],
    label: string,
    hint?: string,
    disabled = false,
  ): ReactNode => (
    <label className={`dialog-option${disabled ? ' is-disabled' : ''}`}>
      <input
        type="radio"
        name={key}
        checked={choice[key] === value}
        disabled={disabled}
        onChange={() => setChoice((c) => ({ ...c, [key]: value }))}
      />
      <span className="dialog-option-text">
        <span>{label}</span>
        {hint && <span className="dialog-hint">{hint}</span>}
      </span>
    </label>
  );

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="svg-export-title"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          // 对话框里的按键不能传到编辑器的快捷键（按 Delete 会删掉画布上的东西）
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
        }}
      >
        <h2 id="svg-export-title" className="dialog-title">
          {t('svgExport.title')}
        </h2>
        <fieldset className="dialog-field">
          <legend>{t('svgExport.scope')}</legend>
          {option(
            'scope',
            'current',
            targets.current ? t('svgExport.current', { name: targets.current }) : t('svgExport.noCurrent'),
            undefined,
            !targets.current,
          )}
          {option(
            'scope',
            'all',
            t('svgExport.all', { count: targets.all }),
            t('svgExport.allHint'),
            targets.all === 0,
          )}
        </fieldset>
        <fieldset className="dialog-field">
          <legend>{t('svgExport.text')}</legend>
          {option('text', 'text', t('svgExport.asText'), t('svgExport.asTextHint'))}
          {option('text', 'outline', t('svgExport.outline'), t('svgExport.outlineHint'))}
        </fieldset>
        <div className="dialog-actions">
          <button type="button" className="text-btn" onClick={onClose}>
            {t('svgExport.cancel')}
          </button>
          <button type="submit" className="text-btn is-primary" ref={exportRef}>
            {t('svgExport.export')}
          </button>
        </div>
      </form>
    </div>
  );
}
