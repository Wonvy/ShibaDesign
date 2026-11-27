import { zlibSync } from 'fflate';

/**
 * PDF 文件的底层写法：对象、字典、流，以及最后的交叉引用表。
 *
 * 只管把值按 PDF 的语法写成字节，不关心页面上画什么。
 * 对象一写进来就转成字节，不在内存里留一棵对象树，几十页的文档也不占多少内存。
 */

export class PdfName {
  constructor(readonly name: string) {}
}

export class PdfRef {
  constructor(readonly id: number) {}
}

/** 字符串，按十六进制写出，什么字节都能放 */
export class PdfString {
  constructor(readonly bytes: Uint8Array) {}
}

/** 已经写好的一段 PDF 语法，原样输出 */
export class PdfRaw {
  constructor(readonly text: string) {}
}

export type PdfValue = number | boolean | null | PdfName | PdfRef | PdfString | PdfRaw | PdfValue[] | PdfDict;
export interface PdfDict {
  [key: string]: PdfValue | undefined;
}

export function pdfName(name: string): PdfName {
  return new PdfName(name);
}

/**
 * 给人看的文字（标题、作者这类）。纯 ASCII 原样存；
 * 有中文等其他字符时按 PDF 的规定存成带字节序标记的 UTF-16BE。
 */
export function pdfText(value: string): PdfString {
  if (/^[\x20-\x7e]*$/.test(value)) return new PdfString(latin1(value));
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    bytes[2 + i * 2] = code >> 8;
    bytes[3 + i * 2] = code & 0xff;
  }
  return new PdfString(bytes);
}

/** PDF 里的日期写法：D:年月日时分秒Z */
export function pdfDate(date: Date): PdfString {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const text =
    `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return new PdfString(latin1(text));
}

/**
 * 数字。最多保留 4 位小数（1 点的万分之一，远小于任何显示精度），不用科学计数法。
 * 非有限数写成 0：PDF 里没有 NaN，写错一个数整页都可能打不开。
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const clamped = Math.max(-1e9, Math.min(1e9, value));
  const rounded = Math.round(clamped * 10_000) / 10_000;
  if (rounded === 0) return '0';
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded
    .toFixed(4)
    .replace(/0+$/, '')
    .replace(/^(-?)0\./, '$1.');
}

const HEX = '0123456789abcdef';

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

/** 名字里只有这些字符能原样写，其余的写成 #xx */
function formatName(name: string): string {
  let out = '/';
  for (const byte of new TextEncoder().encode(name)) {
    const plain = byte > 0x20 && byte < 0x7f && !'#()<>[]{}/%'.includes(String.fromCharCode(byte));
    out += plain ? String.fromCharCode(byte) : `#${HEX[byte >> 4]}${HEX[byte & 15]}`;
  }
  return out;
}

export function serialize(value: PdfValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof PdfName) return formatName(value.name);
  if (value instanceof PdfRef) return `${value.id} 0 R`;
  if (value instanceof PdfString) return `<${hex(value.bytes)}>`;
  if (value instanceof PdfRaw) return value.text;
  if (Array.isArray(value)) return `[${value.map(serialize).join(' ')}]`;
  let out = '<<';
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out += `${formatName(key)} ${serialize(item)}`;
  }
  return `${out}>>`;
}

/** 把只含 0–255 字符的字符串转成字节 */
export function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** 小于这个大小的流不压缩：压缩的开销比省下的还多 */
const MIN_COMPRESS = 64;

export interface StreamOptions {
  /** 用 Flate 压缩。已经压缩过的数据（JPEG）不要再压 */
  compress?: boolean;
}

export class PdfWriter {
  /** 下标是对象编号；0 号对象按规定保留不用 */
  private readonly objects: (Uint8Array | null)[] = [null];

  /** 先占一个对象编号，内容以后再填。互相引用的对象（页面和页面树）需要这样 */
  alloc(): PdfRef {
    this.objects.push(null);
    return new PdfRef(this.objects.length - 1);
  }

  set(ref: PdfRef, value: PdfValue): void {
    this.objects[ref.id] = latin1(serialize(value));
  }

  add(value: PdfValue): PdfRef {
    const ref = this.alloc();
    this.set(ref, value);
    return ref;
  }

  setStream(ref: PdfRef, dict: PdfDict, data: Uint8Array, options: StreamOptions = {}): void {
    const compress = (options.compress ?? true) && data.length >= MIN_COMPRESS;
    const body = compress ? zlibSync(data, { level: 6 }) : data;
    const filter = compress ? mergeFilter(dict.Filter) : dict.Filter;
    const head = latin1(`${serialize({ ...dict, Filter: filter, Length: body.length })}\nstream\n`);
    const tail = latin1('\nendstream');
    const bytes = new Uint8Array(head.length + body.length + tail.length);
    bytes.set(head, 0);
    bytes.set(body, head.length);
    bytes.set(tail, head.length + body.length);
    this.objects[ref.id] = bytes;
  }

  stream(dict: PdfDict, data: Uint8Array, options?: StreamOptions): PdfRef {
    const ref = this.alloc();
    this.setStream(ref, dict, data, options);
    return ref;
  }

  /** 写出整个文件 */
  finish(root: PdfRef, info?: PdfRef): Uint8Array {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const push = (bytes: Uint8Array): void => {
      chunks.push(bytes);
      length += bytes.length;
    };
    // 第二行的几个高位字节告诉传输工具这是二进制文件，别按文本处理
    push(latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'));

    const offsets: number[] = [0];
    for (let id = 1; id < this.objects.length; id++) {
      offsets.push(length);
      push(latin1(`${id} 0 obj\n`));
      push(this.objects[id] ?? latin1('null'));
      push(latin1('\nendobj\n'));
    }

    const xref = length;
    let table = `xref\n0 ${this.objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < this.objects.length; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    push(latin1(table));
    const id = new PdfString(randomBytes(16));
    const trailer = serialize({ Size: this.objects.length, Root: root, Info: info, ID: [id, id] });
    push(latin1(`trailer\n${trailer}\nstartxref\n${xref}\n%%EOF\n`));

    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

function mergeFilter(existing: PdfValue | undefined): PdfValue {
  const flate = pdfName('FlateDecode');
  if (existing === undefined) return flate;
  return [flate, ...(Array.isArray(existing) ? existing : [existing])];
}

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}
