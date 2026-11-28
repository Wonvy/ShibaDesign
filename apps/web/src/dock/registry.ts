import type { ComponentType } from 'react';
import type { ZoneId } from './layout';

/**
 * 能放进停靠区和浮动窗的面板。加一个面板：写一个组件，registerDockPanel 一下，窗口菜单里就有它
 */
export interface DockPanelDef {
  id: string;
  /** 选项卡上的名字（语言包的键） */
  titleKey: string;
  component: ComponentType;
  /** 第一次打开时放在哪里：某个停靠区，或者浮动 */
  defaultPlace: { zone: ZoneId } | 'float';
  /** 浮动时的默认大小 */
  floatSize?: { w: number; h: number };
}

const panels = new Map<string, DockPanelDef>();
/** 按 id 临时生成的面板（属性栏里弹出来的分区，id 是 "inspector:分区 id"） */
const factories: { prefix: string; make: (rest: string) => DockPanelDef | null }[] = [];

export function registerDockPanel(def: DockPanelDef): void {
  panels.set(def.id, def);
}

export function registerDockPanelFactory(prefix: string, make: (rest: string) => DockPanelDef | null): void {
  factories.push({ prefix, make });
}

export function getDockPanel(id: string): DockPanelDef | null {
  const fixed = panels.get(id);
  if (fixed) return fixed;
  for (const factory of factories) {
    if (id.startsWith(factory.prefix)) return factory.make(id.slice(factory.prefix.length));
  }
  return null;
}

/** 窗口菜单里列出来的面板（固定注册的那些） */
export function listDockPanels(): DockPanelDef[] {
  return [...panels.values()];
}

/** 认得这个面板 id 吗（整理读回来的布局时用） */
export function isKnownPanel(id: string): boolean {
  return getDockPanel(id) !== null;
}
