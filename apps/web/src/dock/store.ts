import { useSyncExternalStore } from 'react';
import {
  DEFAULT_LAYOUT,
  clampFloating,
  normalize,
  openTab,
  setHidden,
  toggleTab,
  activateTab,
  type DockLayout,
} from './layout';
import { getDockPanel, isKnownPanel } from './registry';

/**
 * 当前的面板布局。放在模块里（命令、菜单不在组件里也能改），每次改了存进浏览器
 */
const KEY = 'shiba.dock';

let layout: DockLayout | null = null;
const listeners = new Set<() => void>();

function viewport(): { width: number; height: number } {
  return typeof window === 'undefined'
    ? { width: 1400, height: 900 }
    : { width: window.innerWidth, height: window.innerHeight };
}

function load(): DockLayout {
  let raw: unknown = null;
  try {
    const text = localStorage.getItem(KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  return normalize(raw, { has: isKnownPanel }, viewport());
}

export function getLayout(): DockLayout {
  layout ??= load();
  return layout;
}

export function setLayout(next: DockLayout | ((current: DockLayout) => DockLayout)): void {
  const value = typeof next === 'function' ? next(getLayout()) : next;
  if (value === layout) return;
  layout = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // 存不了（隐私模式等）就只在这次打开里有效
  }
  for (const listener of [...listeners]) listener();
}

export function useDockLayout(): DockLayout {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getLayout);
}

/** 面板第一次打开时浮动在哪里：画布中间偏右 */
function floatPlace(id: string): { x: number; y: number; w: number; h: number } {
  const def = getDockPanel(id);
  const size = def?.floatSize ?? { w: 300, h: 460 };
  const { width, height } = viewport();
  return { x: Math.max(16, width - size.w - 320), y: Math.max(60, Math.min(120, height - size.h - 20)), ...size };
}

function placeOf(
  id: string,
): { zone: 'left' | 'right' | 'bottom' } | { float: { x: number; y: number; w: number; h: number } } {
  const def = getDockPanel(id);
  if (!def || def.defaultPlace === 'float') return { float: floatPlace(id) };
  return def.defaultPlace;
}

/** 打开一个面板并切过去（窗口菜单、⌥ 加数字、属性栏里的"弹出"） */
export function showPanel(id: string): void {
  setLayout((current) => openTab(current, id, placeOf(id)));
}

/** 打开或关掉一个面板 */
export function togglePanel(id: string): void {
  setLayout((current) => toggleTab(current, id, placeOf(id)));
}

export function focusPanel(id: string): void {
  setLayout((current) => activateTab(current, id));
}

export function toggleHidden(): void {
  setLayout((current) => setHidden(current, !current.hidden));
}

export function resetLayout(): void {
  setLayout(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)) as DockLayout);
}

/** 浏览器窗口变小时把浮动窗挪回来 */
export function clampToViewport(): void {
  setLayout((current) => clampFloating(current, viewport()));
}
