import type { ComponentType } from 'react';
import type { SceneNode } from '@shiba/core';
import type { Editor } from '@shiba/editor';

/**
 * 右侧属性面板的注册表。
 * 新增一块面板：写一个接收 PanelProps 的组件，在 panels/index.ts 里加一项 PanelDef。
 */
export interface PanelProps {
  editor: Editor;
  /** 当前选中的节点，至少一个 */
  nodes: SceneNode[];
}

export interface PanelDef {
  id: string;
  /** 面板标题的翻译键 */
  titleKey: string;
  /** 从上到下的排列顺序，小的在上 */
  order: number;
  /** 这块面板对当前选区是否有意义；不提供时始终显示 */
  when?(props: PanelProps): boolean;
  component: ComponentType<PanelProps>;
}

const panels: PanelDef[] = [];

export function registerPanel(def: PanelDef): void {
  const existing = panels.findIndex((p) => p.id === def.id);
  if (existing >= 0) panels.splice(existing, 1);
  panels.push(def);
  panels.sort((a, b) => a.order - b.order);
}

export function listPanels(): readonly PanelDef[] {
  return panels;
}
