import { useEffect, useRef, useState, type ReactNode } from 'react';

/** 下拉菜单。点外面或按 Esc 关闭 */
export function Menu(props: {
  label: string;
  trigger: ReactNode;
  align?: 'left' | 'right';
  children: (close: () => void) => ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className={`menu-trigger${open ? ' is-active' : ''}`}
        title={props.label}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {props.trigger}
      </button>
      {open && (
        <div className={`menu-popover align-${props.align ?? 'right'}`} role="menu">
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem(props: {
  onClick: () => void;
  checked?: boolean;
  children: ReactNode;
  trailing?: ReactNode;
}): ReactNode {
  return (
    <div className="menu-row">
      <button
        type="button"
        className="menu-item"
        role="menuitemradio"
        aria-checked={props.checked}
        onClick={props.onClick}
      >
        <span className="menu-check">{props.checked ? '✓' : ''}</span>
        <span className="menu-text">{props.children}</span>
      </button>
      {props.trailing}
    </div>
  );
}
