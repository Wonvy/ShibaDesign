import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { bindingId, keyOf, type KeyOverride } from '@shiba/editor';
import { useEditor } from '../editor/context';
import { saveOverrides } from '../shortcuts';
import { formatShortcut } from '../ui/shortcut';
import { COMMAND_GROUPS, commandGroup, labelKeyFor } from './labels';
import { openOverlay } from './overlays';

interface Row {
  group: string;
  label: string;
  /** 这一行对应的操作；几条名字相同的合在一起（四个方向的微移）时有好几个，这时不能在这里改 */
  ids: { command: string; args?: unknown }[];
  keys: string[];
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/**
 * 快捷键表（?）：按分组列出所有快捷键，名字相同的（比如四个方向的微移）合成一行；可以搜索。
 * 只对应一个操作的行可以改：点快捷键，按下新的组合；退格键去掉；Esc 取消。新的键原来给了别的操作时，
 * 那个操作就没有快捷键了（提示一下）。改过的记在浏览器里，"恢复默认"全部撤回
 */
export function ShortcutSheet(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const groups = useMemo(() => {
    const rows = new Map<string, Row>();
    const ensure = (command: string, args: unknown): Row | null => {
      const labelKey = labelKeyFor(command, args);
      if (!labelKey) return null;
      const label = t(labelKey);
      const group = commandGroup(command);
      // 同一组里名字相同的合成一行（四个方向的微移）；不同组里同名的分开（对象的左对齐和文字的左对齐）
      const key = `${group}|${label}`;
      const row = rows.get(key) ?? { group, label, ids: [], keys: [] };
      if (!row.ids.some((i) => bindingId(i.command, i.args) === bindingId(command, args)))
        row.ids.push({ command, args });
      rows.set(key, row);
      return row;
    };
    // 默认有快捷键的、用户改过的都列出来（去掉了快捷键的也在，可以再设回来）
    for (const b of editor.keymap.defaults()) ensure(b.command, b.args);
    for (const o of editor.keymap.getOverrides()) ensure(o.command, o.args);
    for (const binding of editor.keymap.list()) ensure(binding.command, binding.args)?.keys.push(binding.key);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const visible = [...rows.values()].filter((row) =>
      words.every((w) => `${row.label} ${row.keys.map((k) => formatShortcut(k)).join(' ')}`.toLowerCase().includes(w)),
    );
    return COMMAND_GROUPS.map((group) => ({ group, rows: visible.filter((r) => r.group === group) })).filter(
      (g) => g.rows.length > 0,
    );
    // version：改完快捷键后重新算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, t, query, version]);

  const close = (): void => openOverlay(null);

  /** 把一个操作的快捷键换成 key（null 是去掉）；key 原来给了别的操作时把那个去掉 */
  const assign = (target: { command: string; args?: unknown }, key: string | null): void => {
    const id = bindingId(target.command, target.args);
    let overrides: KeyOverride[] = editor.keymap.getOverrides().filter((o) => bindingId(o.command, o.args) !== id);
    setNote(null);
    if (key) {
      const taken = editor.keymap.bindingFor(key);
      if (taken && bindingId(taken.command, taken.args) !== id) {
        const takenId = bindingId(taken.command, taken.args);
        overrides = overrides.filter((o) => bindingId(o.command, o.args) !== takenId);
        overrides.push({
          command: taken.command,
          ...(taken.args !== undefined ? { args: taken.args } : {}),
          key: null,
        });
        const labelKey = labelKeyFor(taken.command, taken.args);
        if (labelKey) setNote(t('shortcuts.moved', { name: t(labelKey) }));
      }
    }
    overrides.push({ command: target.command, ...(target.args !== undefined ? { args: target.args } : {}), key });
    // 和默认一样的就不用记
    const defaults = editor.keymap.defaults();
    overrides = overrides.filter((o) => {
      const own = defaults.filter((b) => bindingId(b.command, b.args) === bindingId(o.command, o.args));
      return !(own.length === 1 && own[0]!.key === o.key);
    });
    saveOverrides(editor, overrides);
    setVersion((v) => v + 1);
  };

  const onRecordKey = (event: ReactKeyboardEvent, row: Row): void => {
    event.preventDefault();
    event.stopPropagation();
    if (MODIFIERS.has(event.key)) return;
    setRecording(null);
    if (event.key === 'Escape') return;
    const target = row.ids[0]!;
    if (event.key === 'Backspace' || event.key === 'Delete') {
      assign(target, null);
      return;
    }
    assign(target, keyOf(event.nativeEvent));
  };

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="dialog shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('menu.shortcuts')}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape' && !recording) close();
        }}
      >
        <div className="shortcut-head">
          <h2 className="dialog-title">{t('menu.shortcuts')}</h2>
          <input
            className="field-input"
            autoFocus
            placeholder={t('menu.shortcutSearch')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t('menu.shortcutSearch')}
          />
        </div>
        {note && <p className="shortcut-note">{note}</p>}
        <div className="shortcut-groups">
          {groups.map(({ group, rows }) => (
            <section key={group} className="shortcut-group">
              <h3>{t(`menu.group.${group}`)}</h3>
              {rows.map((row) => {
                const rowKey = `${row.group}|${row.label}`;
                const editable = row.ids.length === 1;
                const isRecording = recording === rowKey;
                const keys =
                  row.keys.length > 0 ? (
                    row.keys.map((key) => <kbd key={key}>{formatShortcut(key)}</kbd>)
                  ) : (
                    <kbd>{t('shortcuts.none')}</kbd>
                  );
                return (
                  <div key={rowKey} className="shortcut-row">
                    <span>{row.label}</span>
                    {editable ? (
                      <button
                        type="button"
                        className={`shortcut-keys shortcut-edit${isRecording ? ' is-recording' : ''}`}
                        title={t('shortcuts.edit')}
                        onClick={() => setRecording(isRecording ? null : rowKey)}
                        onKeyDown={(event) => {
                          if (isRecording) onRecordKey(event, row);
                        }}
                        onBlur={() => isRecording && setRecording(null)}
                      >
                        {isRecording ? <kbd>{t('shortcuts.record')}</kbd> : keys}
                      </button>
                    ) : (
                      <span className="shortcut-keys" title={t('shortcuts.merged')}>
                        {keys}
                      </span>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="text-btn"
            disabled={editor.keymap.getOverrides().length === 0}
            onClick={() => {
              saveOverrides(editor, []);
              setNote(null);
              setVersion((v) => v + 1);
            }}
          >
            {t('shortcuts.reset')}
          </button>
          <button type="button" className="text-btn" onClick={close}>
            {t('menu.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
