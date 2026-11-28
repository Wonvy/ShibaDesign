import { rgba } from '@shiba/core';
import type { CanvasTheme } from '@shiba/editor';

/**
 * 主题定义。一个主题 = 一组界面用的 CSS 变量 + 画布区域用的颜色。
 * 新增主题：在下面的 THEMES 里加一项即可，界面和画布都会自动使用。
 */
export interface ThemeDef {
  id: string;
  /** 告诉浏览器这是亮色还是暗色，影响滚动条、表单控件等原生外观 */
  scheme: 'light' | 'dark';
  /** 主题菜单里显示名称用的翻译键 */
  labelKey: string;
  vars: Record<ThemeVar, string>;
  canvas: CanvasTheme;
}

export type ThemeVar =
  | '--bg'
  | '--panel'
  | '--panel-2'
  | '--panel-3'
  | '--border'
  | '--text'
  | '--text-dim'
  | '--accent'
  | '--accent-soft'
  | '--accent-text'
  | '--danger'
  | '--component'
  | '--shadow';

export const THEMES: ThemeDef[] = [
  {
    id: 'light',
    scheme: 'light',
    labelKey: 'theme.light',
    vars: {
      '--bg': '#eceef1',
      '--panel': '#ffffff',
      '--panel-2': '#f3f4f6',
      '--panel-3': '#e6e8ec',
      '--border': '#dfe2e7',
      '--text': '#1b1e23',
      '--text-dim': '#6a717d',
      '--accent': '#2563eb',
      '--accent-soft': 'rgba(37, 99, 235, 0.12)',
      '--accent-text': '#ffffff',
      '--danger': '#d92d20',
      '--component': '#7c3aed',
      '--shadow': '0 8px 28px rgba(15, 23, 42, 0.16)',
    },
    canvas: {
      background: rgba(0.905, 0.912, 0.925),
      accent: '#2563eb',
      label: '#6a717d',
      handleFill: '#ffffff',
    },
  },
  {
    id: 'dark',
    scheme: 'dark',
    labelKey: 'theme.dark',
    vars: {
      '--bg': '#141518',
      '--panel': '#1e2024',
      '--panel-2': '#282b31',
      '--panel-3': '#343840',
      '--border': '#30343b',
      '--text': '#e8eaed',
      '--text-dim': '#969da8',
      '--accent': '#5b93ff',
      '--accent-soft': 'rgba(91, 147, 255, 0.18)',
      '--accent-text': '#0b1220',
      '--danger': '#ff6b5e',
      '--component': '#b197fc',
      '--shadow': '0 8px 28px rgba(0, 0, 0, 0.5)',
    },
    canvas: {
      background: rgba(0.085, 0.09, 0.1),
      accent: '#5b93ff',
      label: '#969da8',
      handleFill: '#ffffff',
    },
  },
];
