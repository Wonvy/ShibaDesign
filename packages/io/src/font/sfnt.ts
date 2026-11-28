import { unzlibSync } from 'fflate';

/**
 * 读 TrueType / OpenType 字体文件，供导出 PDF、SVG 时嵌入字体。
 *
 * 只读嵌入需要的那几项：字形个数、每个字形的宽度、字体的上下沿和外框、名字，
 * 以及按用到的字形做子集（只留下用到的字形轮廓，文件小很多）。
 * 字体文件来自字体包或者用户导入，按不可信输入处理：越界时抛错，由调用方改用别的办法。
 */

export interface SfntTable {
  offset: number;
  length: number;
}

export interface SfntFont {
  bytes: Uint8Array;
  tables: Map<string, SfntTable>;
  /** 字形轮廓的格式：truetype 是 glyf 表，cff 是 CFF 表 */
  outlines: 'truetype' | 'cff';
  unitsPerEm: number;
  numGlyphs: number;
  /** 字形坐标的外框 [xMin, yMin, xMax, yMax] */
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  fixedPitch: boolean;
  /** 字重，400 常规，700 粗体 */
  weight: number;
  /** PostScript 名，只含 PDF 名字里能用的字符 */
  postscriptName: string;
  /** 某个字形的步进宽度，字体单位 */
  advance(glyph: number): number;
}

const WOFF = 0x774f4646; // 'wOFF'
const WOFF2 = 0x774f4632; // 'wOF2'
const TRUETYPE = 0x00010000;
const TRUE = 0x74727565; // 'true'
const OTTO = 0x4f54544f; // 'OTTO'

export class FontFormatError extends Error {}

/** 把 WOFF 解成普通的字体文件；本来就是 TrueType / OpenType 的原样返回 */
export function toSfnt(input: Uint8Array): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.length < 12) throw new FontFormatError('font too short');
  const signature = view.getUint32(0);
  if (signature === TRUETYPE || signature === TRUE || signature === OTTO) return input;
  if (signature === WOFF2) throw new FontFormatError('WOFF2 is not supported');
  if (signature !== WOFF) throw new FontFormatError('unknown font format');

  const flavor = view.getUint32(4);
  const count = view.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    if (at + 20 > input.length) throw new FontFormatError('bad WOFF directory');
    const tag = view.getUint32(at);
    const offset = view.getUint32(at + 4);
    const compressed = view.getUint32(at + 8);
    const original = view.getUint32(at + 12);
    if (offset + compressed > input.length || original > 64 * 1024 * 1024) throw new FontFormatError('bad WOFF table');
    const raw = input.subarray(offset, offset + compressed);
    const data = compressed < original ? unzlibSync(raw) : raw;
    if (data.length !== original) throw new FontFormatError('bad WOFF table size');
    tables.push({ tag, checksum: view.getUint32(at + 16), data });
  }
  return buildSfnt(
    flavor,
    tables.map((t) => ({ tag: tagName(t.tag), data: t.data, checksum: t.checksum })),
  );
}

function tagName(tag: number): string {
  return String.fromCharCode(tag >>> 24, (tag >> 16) & 0xff, (tag >> 8) & 0xff, tag & 0xff);
}

