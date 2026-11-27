import type { Color } from './model';

/** 解析 #rgb / #rrggbb / #rrggbbaa；格式不对时返回 null */
export function parseHex(input: string): Color | null {
  let hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('');
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 };
}

/** 输出 #rrggbb，不含透明度 */
export function toHex(color: Color): string {
  const c = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(color.r)}${c(color.g)}${c(color.b)}`;
}

export function toCssColor(color: Color): string {
  const c = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${c(color.r)}, ${c(color.g)}, ${c(color.b)}, ${color.a})`;
}
