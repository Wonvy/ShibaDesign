import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor } from '../editor/context';
import { formatShortcut } from '../ui/shortcut';
import { COMMAND_GROUPS, commandGroup, labelKeyFor } from './labels';
import { openOverlay } from './overlays';

/** 快捷键表（?）：按分组列出所有快捷键，名字相同的（比如四个方向的微移）合成一行；可以搜索 */
export function ShortcutSheet(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const rows = new Map<string, { group: string; label: string; keys: string[] }>();
    for (const binding of editor.keymap.list()) {
      const labelKey = labelKeyFor(binding.command, binding.args);
      if (!labelKey) continue;
      const label = t(labelKey);
      const group = commandGroup(binding.command);
      // 同一组里名字相同的合成一行（四个方向的微移）；不同组里同名的分开（对象的左对齐和文字的左对齐）
      const id = `${group}|${label}`;
      const row = rows.get(id) ?? { group, label, keys: [] };
      row.keys.push(formatShortcut(binding.key));
      rows.set(id, row);
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const visible = [...rows.values()].filter((row) =>
      words.every((w) => `${row.label} ${row.keys.join(' ')}`.toLowerCase().includes(w)),
    );
    return COMMAND_GROUPS.map((group) => ({ group, rows: visible.filter((r) => r.group === group) })).filter(
      (g) => g.rows.length > 0,
    );
  }, [editor, t, query]);

  const close = (): void => openOverlay(null);

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
          if (event.key === 'Escape') close();
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
        <div className="shortcut-groups">
          {groups.map(({ group, rows }) => (
            <section key={group} className="shortcut-group">
              <h3>{t(`menu.group.${group}`)}</h3>
              {rows.map((row) => (
                <div key={`${row.group}|${row.label}`} className="shortcut-row">
                  <span>{row.label}</span>
                  <span className="shortcut-keys">
                    {row.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="text-btn" onClick={close}>
            {t('menu.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
