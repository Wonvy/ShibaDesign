import { useSyncExternalStore, type ReactNode } from 'react';

interface Toast {
  id: number;
  message: string;
  /** warning：不是出错，但内容值得多看一会儿 */
  kind: 'info' | 'error' | 'warning';
  /** 提示后面的按钮（比如"取消"） */
  action?: { label: string; run(): void };
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** 在屏幕底部显示一条几秒后自动消失的提示 */
export function toast(message: string, kind: Toast['kind'] = 'info'): void {
  const id = nextId++;
  toasts = [...toasts, { id, message, kind }];
  emit();
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    },
    kind === 'warning' ? 10000 : kind === 'error' ? 6000 : 4000,
  );
}

/**
 * 显示一条不会自动消失的提示，用于要等一会儿的操作。
 * 返回的对象可以更新文字；操作结束后必须调用 close。
 * @param action 提示后面的按钮，比如可以中途取消的操作给一个"取消"
 */
export function busyToast(
  message: string,
  action?: { label: string; run(): void },
): { update(message: string): void; close(): void } {
  const id = nextId++;
  toasts = [...toasts, { id, message, kind: 'info', action }];
  emit();
  return {
    update(next) {
      toasts = toasts.map((t) => (t.id === id ? { ...t, message: next } : t));
      emit();
    },
    close() {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    },
  };
}

export function Toasts(): ReactNode {
  const items = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
          {t.action && (
            <button type="button" className="toast-action" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
