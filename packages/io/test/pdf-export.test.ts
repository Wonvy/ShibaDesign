import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  ContentStream,
  EmbeddedFont,
  OutlineFont,
  PdfWriter,
  formatNumber,
  jpegInfo,
  parseSfnt,
  pdfName,
  pdfText,
  subsetTrueType,
  toSfnt,
  writeJpeg,
} from '../src';
import { environment } from './pdf-fixtures';

const require = createRequire(import.meta.url);
const fontFile = (name: string): Uint8Array => new Uint8Array(readFileSync(require.resolve(name)));

/** 用写出器拼一个单页 PDF，内容由 draw 往内容流里写 */
function onePage(draw: (content: ContentStream, writer: PdfWriter, fonts: Record<string, unknown>) => void) {
  const writer = new PdfWriter();
  const pages = writer.alloc();
  const resources = writer.alloc();
  const content = new ContentStream();
  const fonts: Record<string, unknown> = {};
  draw(content, writer, fonts);
  writer.set(resources, { Font: fonts as never });
  const page = writer.add({
    Type: pdfName('Page'),
    Parent: pages,
    MediaBox: [0, 0, 200, 100],
    Resources: resources,
    Contents: writer.stream({}, content.toBytes()),
  });
  writer.set(pages, { Type: pdfName('Pages'), Kids: [page], Count: 1 });
  const catalog = writer.add({ Type: pdfName('Catalog'), Pages: pages });
  return writer.finish(catalog, writer.add({ Title: pdfText('测试 Test') }));
}

/** 用 pdf.js 打开；文档对象没有 destroy，要关的是加载任务 */
async function open(bytes: Uint8Array) {
  const { standardFontDataUrl, cMapUrl } = environment;
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl, cMapUrl });
  return { doc: await task.promise, close: () => task.destroy() };
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const { doc, close } = await open(bytes);
  const content = await (await doc.getPage(1)).getTextContent();
  await close();
  return content.items.map((item) => ('str' in item ? item.str : '')).join('');
}

describe('PDF 写出器', () => {
  it('数字最多四位小数，不用科学计数法，非有限数写成 0', () => {
    expect(formatNumber(1)).toBe('1');
    expect(formatNumber(-0.5)).toBe('-.5');
    expect(formatNumber(1 / 3)).toBe('.3333');
    expect(formatNumber(1e-7)).toBe('0');
    expect(formatNumber(-1e-7)).toBe('0');
    expect(formatNumber(1e30)).toBe('1000000000');
    expect(formatNumber(NaN)).toBe('0');
  });

  it('写出的文件能被 pdf.js 打开：页面大小、标题、路径都对', async () => {
    const bytes = onePage((content) => {
      content.fillColor({ r: 1, g: 0, b: 0, a: 1 }).path([0, 10, 10, 1, 90, 10, 3, 120, 50, 90, 90, 4]).fill();
    });
    const { doc, close } = await open(bytes);
    const page = await doc.getPage(1);
    expect(page.view).toEqual([0, 0, 200, 100]);
    const { info } = (await doc.getMetadata()) as { info: { Title?: string } };
    expect(info.Title).toBe('测试 Test');
    const ops = await page.getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.constructPath);
    await close();
  });
});

