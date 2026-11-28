import { toHex, type Color, type DocStore } from '@shiba/core';

/** 最近用过的颜色（不含透明度），记在浏览器里，最多 12 个，新的在前 */
const RECENT_KEY = 'shiba.recentColors';
const MAX_RECENT = 12;
const MAX_DOCUMENT = 24;

export function recentColors(): Color[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return list.flatMap((hex) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return Number.isFinite(n)
        ? [{ r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 }]
        : [];
    });
  } catch {
    return [];
  }
}

export function pushRecentColor(color: Color): void {
  try {
    const hex = toHex(color);
    const list = recentColors()
      .map(toHex)
      .filter((h) => h !== hex);
    localStorage.setItem(RECENT_KEY, JSON.stringify([hex, ...list].slice(0, MAX_RECENT)));
  } catch {
    // 隐私模式下存不了，不影响使用
  }
}

/** 文档里用到的颜色：填充、描边、渐变色标、文字颜色、阴影，按出现的多少排，最多 24 个 */
export function documentColors(store: DocStore): Color[] {
  const counts = new Map<string, { color: Color; count: number }>();
  const add = (color: Color | undefined | null): void => {
    if (!color) return;
    const key = toHex(color);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { color: { ...color, a: 1 }, count: 1 });
  };
  for (const node of store.all()) {
    if ('fill' in node && node.fill) {
      if (node.fill.type === 'solid') add(node.fill.color);
      else if (node.fill.type === 'gradient') node.fill.stops.forEach((s) => add(s.color));
    }
    if ('stroke' in node && node.stroke) add(node.stroke.color);
    for (const effect of node.effects ?? []) if ('color' in effect) add(effect.color);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_DOCUMENT)
    .map((e) => e.color);
}
