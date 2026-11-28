import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { buildMenu } from './model';
import { MenuList } from './MenuList';
import { closeContextMenu, useContextMenu } from './overlays';

/**
 * 右键菜单。贴着鼠标弹出，超出窗口时翻到另一边；点外面、按 Esc、滚动、窗口失去焦点时关掉。
 * 整个界面只有一个，放在 App 里
 */
export function ContextMenuHost(): ReactNode {
  const menu = useContextMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    setPosition(null);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || position) return;
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 8;
    let left = menu.x;
    let top = menu.y;
    if (left + box.width > window.innerWidth - margin) left = Math.max(margin, menu.x - box.width);
    if (top + box.height > window.innerHeight - margin)
      top = Math.max(margin, window.innerHeight - margin - box.height);
    setPosition({ left, top });
  }, [menu, position]);

  useEffect(() => {
    if (!menu) return;
    // 关掉菜单时把焦点还给原来的地方（通常是画布），快捷键接着能用；执行的命令把焦点挪到了别处（改名框）时不管
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('.menu-list')) return;
      closeContextMenu();
    };
    const close = (): void => closeContextMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
      if (previous && (document.activeElement === document.body || !document.activeElement)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [menu]);

  if (!menu) return null;
  const entries = buildMenu(menu.menuId, menu.ctx);
  if (entries.length === 0) return null;
  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        position: 'fixed',
        left: position?.left ?? menu.x,
        top: position?.top ?? menu.y,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <MenuList
        entries={entries}
        ctx={menu.ctx}
        onDone={closeContextMenu}
        autoFocus={menu.keyboard}
        style={{ maxHeight: window.innerHeight - 16 }}
      />
    </div>
  );
}