describe('字体文件', () => {
  const woff = fontFile('@fontsource/inter/files/inter-latin-400-normal.woff');

  it('WOFF 解开后是普通的 TrueType，各项度量读得出来', () => {
    const sfnt = toSfnt(woff);
    expect(new DataView(sfnt.buffer).getUint32(0)).toBe(0x00010000);
    const font = parseSfnt(woff);
    expect(font.outlines).toBe('truetype');
    expect(font.unitsPerEm).toBeGreaterThan(0);
    expect(font.numGlyphs).toBeGreaterThan(100);
    expect(font.postscriptName).toMatch(/^Inter/);
    expect(font.ascent).toBeGreaterThan(0);
    expect(font.descent).toBeLessThan(0);
  });

  it('WOFF2 不认，明确报错', () => {
    expect(() => toSfnt(fontFile('@fontsource/inter/files/inter-latin-400-normal.woff2'))).toThrow(/WOFF2/);
  });

  it('子集只保留用到的字形，字形编号不变，体积小很多', () => {
    const font = parseSfnt(woff);
    const subset = subsetTrueType(font, [36, 37]);
    expect(subset.length).toBeLessThan(font.bytes.length / 3);
    const reparsed = parseSfnt(subset);
    expect(reparsed.numGlyphs).toBe(font.numGlyphs);
    expect(reparsed.advance(36)).toBe(font.advance(36));
    // 留下的字形有轮廓，没用到的清空了
    const view = new DataView(subset.buffer);
    const loca = reparsed.tables.get('loca')!;
    const length = (g: number) => view.getUint32(loca.offset + (g + 1) * 4) - view.getUint32(loca.offset + g * 4);
    expect(length(36)).toBeGreaterThan(0);
    expect(length(40)).toBe(0);
  });

  it('嵌入的字体能显示、能复制出文字', async () => {
    const font = new EmbeddedFont(parseSfnt(woff), 'inter-latin');
    // Inter 里 H、i 的字形编号（和排版引擎给的一样）
    const bytes = onePage((content, writer, fonts) => {
      const ref = writer.alloc();
      fonts.F1 = ref;
      content.beginText().font('F1', 24).textMatrix([1, 0, 0, 1, 10, 40]);
      content.showText([font.use(38, 'H') + font.use(167, 'i')]);
      content.endText();
      font.write(writer, ref);
    });
    expect(await pageText(bytes)).toBe('Hi');
  });

  it('Type3 字体用字形轮廓写字，也能复制出文字', async () => {
    const font = new OutlineFont();
    const square = [0, 0, 0, 1, 0.6, 0, 1, 0.6, 0.7, 1, 0, 0.7, 4];
    const bytes = onePage((content, writer, fonts) => {
      const ref = writer.alloc();
      fonts.T1 = ref;
      content.beginText().font('T1', 1).textMatrix([20, 0, 0, 20, 10, 40]);
      content.showText([
        font.use(0, { outline: square, advance: 0.7, text: '口' }) +
          font.use(1, { outline: [], advance: 0.3, text: ' ' }),
      ]);
      content.showText([font.use(0, { outline: square, advance: 0.7, text: '口' })]);
      content.endText();
      font.write(writer, ref);
    });
    expect(await pageText(bytes)).toBe('口 口');
  });
});

describe('JPEG', () => {
  /** 拼一个只有文件头的 JPEG：可选的 EXIF 方向，再加一个帧头 */
  function jpeg(components: number, orientation?: number): Uint8Array {
    const parts: number[] = [0xff, 0xd8];
    if (orientation !== undefined) {
      // APP1：Exif\0\0 + 小端 TIFF 头 + 一个只有方向标签的 IFD
      const tiff = [
        0x49,
        0x49,
        42,
        0,
        8,
        0,
        0,
        0,
        1,
        0,
        0x12,
        0x01,
        3,
        0,
        1,
        0,
        0,
        0,
        orientation,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ];
      const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
      parts.push(0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
    }
    const sof = [8, 0, 30, 0, 40, components];
    for (let i = 0; i < components; i++) sof.push(i + 1, 0x11, 0);
    parts.push(0xff, 0xc0, 0, sof.length + 2, ...sof, 0xff, 0xd9);
    return new Uint8Array(parts);
  }

  it('读出尺寸、通道数和拍摄方向', () => {
    expect(jpegInfo(jpeg(3))).toEqual({ width: 40, height: 30, components: 3, orientation: 1 });
    expect(jpegInfo(jpeg(1, 6))).toMatchObject({ components: 1, orientation: 6 });
    expect(jpegInfo(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('只有方向正常的灰度和 RGB 照片原样放进去', () => {
    const writer = new PdfWriter();
    expect(writeJpeg(writer, jpeg(3))).not.toBeNull();
    expect(writeJpeg(writer, jpeg(4))).toBeNull();
    expect(writeJpeg(writer, jpeg(3, 6))).toBeNull();
  });
});
