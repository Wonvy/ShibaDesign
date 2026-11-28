import type { CanvasKit, GlyphRun as SkGlyphRun, Paragraph, Typeface } from 'canvaskit-wasm';
import { hasLiveAppearance, styleOfChar, type CharacterStyle, type Color, type TextNode } from '@shiba/core';
import type { TextAppearances } from './appearance';
import type { FontManager, LoadedFace } from './fonts';
import type { TextLayouts } from './layout';

/**
 * 把排好版的文字拆成"一段一段的字"，供导出 PDF、SVG 时按字写出：
 * 每段字是同一个字体文件、同一个字号、同一种样式，带着每个字的字形编号、位置和它代表的文字。
 * 两种导出写的东西不一样，但需要的排版结果是同一份。
 */

/** 下划线或删除线：一条横线，y 是线的中心，坐标同字的位置 */
export interface DecorationLine {
  x0: number;
  x1: number;
  y: number;
  thickness: number;
}

/** 排好版的一段字：同一个字体文件、同一个字号、同一种样式 */
export interface ShapedRun {
  /** 用的是哪个字体文件 */
  face: LoadedFace;
  size: number;
  glyphs: Uint16Array;
  /** 每个字的位置 x0, y0, x1, y1……（节点本地坐标，y 是基线） */
  positions: Float32Array;
  /** 最后一个字的终点 x */
  end: number;
  /** 每个字代表的文字；一个字代表多个字符（连字）或者几个字合起来代表一个字符时，只有第一个有 */
  text: string[];
  /** 这段字在节点文字里的范围（字符串下标，左闭右开）。行尾折行处的空格排版引擎不画，不在任何一段里 */
  start: number;
  stop: number;
  /** 文字颜色；null 表示不画 */
  color: Color | null;
  /** 下划线、删除线。排版引擎给的结果里没有它们，按字体里记的位置和粗细自己画 */
  lines: DecorationLine[];
  /** 字体没有斜体文件时排版引擎把字形斜切成斜体（中文字体常见），这里是斜切量，0 表示没有 */
  skew: number;
  /** 字体没有粗体文件时排版引擎把字形描粗，这里是描边的宽度，0 表示没有 */
  embolden: number;
}

/** 文字怎么写：按排版结果写字，或者因为认不出字体文件只能画成图片 */
export type ShapedText = { runs: ShapedRun[] } | 'raster';

/** 排版引擎模拟斜体时的斜切量，和 Skia 的一致 */
export const FAKE_ITALIC_SKEW = 0.25;

/** 排版引擎模拟粗体时描边的宽度：9 号字是字号的 1/24，36 号字是 1/32，中间按字号插值（和 Skia 一致） */
export function fakeBoldWidth(size: number): number {
  const t = Math.max(0, Math.min(1, (size - 9) / (36 - 9)));
  return size * (1 / 24 + (1 / 32 - 1 / 24) * t);
}

export class TextShaper {
  /** 认字体文件用的 Skia 字体，dispose 时释放 */
  private readonly typefaces = new Map<string, Typeface | null>();
  /** 嵌入用的字体文件做成的 Skia 字体，用来查它的字符映射表 */
  private readonly embeddedTypefaces = new Map<string, Typeface | null>();

  constructor(
    private readonly ck: CanvasKit,
    private readonly layouts: TextLayouts,
    private readonly fonts: FontManager,
    private readonly appearances: TextAppearances,
  ) {}

  /** 这段文字按保真外观（原文件的字形）显示：没改过，而且用到的字形库都在 */
  frozen(node: TextNode): boolean {
    return (
      hasLiveAppearance(node) && node.appearance!.runs.every((run) => this.appearances.library(run.library) !== null)
    );
  }

  /**
   * 把一个文本节点拆成一段段的字。认不出字体文件时返回 'raster'。
   * 每一段（用换行分开）是单独排的，列表的符号也是单独排的小段落：位置都换算到节点的本地坐标，
   * 字符位置换算成整个文本的下标。列表符号不是文本里的字，它的范围是空的（start = stop = 段首）
   */
  shape(node: TextNode): ShapedText {
    const runs: ShapedRun[] = [];
    for (const block of this.layouts.get(node).blocks) {
      if (block.marker) {
        const { marker } = block;
        const shaped = this.shapePiece(node, marker.paragraph, marker.text, marker.x, marker.y, null, marker.style);
        if (shaped === 'raster') return 'raster';
        for (const run of shaped) runs.push({ ...run, start: block.start, stop: block.start });
      }
      // 空的一段里只有一个零宽空格，没有要写出去的字
      if (block.end === block.start) continue;
      // 首行缩进的占位符在排版引擎里占一个字符（U+FFFC）
      const text = (block.shift > 0 ? '\ufffc' : '') + node.text.slice(block.start, block.end);
      const shaped = this.shapePiece(node, block.paragraph, text, block.x, block.y, block.start - block.shift, null);
      if (shaped === 'raster') return 'raster';
      runs.push(...shaped);
    }
    return { runs };
  }

