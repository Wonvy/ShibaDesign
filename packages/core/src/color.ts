import type { Color } from './model';

/** 解析 #rgb / #rrggbb / #rrggbbaa；格式不对时返回 null */
export function parseHex(input: string): Color | null {
  let hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('');
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 };
}

/**
 * 解析颜色输入框里的文字：十六进制（有没有 # 都行），`rgb(…)` / `rgba(…)`（0–255，透明度 0–1 或百分比），
 * `hsl(…)` / `hsla(…)`（色相角度、饱和度和亮度百分比）。格式不对时返回 null
 */
export function parseColorText(input: string): Color | null {
  const text = input.trim().toLowerCase();
  const hex = parseHex(text);
  if (hex) return hex;
  const match = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
  if (!match) return null;
  const parts = match[2]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = (raw: string | undefined): number | null => {
    if (raw === undefined) return 1;
    const value = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  };
  const a = alpha(parts[3]);
  if (a === null) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (match[1]!.startsWith('rgb')) {
    const channel = (raw: string): number | null => {
      const value = raw.endsWith('%') ? (Number(raw.slice(0, -1)) / 100) * 255 : Number(raw);
      return Number.isFinite(value) ? clamp(value / 255) : null;
    };
    const [r, g, b] = parts.slice(0, 3).map(channel);
    if (r === null || g === null || b === null || r === undefined || g === undefined || b === undefined) return null;
    return { r, g, b, a };
  }
  const h = Number(parts[0]!.replace(/deg$/, ''));
  const s = Number(parts[1]!.replace(/%$/, '')) / 100;
  const l = Number(parts[2]!.replace(/%$/, '')) / 100;
  if (![h, s, l].every(Number.isFinite)) return null;
  // HSL → RGB（CSS 规范里的算法）
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => l - clamp(s) * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: clamp(f(0)), g: clamp(f(8)), b: clamp(f(4)), a };
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
