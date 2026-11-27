import { ContentStream } from './content';
import { PdfString, formatNumber, latin1, pdfName, type PdfRef, type PdfValue, type PdfWriter } from './objects';
import { subsetTrueType, type SfntFont } from './sfnt';

/**
 * 往 PDF 里嵌字体。
 *
 * 两种做法：
 * - 有字体文件（我们自己排版的文字）：把 TrueType 字体做成子集嵌进去，按字形编号写字（CID 字体，Identity-H 编码）。
 *   阅读器拿到的是真正的字体，显示、打印、复制都和普通 PDF 一样。
 * - 只有字形轮廓（从 PDF 导入、没改过的文字）：做成 Type3 字体，每个字形是一小段画路径的指令。
 *
 * 两种都带 ToUnicode 表，记下每个字形代表的文字，所以导出的文字能被搜索、选中和复制。
 */

/** 字形代码 → 文字的对照表（ToUnicode CMap） */
function toUnicodeCMap(entries: Map<number, string>, codeBytes: 1 | 2): Uint8Array {
  const code = (value: number): string => value.toString(16).padStart(codeBytes * 2, '0');
  const utf16 = (text: string): string => {
    let out = '';
    for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, '0');
    return out;
  };
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    codeBytes === 1 ? '<00> <FF>' : '<0000> <FFFF>',
    'endcodespacerange',
  ];
  const list = [...entries].filter(([, text]) => text.length > 0).sort((a, b) => a[0] - b[0]);
  // 每段最多 100 条，这是 CMap 格式的规定
  for (let i = 0; i < list.length; i += 100) {
    const part = list.slice(i, i + 100);
    lines.push(`${part.length} beginbfchar`);
    for (const [c, text] of part) lines.push(`<${code(c)}> <${utf16(text)}>`);
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  // 对照表里的文字已经转成了十六进制，这里只剩 ASCII
  return latin1(lines.join('\n'));
}

/** 6 个大写字母的子集前缀。同名字体的不同子集必须用不同前缀，否则阅读器会把它们当成同一个字体 */
export function subsetTag(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26) + i * 7919;
  }
  return tag;
}

/** 按字形编号写字的 TrueType / OpenType 字体 */
export class EmbeddedFont {
  /** 用到的字形 → 它代表的文字（第一次出现时的那个） */
  private readonly used = new Map<number, string>();

  constructor(
    readonly font: SfntFont,
    /** 区分同名字体的种子，比如字体分片的名字 */
    private readonly seed: string,
  ) {}

  /**
   * 字形的步进宽度，千分之一字号，保留两位小数。
   * 写进宽度表的就是这个值，排字时也按它算位置，两边一致才不会一个字一个字地累积误差
   */
  width(glyph: number): number {
    return Math.round((this.font.advance(glyph) * 100_000) / this.font.unitsPerEm) / 100;
  }

  /** 记下用到了一个字形，返回它在内容流里的代码（十六进制） */
  use(glyph: number, text: string): string {
    if (!this.used.has(glyph) || (this.used.get(glyph) === '' && text)) this.used.set(glyph, text);
    return glyph.toString(16).padStart(4, '0');
  }

  get empty(): boolean {
    return this.used.size === 0;
  }

