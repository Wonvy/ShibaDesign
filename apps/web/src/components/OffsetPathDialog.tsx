import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { STROKE_JOINS, type StrokeJoin } from '@shiba/core';
import type { OffsetPathArgs } from '@shiba/editor';
import { useEditor } from '../editor/context';
import { Dialog } from '../ui/Dialog';

/** 上次用的距离和拐角记在浏览器里，下次打开还是它 */
const STORAGE_KEY = 'shiba.offsetPath';
const DEFAULTS: OffsetPathArgs = { distance: 10, join: 'miter' };
const JOIN_LABELS: Record<StrokeJoin, string> = {
  miter: 'prop.joinMiter',
  round: 'prop.joinRound',
  bevel: 'prop.joinBevel',
};

function load(): OffsetPathArgs {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<OffsetPathArgs> | null;
    const distance = saved?.distance;
    return {
      distance:
        typeof distance === 'number' && Number.isFinite(distance) && distance !== 0 ? distance : DEFAULTS.distance,
      join: STROKE_JOINS.includes(saved?.join as StrokeJoin) ? (saved!.join as StrokeJoin) : DEFAULTS.join,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(args: OffsetPathArgs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(args));
  } catch {
    // 隐私模式下存不了，下次用默认值
  }
}

/** 偏移路径的选项：距离（正数外扩、负数内缩）和拐角 */
export function OffsetPathDialog(props: { onClose: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const { onClose } = props;
  const [args, setArgs] = useState<OffsetPathArgs>(load);
  // 输入框里的草稿：可以暂时是空的或者是负号
  const [draft, setDraft] = useState(String(args.distance));
  const valid = Number.isFinite(args.distance) && args.distance !== 0;

  return (
    <Dialog
      title={t('path.offsetTitle')}
      submitLabel={t('path.apply')}
      cancelLabel={t('path.cancel')}
      onClose={onClose}
      onSubmit={() => {
        if (!valid) return;
        save(args);
        onClose();
        editor.commands.run('path.offset', args);
      }}
    >
      <label className="dialog-row">
        <span className="dialog-option-text">
          <span>{t('path.distance')}</span>
          <span className="dialog-hint">{t('path.distanceHint')}</span>
        </span>
        <span className="field dialog-number">
          <input
            className="field-input"
            type="number"
            step={1}
            value={draft}
            aria-invalid={!valid}
            onChange={(event) => {
              setDraft(event.target.value);
              setArgs((a) => ({ ...a, distance: event.target.valueAsNumber }));
            }}
          />
        </span>
      </label>
      <fieldset className="dialog-field">
        <legend>{t('prop.join')}</legend>
        <div className="segmented segmented-small" role="radiogroup" aria-label={t('prop.join')}>
          {STROKE_JOINS.map((join) => (
            <button
              key={join}
              type="button"
              role="radio"
              aria-checked={args.join === join}
              className={args.join === join ? 'is-active' : ''}
              onClick={() => setArgs((a) => ({ ...a, join }))}
            >
              {t(JOIN_LABELS[join])}
            </button>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
