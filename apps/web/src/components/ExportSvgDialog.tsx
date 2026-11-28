import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor } from '../editor/context';
import { exportSvg, svgExportTargets, type SvgExportChoice } from '../files';
import { Dialog, DialogOption } from '../ui/Dialog';

/** 上次的选择记在浏览器里，下次打开还是它 */
const STORAGE_KEY = 'shiba.svgExport';

/** 记下来的只有画板的范围（当前画板还是全部）和文字的写法；"选中的对象"看打开时有没有选中，不记 */
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
    const previous = loadChoice();
    const scope = choice.scope === 'selection' ? previous.scope : choice.scope;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...choice, scope }));
  } catch {
    // 隐私模式下存不了，下次用默认值
  }
}

/** 导出 SVG 的选项：导出选中的对象还是画板，文字保留成文字还是转成轮廓 */
export function ExportSvgDialog(props: { onClose: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const { onClose } = props;
  const targets = useMemo(() => svgExportTargets(editor), [editor]);
  const [choice, setChoice] = useState<SvgExportChoice>(() => {
    const saved = loadChoice();
    // 选中了对象时多半是想导出它们，和导出 PNG 一样
    if (targets.selection > 0) return { ...saved, scope: 'selection' };
    if (!targets.current) return { ...saved, scope: 'all' };
    if (targets.all <= 1) return { ...saved, scope: 'current' };
    return saved;
  });
  const set = (patch: Partial<SvgExportChoice>): void => setChoice((c) => ({ ...c, ...patch }));

  return (
    <Dialog
      title={t('svgExport.title')}
      submitLabel={t('svgExport.export')}
      cancelLabel={t('svgExport.cancel')}
      onClose={onClose}
      onSubmit={() => {
        saveChoice(choice);
        onClose();
        // 保存位置的对话框只能在用户刚点过按钮时弹出，所以直接在这一下里开始导出
        void exportSvg(editor, choice);
      }}
    >
      <fieldset className="dialog-field">
        <legend>{t('svgExport.scope')}</legend>
        <DialogOption
          name="scope"
          checked={choice.scope === 'selection'}
          onSelect={() => set({ scope: 'selection' })}
          label={
            targets.selection > 0 ? t('svgExport.selection', { count: targets.selection }) : t('svgExport.noSelection')
          }
          hint={t('svgExport.selectionHint')}
          disabled={targets.selection === 0}
        />
        <DialogOption
          name="scope"
          checked={choice.scope === 'current'}
          onSelect={() => set({ scope: 'current' })}
          label={targets.current ? t('svgExport.current', { name: targets.current }) : t('svgExport.noCurrent')}
          disabled={!targets.current}
        />
        <DialogOption
          name="scope"
          checked={choice.scope === 'all'}
          onSelect={() => set({ scope: 'all' })}
          label={t('svgExport.all', { count: targets.all })}
          hint={t('svgExport.allHint')}
          disabled={targets.all === 0}
        />
      </fieldset>
      <fieldset className="dialog-field">
        <legend>{t('svgExport.text')}</legend>
        <DialogOption
          name="text"
          checked={choice.text === 'text'}
          onSelect={() => set({ text: 'text' })}
          label={t('svgExport.asText')}
          hint={t('svgExport.asTextHint')}
        />
        <DialogOption
          name="text"
          checked={choice.text === 'outline'}
          onSelect={() => set({ text: 'outline' })}
          label={t('svgExport.outline')}
          hint={t('svgExport.outlineHint')}
        />
      </fieldset>
    </Dialog>
  );
}