  write(writer: PdfWriter, ref: PdfRef): void {
    const { font } = this;
    const scale = 1000 / font.unitsPerEm;
    const name = `${subsetTag(`${this.seed}|${font.postscriptName}`)}+${font.postscriptName}`;

    let file: PdfRef;
    if (font.outlines === 'truetype') {
      const subset = subsetTrueType(font, this.used.keys());
      file = writer.stream({ Length1: subset.length }, subset);
    } else {
      // CFF 字体整个嵌入（OpenType 格式）。目前内置的字体都是 TrueType，这里只是兜底
      file = writer.stream({ Subtype: pdfName('OpenType') }, font.bytes);
    }
    const flags = 4 | (font.fixedPitch ? 1 : 0) | (font.italicAngle !== 0 ? 64 : 0);
    const descriptor = writer.add({
      Type: pdfName('FontDescriptor'),
      FontName: pdfName(name),
      Flags: flags,
      FontBBox: font.bbox.map((v) => Math.round(v * scale)),
      ItalicAngle: font.italicAngle,
      Ascent: Math.round(font.ascent * scale),
      Descent: Math.round(font.descent * scale),
      CapHeight: Math.round(font.capHeight * scale),
      // 主干粗细只用于缺字体时的替代，按字重粗略估计
      StemV: Math.round(10 + 220 * Math.pow(Math.max(0, font.weight - 50) / 900, 2)),
      [font.outlines === 'truetype' ? 'FontFile2' : 'FontFile3']: file,
    });

    // 宽度表：连续的字形编号写成一组
    const widths: PdfValue[] = [];
    const glyphs = [...this.used.keys()].sort((a, b) => a - b);
    for (let i = 0; i < glyphs.length;) {
      const start = glyphs[i]!;
      const run: number[] = [];
      while (i < glyphs.length && glyphs[i] === start + run.length) run.push(this.width(glyphs[i++]!));
      widths.push(start, run);
    }

    const descendant = writer.add({
      Type: pdfName('Font'),
      Subtype: pdfName(font.outlines === 'truetype' ? 'CIDFontType2' : 'CIDFontType0'),
      BaseFont: pdfName(name),
      CIDSystemInfo: { Registry: latinString('Adobe'), Ordering: latinString('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 1000,
      W: widths,
      CIDToGIDMap: font.outlines === 'truetype' ? pdfName('Identity') : undefined,
    });
    writer.set(ref, {
      Type: pdfName('Font'),
      Subtype: pdfName('Type0'),
      BaseFont: pdfName(name),
      Encoding: pdfName('Identity-H'),
      DescendantFonts: [descendant],
      ToUnicode: writer.stream({}, toUnicodeCMap(this.used, 2)),
    });
  }
}

/** 一个 Type3 字体最多放 256 个字形（单字节编码） */
export const TYPE3_CAPACITY = 256;

export interface OutlineGlyph {
  /** 轮廓，以字号为 1 个单位、y 向上，编码同导入器的路径数据 */
  outline: ArrayLike<number>;
  /** 步进宽度，以字号为 1 个单位；不知道时为 null，按外框估计 */
  advance: number | null;
  text: string;
}

/** Type3 字体里的字形坐标是千分之一字号 */
const TYPE3_UNITS = 1000;

/** 用字形轮廓做的字体：每个字形是一段填充路径的指令，颜色用当时的填充色 */
export class OutlineFont {
  private readonly glyphs: OutlineGlyph[] = [];
  private readonly codes = new Map<OutlineGlyph | number, number>();

  /** 还能不能再放一个新字形 */
  get full(): boolean {
    return this.glyphs.length >= TYPE3_CAPACITY;
  }

  /**
   * 记下用到了一个字形，返回它的单字节代码（十六进制）。
   * key 用来认出同一个字形，通常是它在字形库里的序号
   */
  use(key: number, glyph: OutlineGlyph): string {
    let code = this.codes.get(key);
    if (code === undefined) {
      code = this.glyphs.length;
      this.glyphs.push(glyph);
      this.codes.set(key, code);
    }
    return code.toString(16).padStart(2, '0');
  }

  has(key: number): boolean {
    return this.codes.has(key);
  }

  /** 某个代码的字形的步进宽度，以字号为 1 个单位。和写进宽度表的值一致（千分之一字号保留两位小数） */
  advance(code: number): number {
    const glyph = this.glyphs[code];
    if (!glyph) return 0;
    const advance = glyph.advance ?? Math.max(0, bounds(glyph.outline)[2]);
    return Math.round(advance * TYPE3_UNITS * 100) / 100 / TYPE3_UNITS;
  }

  write(writer: PdfWriter, ref: PdfRef): void {
    const procs: Record<string, PdfRef> = {};
    const names: PdfValue[] = [0];
    const widths: number[] = [];
    let box: [number, number, number, number] | null = null;
    this.glyphs.forEach((glyph, code) => {
      const name = `g${code}`;
      const [x0, y0, x1, y1] = bounds(glyph.outline).map((v) => v * TYPE3_UNITS) as [number, number, number, number];
      const width = Math.round(this.advance(code) * TYPE3_UNITS * 100) / 100;
      widths.push(width);
      // d1：字形只有形状没有颜色，用显示文字时的填充色
      const content = new ContentStream().raw(
        `${formatNumber(width)} 0 ${[x0, y0, x1, y1].map(formatNumber).join(' ')} d1`,
      );
      if (glyph.outline.length > 0) {
        content.path(glyph.outline, TYPE3_UNITS).fill();
        box = box
          ? [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x1), Math.max(box[3], y1)]
          : [x0, y0, x1, y1];
      }
      procs[name] = writer.stream({}, content.toBytes());
      names.push(pdfName(name));
    });
    const text = new Map(this.glyphs.map((glyph, code) => [code, glyph.text]));
    writer.set(ref, {
      Type: pdfName('Font'),
      Subtype: pdfName('Type3'),
      // 有的阅读器会用外框裁剪字形，所以要包住所有字形
      FontBBox: (box ?? [0, 0, 0, 0]).map((v) => Math.round(v)),
      FontMatrix: [1 / TYPE3_UNITS, 0, 0, 1 / TYPE3_UNITS, 0, 0],
      CharProcs: procs,
      Encoding: { Type: pdfName('Encoding'), Differences: names },
      FirstChar: 0,
      LastChar: Math.max(0, this.glyphs.length - 1),
      Widths: widths,
      Resources: {},
      ToUnicode: writer.stream({}, toUnicodeCMap(text, 1)),
    });
  }
}

/** 路径控制点的外框 [x0, y0, x1, y1]；空路径是全 0 */
function bounds(outline: ArrayLike<number>): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const ARITY = [2, 2, 6, 4, 0];
  for (let i = 0; i < outline.length;) {
    const count = ARITY[outline[i++]!] ?? 0;
    for (let k = 0; k < count; k += 2) {
      const x = outline[i + k]!;
      const y = outline[i + k + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    i += count;
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

function latinString(text: string): PdfString {
  return new PdfString(latin1(text));
}
