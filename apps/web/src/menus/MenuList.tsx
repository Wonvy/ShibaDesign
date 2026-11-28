import { ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatShortcut } from '../ui/shortcut';
import { resolveItem, runItem, tidy, type MenuContext, type MenuEntry, type ResolvedItem } from './model';

/** 悬停多久打开子菜单 */
const SUBMENU_DELAY = 150;

/**
 * 一层菜单：右键菜单、菜单栏的下拉、子菜单都用它。
 * 键盘：↑↓ 移动，→ 打开子菜单，← 关掉子菜单，回车或空格执行，Esc 关一层，打字母跳到以它开头的项。
 * 子菜单悬停一会儿才打开、才换，鼠标斜着往子菜单移动、路过别的项时不会把它关掉
 */
export function MenuList(props: {
  entries: readonly MenuEntry[];
  ctx: MenuContext;
  /** 执行了某一项，或者在最外层按了 Esc：关掉整个菜单 */
  onDone: () => void;
  /** 这一层按 ← 或 Esc：回到上一层（最外层没有） */
  onBack?: () => void;
  /** 打开时把焦点放在第一项上（键盘打开、子菜单用键盘打开时） */
  autoFocus?: boolean;
  className?: string;
  style?: React.CSSProperties;
}): ReactNode {
  const { t } = useTranslation();
  const { ctx } = props;
  const items = useMemo(
    () => tidy(props.entries).map((entry) => (entry === 'separator' ? entry : resolveItem(entry, ctx))),
    [props.entries, ctx],
  );
  const [open, setOpen] = useState<{ index: number; focus: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    // 用键盘打开的：焦点放在第一项上；用鼠标打开的：焦点放在菜单上，按 ↓ 就到第一项
    if (props.autoFocus) focusAt(0, 1);
    else rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      ctx.editor.setHover(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const labelOf = (item: ResolvedItem): string => item.def.label ?? t(item.def.labelKey, item.def.labelArgs ?? {});

  /** 从 start 开始按 step 方向找下一个能点的项，把焦点放上去 */
  const focusAt = (start: number, step: 1 | -1): void => {
    const count = items.length;
    for (let i = 0; i < count; i++) {
      const index = (((start + i * step) % count) + count) % count;
      const item = items[index];
      if (item && item !== 'separator' && item.enabled) {
        buttons.current[index]?.focus();
        return;
      }
    }
  };

  const currentIndex = (): number => buttons.current.findIndex((b) => b === document.activeElement);

  const schedule = (next: { index: number; focus: boolean } | null): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), SUBMENU_DELAY);
  };

  const activate = (index: number, viaKeyboard: boolean): void => {
    const item = items[index];
    if (!item || item === 'separator' || !item.enabled) return;
    if (item.def.submenu) {
      if (timer.current) clearTimeout(timer.current);
      setOpen({ index, focus: viaKeyboard });
      return;
    }
    props.onDone();
    runItem(item.def, ctx);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // 子菜单里的按键由子菜单处理
    if (event.target !== rootRef.current && !buttons.current.some((b) => b === event.target)) return;
    const index = currentIndex();
    if (event.key === 'ArrowDown') focusAt(index + 1, 1);
    else if (event.key === 'ArrowUp') focusAt(index < 0 ? items.length - 1 : index - 1, -1);
    else if (event.key === 'ArrowRight') activate(index, true);
    else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      if (props.onBack) props.onBack();
      else props.onDone();
    } else if (event.key === 'Enter' || event.key === ' ') activate(index, true);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // 跳到下一个以这个字开头的项
      const letter = event.key.toLowerCase();
      for (let i = 1; i <= items.length; i++) {
        const at = (index + i) % items.length;
        const item = items[at];
        if (item && item !== 'separator' && item.enabled && labelOf(item).toLowerCase().startsWith(letter)) {
          buttons.current[at]?.focus();
          break;
        }
      }
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const openItem = open ? items[open.index] : undefined;
  const openEntries = openItem && openItem !== 'separator' && openItem.def.submenu ? openItem.def.submenu(ctx) : null;

  return (
    <div
      ref={rootRef}
      className={`menu-popover menu-list ${props.className ?? ''}`}
      style={props.style}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => {
        if (item === 'separator') return <div key={`sep-${index}`} className="menu-separator" role="separator" />;
        const { def } = item;
        const isOpen = open?.index === index;
        return (
          <div key={def.id} className="menu-row menu-entry">
            <button
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              className={`menu-item${isOpen ? ' is-open' : ''}`}
              role={def.checked ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={def.checked ? item.checked : undefined}
              aria-haspopup={def.submenu ? 'menu' : undefined}
              aria-expanded={def.submenu ? isOpen : undefined}
              aria-disabled={!item.enabled}
              disabled={!item.enabled}
              tabIndex={-1}
              onMouseEnter={() => {
                if (def.hoverNode) ctx.editor.setHover(def.hoverNode);
                schedule(def.submenu && item.enabled ? { index, focus: false } : null);
              }}
              onMouseLeave={() => {
                if (def.hoverNode) ctx.editor.setHover(null);
              }}
              onClick={() => activate(index, false)}
            >
              <span className="menu-check">{item.checked ? '✓' : ''}</span>
              <span className="menu-text">{labelOf(item)}</span>
              {def.submenu ? (
                <ChevronRight size={14} className="menu-chevron" />
              ) : (
                item.shortcut && <span className="menu-shortcut">{formatShortcut(item.shortcut)}</span>
              )}
            </button>
            {isOpen && openEntries && (
              <Submenu
                entries={openEntries}
                ctx={ctx}
                anchor={buttons.current[index] ?? null}
                autoFocus={open.focus}
                onDone={props.onDone}
                onBack={() => {
                  setOpen(null);
                  buttons.current[index]?.focus();
                }}
                onEnter={() => {
                  // 鼠标进了子菜单：取消路过别的项时排上的切换
                  if (timer.current) clearTimeout(timer.current);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 子菜单：放在那一项的右边，右边放不下时放左边；比窗口还矮时往上挪 */
function Submenu(props: {
  entries: readonly MenuEntry[];
  ctx: MenuContext;
  anchor: HTMLElement | null;
  autoFocus: boolean;
  onDone: () => void;
  onBack: () => void;
  onEnter: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden', position: 'fixed' });

  useLayoutEffect(() => {
    const anchor = props.anchor?.getBoundingClientRect();
    const box = ref.current?.getBoundingClientRect();
    if (!anchor || !box) return;
    const margin = 8;
    let left = anchor.right + 2;
    if (left + box.width > window.innerWidth - margin) left = Math.max(margin, anchor.left - box.width - 2);
    let top = anchor.top - 6;
    if (top + box.height > window.innerHeight - margin)
      top = Math.max(margin, window.innerHeight - margin - box.height);
    setStyle({ position: 'fixed', left, top, maxHeight: window.innerHeight - margin * 2 });
  }, [props.anchor]);

  return (
    <div ref={ref} className="menu-submenu" style={style} onMouseEnter={props.onEnter}>
      <MenuList
        entries={props.entries}
        ctx={props.ctx}
        onDone={props.onDone}
        onBack={props.onBack}
        autoFocus={props.autoFocus}
      />
    </div>
  );
}
