import { Menu as MenuIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor } from '../editor/context';
import { selectionContext } from './context';
import { MENU_BAR } from './definitions';
import { buildMenu, type MenuContext, type MenuEntry } from './model';
import { MenuList } from './MenuList';

/**
 * 顶部菜单栏：文件、编辑、对象、文字、视图、帮助。窗口窄时收进一个按钮，每一栏变成子菜单。
 * 打开一栏以后，鼠标移到别的栏上直接切过去（和系统菜单栏一样）
 */
export function MenuBar(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const [ctx, setCtx] = useState<MenuContext | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);

  const show = (id: string | null, viaKeyboard = false): void => {
    keyboard.current = viaKeyboard;
    setOpen(id);
    setCtx(id ? selectionContext(editor) : null);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('.menu-list')) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', () => setOpen(null), { once: true });
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  /** 窄窗口时的那个按钮：每一栏是一个子菜单 */
  const compactEntries = (): MenuEntry[] =>
    MENU_BAR.map((bar) => ({ id: bar.id, labelKey: bar.labelKey, submenu: (c: MenuContext) => buildMenu(bar.id, c) }));

  return (
    <div className="menubar" ref={rootRef} role="menubar">
      <div className="menubar-compact">
        <button
          type="button"
          className={`menu-trigger${open === 'compact' ? ' is-active' : ''}`}
          aria-label={t('menu.menu')}
          title={t('menu.menu')}
          aria-haspopup="menu"
          aria-expanded={open === 'compact'}
          onClick={() => show(open === 'compact' ? null : 'compact')}
        >
          <MenuIcon size={16} />
        </button>
        {open === 'compact' && ctx && (
          <MenuList
            entries={compactEntries()}
            ctx={ctx}
            onDone={() => setOpen(null)}
            autoFocus={keyboard.current}
            className="menubar-popover"
          />
        )}
      </div>
      <div className="menubar-full">
        {MENU_BAR.map((bar, index) => (
          <div key={bar.id} className="menubar-item">
            <button
              type="button"
              role="menuitem"
              className={`menubar-button${open === bar.id ? ' is-active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={open === bar.id}
              onClick={() => show(open === bar.id ? null : bar.id)}
              onMouseEnter={() => {
                if (open && open !== bar.id && open !== 'compact') show(bar.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  show(bar.id, true);
                } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  const next =
                    MENU_BAR[(index + (event.key === 'ArrowRight' ? 1 : -1) + MENU_BAR.length) % MENU_BAR.length]!;
                  event.preventDefault();
                  (
                    event.currentTarget.parentElement?.parentElement?.children[MENU_BAR.indexOf(next)]
                      ?.firstElementChild as HTMLElement | null
                  )?.focus();
                  if (open) show(next.id, true);
                }
              }}
            >
              {t(bar.labelKey)}
            </button>
            {open === bar.id && ctx && (
              <MenuList
                entries={buildMenu(bar.id, ctx)}
                ctx={ctx}
                onDone={() => setOpen(null)}
                autoFocus={keyboard.current}
                className="menubar-popover"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
