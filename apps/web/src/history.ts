import { i18n } from './i18n';

/**
 * 撤销历史里每一步的名字：事务的 label 是英文的（'move'、'resize'），在语言包的 history 里找对应的说法，
 * 空格换成下划线做键。找不到时返回 null，调用方显示通用的"撤销"或"修改"
 */
export function historyName(label: string | null): string | null {
  if (!label) return null;
  const key = `history.${label.trim().replace(/\s+/g, '_')}`;
  return i18n.exists(key) ? i18n.t(key) : null;
}