  /**
   * 一个排好的段落里的字
   * @param text 交给排版引擎的文字
   * @param base 这段文字在节点文字里从哪开始（null 表示不是节点里的字，比如列表符号）
   * @param override 这些字的样式（列表符号用）；不给时按节点里的字取样式
   */
  private shapePiece(
    node: TextNode,
    paragraph: Paragraph,
    text: string,
    dx: number,
    dy: number,
    base: number | null,
    override: CharacterStyle | null,
  ): ShapedRun[] | 'raster' {
    const { ck, fonts } = this;
    const toUtf16 = utf8Offsets(text);
    const runs: ShapedRun[] = [];
    const metrics = paragraph.getLineMetrics();
    for (const [lineIndex, line] of paragraph.getShapedLines().entries()) {
      // 下划线、删除线按排版引擎记的基线画。画字时基线取整到了整数（字的位置里是取整后的），画线时没有取整
      const lineBaseline = (metrics[lineIndex]?.baseline ?? line.baseline) + dy;
      for (const run of line.runs) {
        const typeface = run.typeface as Typeface | null;
        const count = run.glyphs.length;
        if (count === 0) {
          typeface?.delete();
          continue;
        }
        const chars: string[] = [];
        for (let i = 0; i < count; i++) {
          const from = toUtf16.get(run.offsets[i]!);
          const to = toUtf16.get(run.offsets[i + 1]!);
          chars.push(from !== undefined && to !== undefined && to > from ? text.slice(from, to) : '');
        }
        const first = toUtf16.get(run.offsets[0]!) ?? 0;
        const last = toUtf16.get(run.offsets[count]!) ?? text.length;
        // 这段字的样式（同一段字的样式一定相同，排版引擎在样式变化处会断开）
        const style = override ?? styleOfChar(node, (base ?? 0) + first);
        const families = [style.fontFamily.latin, style.fontFamily.cjk];
        const names = fonts.resolve(families, chars.join(''), style.fontWeight, style.italic).names;
        const face = this.identify(run, chars.join(''), names, families, style.fontWeight, style.italic);
        const lines = style.underline || style.strikethrough ? decorationLines(ck, run, style, dx, lineBaseline) : [];
        typeface?.delete();
        if (!face) return 'raster';
        const positions = Float32Array.from(run.positions.subarray(0, count * 2));
        for (let i = 0; i < count; i++) {
          positions[i * 2] = positions[i * 2]! + dx;
          positions[i * 2 + 1] = positions[i * 2 + 1]! + dy;
        }
        runs.push({
          face,
          size: run.size,
          glyphs: Uint16Array.from(run.glyphs.subarray(0, count)),
          positions,
          end: (run.positions[count * 2] ?? run.positions[Math.max(0, count * 2 - 2)] ?? 0) + dx,
          text: chars,
          start: base === null ? 0 : base + first,
          stop: base === null ? 0 : base + last,
          color: style.color,
          lines,
          // 排版结果里的 fakeItalic 在 0.42 版里没有填，按"要斜体但字体文件不是斜体"推断
          skew: run.fakeItalic || (style.italic && !face.italic) ? FAKE_ITALIC_SKEW : 0,
          // fakeBold 同样没有填。排版引擎的规则：要的字重至少是 600，并且比字体文件重 200 以上
          embolden:
            run.fakeBold || (style.fontWeight >= 600 && style.fontWeight - face.weight >= 200)
              ? fakeBoldWidth(run.size)
              : 0,
        });
      }
    }
    return runs;
  }

  /** 一个字体文件对应的 Skia 字体，用来查字的字形编号和宽度。由这个对象持有，不要 delete */
  typeface(face: LoadedFace): Typeface | null {
    if (!this.typefaces.has(face.key)) {
      this.typefaces.set(face.key, this.ck.Typeface.MakeTypefaceFromData(face.bytes.slice(0)));
    }
    return this.typefaces.get(face.key) ?? null;
  }

  /**
   * 嵌入用的字体文件（TrueType / OpenType，见 LoadedFace.embeddable）做成的 Skia 字体。
   * 第一次调用时传入文件内容；之后只按 face 取。由这个对象持有，不要 delete
   */
  embeddedTypeface(face: LoadedFace, sfnt?: Uint8Array): Typeface | null {
    if (!this.embeddedTypefaces.has(face.key) && sfnt) {
      const copy = sfnt.slice();
      this.embeddedTypefaces.set(face.key, this.ck.Typeface.MakeTypefaceFromData(copy.buffer));
    }
    return this.embeddedTypefaces.get(face.key) ?? null;
  }

