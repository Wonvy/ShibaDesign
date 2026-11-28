import { subsetTrueType, type SfntFont } from '../font/sfnt';
import { toWoff } from '../font/woff';
import { base64 } from './markup';

/**
 * 导出 SVG、网页时内嵌的字体：每个用到的字体文件做成子集，写成一条 @font-face。
 *
 * 家族名、字重、正斜体都照实写（"Noto Sans SC"、700），所以在设计软件里打开时认得出是什么字体，
 * 装了这个字体就能直接改字。同一个家族的中文字体切成了很多分片，每个分片是同名的一条 @font-face，
 * 用 unicode-range 写明它负责哪几个字——子集里没留下的字形是空的，不限定的话浏览器可能拿它去画别的字。
 */
export interface WebFontFace {
  family: string;
  weight: number;
  italic: boolean;
  font: SfntFont;
}

export class WebFonts {
  private readonly faces = new Map<string, { face: WebFontFace; chars: Set<number>; glyphs: Set<number> }>();

  /**
   * 记下一个字体文件要负责的字
   * @param key 字体文件的唯一标识
   * @param chars 码点
   * @param glyphs 这些字在这个字体里的字形编号
   */
  use(key: string, face: WebFontFace, chars: Iterable<number>, glyphs: Iterable<number>): void {
    let entry = this.faces.get(key);
    if (!entry) this.faces.set(key, (entry = { face, chars: new Set(), glyphs: new Set() }));
    for (const c of chars) entry.chars.add(c);
    for (const g of glyphs) entry.glyphs.add(g);
  }

  get empty(): boolean {
    return this.faces.size === 0;
  }

  /** 所有字体的 @font-face 规则。做不了子集的字体（CFF 轮廓）整个内嵌 */
  css(): string {
    const rules: string[] = [];
    for (const { face, chars, glyphs } of this.faces.values()) {
      if (chars.size === 0) continue;
      const { font } = face;
      const sfnt = font.outlines === 'truetype' ? subsetTrueType(font, glyphs, { dropGlyphNames: true }) : font.bytes;
      rules.push(
        `@font-face{font-family:${cssString(face.family)};` +
          `src:url(data:font/woff;base64,${base64(toWoff(sfnt))}) format("woff");` +
          `font-weight:${Math.round(face.weight)};font-style:${face.italic ? 'italic' : 'normal'};` +
          `unicode-range:${unicodeRange(chars)}}`,
      );
    }
    return rules.join('\n');
  }
}

/** 一组码点 → unicode-range 的写法，相邻的码点合成一段：U+20,U+41-5A,U+4E2D */
export function unicodeRange(chars: Iterable<number>): string {
  const sorted = [...new Set(chars)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i]!;
    i++;
    const hex = (n: number): string => n.toString(16).toUpperCase();
    parts.push(start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`);
  }
  return parts.join(',');
}

/**
 * CSS 里的字符串。家族名来自文档（可能来自别人的文件），去掉换行和尖括号：
 * 这段 CSS 可能放进网页里内联的 SVG，那里的 <style> 不是纯文本，尖括号会被当成标签
 */
export function cssString(text: string): string {
  // eslint-disable-next-line no-control-regex
  return `"${text.replace(/[\u0000-\u001f<>]/g, '').replace(/["\\]/g, '\\$&')}"`;
}
