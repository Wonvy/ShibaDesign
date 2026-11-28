import type { Editor, KeyOverride } from '@shiba/editor';

/** 用户自定义的快捷键，记在浏览器里 */
const KEY = 'shiba.keybindings';

export function loadOverrides(): KeyOverride[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (o): o is KeyOverride =>
        typeof o === 'object' &&
        o !== null &&
        typeof (o as KeyOverride).command === 'string' &&
        ((o as KeyOverride).key === null || typeof (o as KeyOverride).key === 'string'),
    );
  } catch {
    return [];
  }
}

export function saveOverrides(editor: Editor, overrides: readonly KeyOverride[]): void {
  editor.keymap.setOverrides(overrides);
  try {
    if (overrides.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    // 隐私模式下存不了：这次打开有效，下次恢复默认
  }
}
