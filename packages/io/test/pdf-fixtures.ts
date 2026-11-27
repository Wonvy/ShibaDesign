import { createRequire } from 'node:module';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfEnvironment } from '../src';

/**
 * 测试用的 PDF 都是在这里手写出来的：PDF 的页面内容本来就是一段文本指令，
 * 手写可以精确控制每个测试要验证的那一种情况，也不用往仓库里放二进制文件。
 */

const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

export const environment: PdfEnvironment = {
  pdfjs,
  standardFontDataUrl: `${pdfjsRoot}/standard_fonts/`,
  cMapUrl: `${pdfjsRoot}/cmaps/`,
  wasmUrl: `${pdfjsRoot}/wasm/`,
  iccUrl: `${pdfjsRoot}/iccs/`,
};

const encoder = new TextEncoder();

function concat(parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** 一个带数据流的对象，比如图片或表单 */
export function stream(dictionary: string, data: string | Uint8Array): Uint8Array {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return concat([`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`, bytes, '\nendstream']);
}

export interface PageSpec {
  /** 页面内容：PDF 绘图指令 */
  content: string | Uint8Array;
  /** 资源字典的内容，可以用 {名字} 引用 objects 里的对象 */
  resources?: string;
  /** 页面大小，默认 200 × 100 */
  size?: [number, number];
  /** 写进页面字典的其他条目，比如 /Rotate 90 */
  extra?: string;
}

/**
 * 拼出一个 PDF 文件。objects 是额外的对象（字体、图片、渐变……），
 * 在 resources 和其他对象里用 {名字} 引用，这里会换成真正的对象编号。
 */
export function makePdf(
  pages: PageSpec[],
  objects: Record<string, string | Uint8Array> = {},
  /** 写进文档目录的其他条目，同样可以用 {名字} 引用对象 */
  catalog = '',
): Uint8Array {
  const names = Object.keys(objects);
  // 编号：1 目录，2 页面树，然后每页两个（页面、内容），最后是额外的对象
  const firstExtra = 3 + pages.length * 2;
  const reference = (name: string): string => {
    const index = names.indexOf(name);
    if (index < 0) throw new Error(`unknown object ${name}`);
    return `${firstExtra + index} 0 R`;
  };
  const resolve = (text: string): string => text.replace(/\{(\w+)\}/g, (_, name: string) => reference(name));

  const bodies: (string | Uint8Array)[] = [
    `<< /Type /Catalog /Pages 2 0 R ${resolve(catalog)} >>`,
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];
  pages.forEach((page, i) => {
    const [width, height] = page.size ?? [200, 100];
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${4 + i * 2} 0 R ` +
        `/Resources << ${resolve(page.resources ?? '')} >> ${page.extra ?? ''} >>`,
    );
    bodies.push(stream('', page.content));
  });
  for (const name of names) {
    const body = objects[name]!;
    // 数据流里可能是二进制，只替换文本对象里的引用；数据流的字典部分在调用 stream 之前自己写好
    bodies.push(typeof body === 'string' ? resolve(body) : body);
  }

  const parts: (string | Uint8Array)[] = ['%PDF-1.4\n'];
  const offsets: number[] = [];
  let length = 9;
  const push = (part: string | Uint8Array): void => {
    parts.push(part);
    length += typeof part === 'string' ? encoder.encode(part).length : part.length;
  };
  bodies.forEach((body, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  });
  const xref = length;
  push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(parts);
}