  /**
   * 把一段字的字形编号换成嵌入用的那个字体文件里的编号。
   * 排版用的 WOFF2 和嵌入用的 WOFF 本该是同一份字体，但 fontsource 有的分片两者的字形顺序不完全一样
   * （思源黑体放标点的那个分片里，全角冒号在 WOFF2 里是 296 号字形，在 WOFF 里是 291 号），直接用会写出别的字。
   * 所以按字符映射表对一遍：一个字形正好是某个字符在排版字体里的字形时，换成这个字符在嵌入字体里的字形。
   * 连字、变体这类查不到的保持原样（两边编号一致时它们本来就对）
   * @param sfnt 嵌入用的字体文件（已经解开的 TrueType / OpenType）
   */
  remapToEmbedded(run: ShapedRun, sfnt: Uint8Array): void {
    const shaping = this.typeface(run.face);
    const embedded = this.embeddedTypeface(run.face, sfnt);
    if (!shaping || !embedded) return;
    for (let i = 0; i < run.glyphs.length; i++) {
      const text = run.text[i];
      if (!text || text.length > 2 || [...text].length !== 1) continue;
      const [from] = shaping.getGlyphIDs(text);
      if (from !== run.glyphs[i]) continue;
      const [to] = embedded.getGlyphIDs(text);
      if (to) run.glyphs[i] = to;
    }
  }

  dispose(): void {
    for (const typeface of this.typefaces.values()) typeface?.delete();
    this.typefaces.clear();
    for (const typeface of this.embeddedTypefaces.values()) typeface?.delete();
    this.embeddedTypefaces.clear();
  }

  /**
   * 认出一段排好的字用的是哪个字体文件。排版引擎给的结果里有它用的字体，但认不出是哪个文件；
   * 所以拿这段字在这个字体里的字形编号，和每个候选文件比，编号完全一样的就是它。
   * 先比按区间算出来的那几个分片；有的字不在任何分片声明的区间里（比如全角冒号），
   * 排版引擎是在这段文字用到的别的分片里找到它的，所以再比这几个家族的所有已加载的分片。
   * 同一个家族的不同分片覆盖不同的字，所以几乎不会认错；真有几个都一样，取排在前面的，排版引擎也是这么选的。
   * 都对不上时返回 null（调用方改成画图片），不能随便挑一个：字形编号在别的文件里是别的字
   */
  private identify(
    run: SkGlyphRun,
    text: string,
    names: readonly string[],
    families: readonly string[],
    weight: number,
    italic: boolean,
  ): LoadedFace | null {
    const actual = (run.typeface as Typeface | null)?.getGlyphIDs(text) ?? null;
    const candidates = [
      ...names.map((name) => this.fonts.loadedFace(name, weight, italic)),
      ...this.fonts.loadedFaces(families, weight, italic),
    ];
    const seen = new Set<string>();
    for (const face of candidates) {
      if (!face || seen.has(face.key)) continue;
      seen.add(face.key);
      // 排版结果里没有字体时没法比，只能相信按区间算出来的第一个
      if (!actual) return face;
      const typeface = this.typeface(face);
      if (typeface && sameIds(typeface.getGlyphIDs(text), actual)) return face;
    }
    return null;
  }
}

/**
 * 一段字的下划线和删除线，和排版引擎（SkParagraph 的 Decorations）画的一样：
 * 粗细取字体里记的下划线粗细，没有时是字号的 1/14；只有删除线时改用字体里记的删除线粗细。
 * 线的中心在基线往下"字体里记的位置"处：下划线的位置不是正数时用粗细代替，删除线没有记位置时按字号估计（大约在小写字母中间）。
 * 线从第一个字的起点画到最后一个字的终点
 * @param baseline 这一行的基线，节点本地坐标（没有取整的，见 shapePiece）
 */
function decorationLines(
  ck: CanvasKit,
  run: SkGlyphRun,
  style: CharacterStyle,
  dx: number,
  baseline: number,
): DecorationLine[] {
  const count = run.glyphs.length;
  if (count === 0) return [];
  const font = new ck.Font(run.typeface as Typeface | null, run.size);
  const metrics = font.getMetrics();
  font.delete();
  const x0 = run.positions[0]! + dx;
  const x1 = run.positions[count * 2]! + dx;
  let thickness =
    metrics.underlineThickness && metrics.underlineThickness > 0 ? metrics.underlineThickness : run.size / 14;
  if (style.strikethrough && !style.underline && metrics.strikeoutThickness && metrics.strikeoutThickness > 0) {
    thickness = metrics.strikeoutThickness;
  }
  const lines: DecorationLine[] = [];
  if (style.underline) {
    const position = metrics.underlinePosition && metrics.underlinePosition > 0 ? metrics.underlinePosition : thickness;
    lines.push({ x0, x1, y: baseline + position, thickness });
  }
  if (style.strikethrough) {
    const position = metrics.strikeoutPosition ?? -run.size * 0.3;
    lines.push({ x0, x1, y: baseline + position, thickness });
  }
  return lines;
}

function sameIds(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** UTF-8 字节偏移 → JavaScript 字符串下标。排版引擎给的字符位置是前者 */
function utf8Offsets(text: string): Map<number, number> {
  const map = new Map<number, number>();
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    map.set(bytes, index);
    const cp = char.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    index += char.length;
  }
  map.set(bytes, index);
  return map;
}
