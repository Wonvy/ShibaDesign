import { useSyncExternalStore } from 'react';
import type { MenuContext } from './model';

/**
 * 浮在界面上面的几样东西的开关：右键菜单、命令面板、快捷键表。
 * 放在模块里而不是 React 状态里，这样命令（不在组件里）也能打开它们
 */

export interface OpenContextMenu {
  /** 屏幕坐标（clientX / clientY） */
  x: number;
  y: number;
  menuId: string;
  ctx: MenuContext;
  /** 用键盘打开的（菜单键、Shift+F10）：焦点直接放在第一项上 */
  keyboard?: boolean;
}

export type OverlayKind = 'palette' | 'shortcuts';

let contextMenu: OpenContextMenu | null = null;
let overlay: OverlayKind | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openContextMenu(menu: OpenContextMenu): void {
  contextMenu = menu;
  emit();
}

export function closeContextMenu(): void {
  if (!contextMenu) return;
  contextMenu = null;
  emit();
}

export function useContextMenu(): OpenContextMenu | null {
  return useSyncExternalStore(subscribe, () => contextMenu);
}

/** 打开命令面板或快捷键表；null 关掉 */
export function openOverlay(kind: OverlayKind | null): void {
  overlay = kind;
  contextMenu = null;
  emit();
}

export function useOverlay(): OverlayKind | null {
  return useSyncExternalStore(subscribe, () => overlay);
}
