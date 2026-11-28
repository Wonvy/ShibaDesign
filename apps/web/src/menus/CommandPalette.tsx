import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { slides } from '@shiba/core';
import { useEditor } from '../editor/context';
import { i18n } from '../i18n';
import { displayName } from '../names';
import { formatShortcut } from '../ui/shortcut';
import { selectionContext } from './context';
import { MENU_BAR } from './definitions';
import { buildMenu, resolveItem, runItem, type MenuContext, type MenuEntry, type MenuItemDef } from './model';
import { openOverlay } from './overlays';

interface PaletteItem {
  key: string;
  /** "对象 › 层序 › 置于顶层" */
  path: string;
  /** 搜索用：当前语言和英文的名字连在一起 */
  haystack: string;
  shortcut?: string;
  enabled: boolean;
  run: () => void;
}

const MAX_RESULTS = 60;

/** 把菜单栏的每一栏摊平成一条条命令，子菜单的路径写在名字前面 */
type Translate = (key: string, args: Record<string, unknown>) => string;

function collect(ctx: MenuContext, translate: Translate): PaletteItem[] {
  const fixed = i18n.getFixedT('en');
  const en: Translate = (key, args) => fixed(key, args);
  const out: PaletteItem[] = [];
  const seen = new Set<string>();
  const walk = (entries: MenuEntry[], path: string[], enPath: string[]): void => {
    for (const entry of entries) {
      if (entry === 'separator') continue;
      const def: MenuItemDef = entry;
      const label = def.label ?? translate(def.labelKey, def.labelArgs ?? {});
      const enLabel = def.label ?? en(def.labelKey, def.labelArgs ?? {});
      if (def.submenu) {
        walk(def.submenu(ctx), [...path, label], [...enPath, enLabel]);
        continue;
      }
      const key = def.command ? `${def.command}:${JSON.stringify(def.args)}` : def.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = resolveItem(def, ctx);
      out.push({
        key,
        path: [...path, label].join(' › '),
        haystack: `${[...path, label].join(' ')} ${[...enPath, enLabel].join(' ')}`.toLowerCase(),
        shortcut: resolved.shortcut,
        enabled: resolved.enabled,
        run: () => runItem(def, ctx),
      });
    }
  };
  for (const bar of MENU_BAR) walk(buildMenu(bar.id, ctx), [translate(bar.labelKey, {})], [en(bar.labelKey, {})]);
  return out;
}

/**
 * 命令面板（⌘K）：输入就过滤所有菜单命令（中文、英文名字都认），还能跳到某个图层、某一页。回车执行
 */
export function CommandPalette(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const ctx = useMemo(() => selectionContext(editor), [editor]);
  const commands = useMemo(() => collect(ctx, (key, args) => t(key, args)), [ctx, t]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (text: string): boolean => words.every((w) => text.includes(w));
    const items = commands.filter((c) => match(c.haystack));
    if (words.length > 0) {
      // 图层和幻灯片：名字里有这几个字的
      for (const [i, slide] of slides(editor.store).entries()) {
        const label = t('menu.goToSlide', { n: i + 1, name: displayName(slide, t) });
        if (match(label.toLowerCase())) {
          items.push({
            key: `slide:${slide.id}`,
            path: label,
            haystack: '',
            enabled: true,
            run: () => editor.reveal(slide.id),
          });
        }
      }
      for (const node of editor.selectableNodes()) {
        const name = displayName(node, t, editor.store);
        if (!match(name.toLowerCase())) continue;
        items.push({
          key: `node:${node.id}`,
          path: t('menu.goToLayer', { name }),
          haystack: '',
          enabled: true,
          run: () => editor.reveal(node.id),
        });
      }
    }
    // 能执行的排前面
    return items.sort((a, b) => Number(b.enabled) - Number(a.enabled)).slice(0, MAX_RESULTS);
  }, [commands, query, editor, t]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [query]);

  const close = (): void => openOverlay(null);
  const run = (item: PaletteItem | undefined): void => {
    if (!item?.enabled) return;
    close();
    item.run();
  };

  return (
    <div
      className="dialog-backdrop palette-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('menu.commandPalette')}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') close();
          else if (event.key === 'ArrowDown') setActive((i) => Math.min(results.length - 1, i + 1));
          else if (event.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
          else if (event.key === 'Enter') run(results[active]);
          else return;
          event.preventDefault();
        }}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={t('menu.paletteHint')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('menu.commandPalette')}
        />
        <div className="palette-list" role="listbox">
          {results.length === 0 && <p className="empty-note">{t('menu.paletteEmpty')}</p>}
          {results.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`palette-item${index === active ? ' is-active' : ''}`}
              disabled={!item.enabled}
              onMouseEnter={() => setActive(index)}
              onClick={() => run(item)}
            >
              <span className="palette-label">{item.path}</span>
              {item.shortcut && <span className="menu-shortcut">{formatShortcut(item.shortcut)}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