function tagNumber(tag: string): number {
  return ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) | (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const full = data.length & ~3;
  for (let i = 0; i < full; i += 4) {
    sum = (sum + ((data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!)) >>> 0;
  }
  if (full < data.length) {
    let last = 0;
    for (let i = full; i < full + 4; i++) last = (last << 8) | (data[i] ?? 0);
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum;
}

/** 按表拼出字体文件。checksum 为空时现算；head 表里的整体校验值最后补上 */
export function buildSfnt(flavor: number, input: { tag: string; data: Uint8Array; checksum?: number }[]): Uint8Array {
  const tables = [...input].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const count = tables.length;
  let total = 12 + count * 16;
  for (const t of tables) total += (t.data.length + 3) & ~3;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let power = 1;
  let log = 0;
  while (power * 2 <= count) {
    power *= 2;
    log++;
  }
  view.setUint32(0, flavor);
  view.setUint16(4, count);
  view.setUint16(6, power * 16);
  view.setUint16(8, log);
  view.setUint16(10, count * 16 - power * 16);

  let offset = 12 + count * 16;
  let headOffset = -1;
  tables.forEach((table, i) => {
    const record = 12 + i * 16;
    view.setUint32(record, tagNumber(table.tag));
    view.setUint32(record + 4, table.checksum ?? checksum(table.data));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, table.data.length);
    out.set(table.data, offset);
    if (table.tag === 'head') headOffset = offset;
    offset += (table.data.length + 3) & ~3;
  });
  if (headOffset >= 0 && headOffset + 12 <= out.length) {
    view.setUint32(headOffset + 8, 0);
    view.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return out;
}

/** 读字体文件。不是 TrueType / OpenType（或者缺了必需的表）时抛错 */
export function parseSfnt(input: Uint8Array): SfntFont {
  const bytes = toSfnt(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  const tables = new Map<string, SfntTable>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > bytes.length) throw new FontFormatError('bad table directory');
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > bytes.length) throw new FontFormatError('table out of range');
    tables.set(tagName(view.getUint32(at)), { offset, length });
  }
  const table = (tag: string, minLength: number): SfntTable => {
    const t = tables.get(tag);
    if (!t || t.length < minLength) throw new FontFormatError(`missing ${tag}`);
    return t;
  };

  const head = table('head', 54);
  const unitsPerEm = view.getUint16(head.offset + 18) || 1000;
  const bbox: [number, number, number, number] = [
    view.getInt16(head.offset + 36),
    view.getInt16(head.offset + 38),
    view.getInt16(head.offset + 40),
    view.getInt16(head.offset + 42),
  ];
  const hhea = table('hhea', 36);
  const numberOfHMetrics = view.getUint16(hhea.offset + 34);
  const numGlyphs = view.getUint16(table('maxp', 6).offset + 4);
  const hmtx = table('hmtx', 0);
  if (numberOfHMetrics === 0 || numberOfHMetrics * 4 > hmtx.length) throw new FontFormatError('bad hmtx');

  let ascent = view.getInt16(hhea.offset + 4);
  let descent = view.getInt16(hhea.offset + 6);
  let capHeight = Math.round(ascent * 0.7);
  let weight = 400;
  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 78) {
    weight = view.getUint16(os2.offset + 4);
    const version = view.getUint16(os2.offset);
    // 字体设计时用的上下沿，比 hhea 里的更接近字的实际高度
    if (view.getUint16(os2.offset + 62) & 0x80) {
      ascent = view.getInt16(os2.offset + 68);
      descent = view.getInt16(os2.offset + 70);
    }
    if (version >= 2 && os2.length >= 90) capHeight = view.getInt16(os2.offset + 88) || capHeight;
  }

  let italicAngle = 0;
  let fixedPitch = false;
  const post = tables.get('post');
  if (post && post.length >= 16) {
    italicAngle = view.getInt32(post.offset + 4) / 65536;
    fixedPitch = view.getUint32(post.offset + 12) !== 0;
  }

  const outlines = tables.has('glyf') && tables.has('loca') ? 'truetype' : tables.has('CFF ') ? 'cff' : null;
  if (!outlines) throw new FontFormatError('no outlines');

  const lastAdvance = view.getUint16(hmtx.offset + (numberOfHMetrics - 1) * 4);
  return {
    bytes,
    tables,
    outlines,
    unitsPerEm,
    numGlyphs,
    bbox,
    ascent,
    descent,
    capHeight,
    italicAngle,
    fixedPitch,
    weight,
    postscriptName: postscriptName(bytes, view, tables.get('name')) ?? 'Font',
    advance: (glyph) =>
      glyph < numberOfHMetrics ? view.getUint16(hmtx.offset + glyph * 4) : glyph < numGlyphs ? lastAdvance : 0,
  };
}

/** name 表里的 PostScript 名（编号 6），只保留 PDF 名字里安全的字符 */
function postscriptName(bytes: Uint8Array, view: DataView, name: SfntTable | undefined): string | null {
  if (!name || name.length < 6) return null;
  const count = view.getUint16(name.offset + 2);
  const strings = name.offset + view.getUint16(name.offset + 4);
  for (let i = 0; i < count; i++) {
    const at = name.offset + 6 + i * 12;
    if (at + 12 > name.offset + name.length) break;
    if (view.getUint16(at + 6) !== 6) continue;
    const platform = view.getUint16(at);
    const length = view.getUint16(at + 8);
    const offset = strings + view.getUint16(at + 10);
    if (offset + length > bytes.length) continue;
    let text = '';
    if (platform === 3 || platform === 0) {
      for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(view.getUint16(offset + k));
    } else {
      for (let k = 0; k < length; k++) text += String.fromCharCode(bytes[offset + k]!);
    }
    const safe = text.replace(/[^A-Za-z0-9._-]/g, '');
    if (safe) return safe.slice(0, 63);
  }
  return null;
}

/** 子集里保留的表。PDF 阅读器画 TrueType 字形只用得到这些；排版用的 GSUB、GPOS 之类都不要 */
const KEEP_TABLES = ['head', 'hhea', 'hmtx', 'maxp', 'cvt ', 'fpgm', 'prep', 'cmap', 'OS/2', 'post', 'name'];

export interface SubsetOptions {
  /**
   * 去掉 post 表里的字形名（改成 3.0 版）。字形名只在打印到 PostScript 设备时有用，
   * 一个西文字体的字形名能有好几十 KB。PDF 阅读器有时靠它认字，所以只给网页字体用
   */
  dropGlyphNames?: boolean;
}

/**
 * TrueType 字体的子集：只保留用到的字形（以及复合字形引用的部件），其余字形清空。
 * 字形编号保持不变，所以 PDF 里可以直接用原来的字形编号。
 * 字符映射表（cmap）原样保留，没留下的字形映射到空字形；当网页字体用时要用 unicode-range 限定它负责的字。
 */
export function subsetTrueType(font: SfntFont, glyphs: Iterable<number>, options: SubsetOptions = {}): Uint8Array {
  const { bytes, tables } = font;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = tables.get('head')!;
  const loca = tables.get('loca')!;
  const glyf = tables.get('glyf')!;
  const longLoca = view.getInt16(head.offset + 50) === 1;
  const count = font.numGlyphs;
  if (loca.length < (count + 1) * (longLoca ? 4 : 2)) throw new FontFormatError('bad loca');
  const location = (glyph: number): number =>
    longLoca ? view.getUint32(loca.offset + glyph * 4) : view.getUint16(loca.offset + glyph * 2) * 2;
  const range = (glyph: number): [number, number] => {
    const start = location(glyph);
    const end = location(glyph + 1);
    if (end < start || end > glyf.length) throw new FontFormatError('bad glyph offset');
    return [start, end];
  };

  // 0 号字形是"缺字"方框，按规定必须保留
  const keep = new Set<number>([0]);
  const queue = [0, ...glyphs].filter((g) => g >= 0 && g < count);
  while (queue.length > 0) {
    const glyph = queue.pop()!;
    if (keep.has(glyph) && glyph !== 0) continue;
    keep.add(glyph);
    const [start, end] = range(glyph);
    if (end - start < 10 || view.getInt16(glyf.offset + start) >= 0) continue;
    // 复合字形：由别的字形拼成，那些字形也得留下
    let at = glyf.offset + start + 10;
    const limit = glyf.offset + end;
    for (;;) {
      if (at + 4 > limit) break;
      const flags = view.getUint16(at);
      const component = view.getUint16(at + 2);
      if (component < count && !keep.has(component)) queue.push(component);
      at += 4 + (flags & 0x0001 ? 4 : 2);
      if (flags & 0x0008) at += 2;
      else if (flags & 0x0040) at += 4;
      else if (flags & 0x0080) at += 8;
      if (!(flags & 0x0020)) break;
    }
  }

  let size = 0;
  for (const glyph of keep) {
    const [start, end] = range(glyph);
    size += (end - start + 3) & ~3;
  }
  const newGlyf = new Uint8Array(size);
  const newLoca = new Uint8Array((count + 1) * 4);
  const locaView = new DataView(newLoca.buffer);
  let offset = 0;
  for (let glyph = 0; glyph < count; glyph++) {
    locaView.setUint32(glyph * 4, offset);
    if (!keep.has(glyph)) continue;
    const [start, end] = range(glyph);
    newGlyf.set(bytes.subarray(glyf.offset + start, glyf.offset + end), offset);
    offset += (end - start + 3) & ~3;
  }
  locaView.setUint32(count * 4, offset);

  const out: { tag: string; data: Uint8Array }[] = [
    { tag: 'glyf', data: newGlyf },
    { tag: 'loca', data: newLoca },
  ];
  for (const tag of KEEP_TABLES) {
    const table = tables.get(tag);
    if (!table) continue;
    let data = bytes.slice(table.offset, table.offset + table.length);
    if (tag === 'head') {
      // 新的位置表一律用 4 字节的格式
      data = data.slice();
      new DataView(data.buffer).setInt16(50, 1);
    }
    if (tag === 'post' && options.dropGlyphNames && data.length >= 32) {
      // 3.0 版只有 32 字节的头，没有字形名
      data = data.slice(0, 32);
      new DataView(data.buffer).setUint32(0, 0x00030000);
    }
    out.push({ tag, data });
  }
  return buildSfnt(TRUETYPE, out);
}
