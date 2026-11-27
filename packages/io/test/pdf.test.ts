import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { rotationOf, validateDocument, type Asset, type SceneNode } from '@shiba/core';
import { PdfImportError, encodePng, importPdf, type PdfImportOptions, type PdfImportResult } from '../src';
import { asEllipse, asRectangle, asRoundedRect, tightBounds, toSubpaths } from '../src/pdf/geometry';
import { CLOSE, CUBIC, LINE, MOVE, QUAD } from '../src/pdf/ir';
import { environment, makePdf, stream, type PageSpec } from './pdf-fixtures';

// ───────────── 工具 ─────────────

interface Converted extends PdfImportResult {
  boards: SceneNode[];
  /** 第 i 个画板里的对象，从下到上 */
  on(board?: number): SceneNode[];
  childrenOf(id: string): SceneNode[];
}

async function convert(
  pages: PageSpec[] | string,
  objects: Record<string, string | Uint8Array> = {},
  options: PdfImportOptions = {},
  catalog = '',
): Promise<Converted> {
  const specs = typeof pages === 'string' ? [{ content: pages, resources: RESOURCES }] : pages;
  const result = await importPdf(environment, makePdf(specs, { ...OBJECTS, ...objects }, catalog), options);
  // 转换结果必须是一份合格的文档，否则编辑器会拒绝加载
  validateDocument(result.document);
  const nodes = Object.values(result.document.nodes);
  const childrenOf = (id: string): SceneNode[] =>
    nodes.filter((n) => n.parent === id).sort((a, b) => (a.index < b.index ? -1 : 1));
  const boards = childrenOf(result.document.rootId);
  return { ...result, boards, childrenOf, on: (board = 0) => childrenOf(boards[board]!.id) };
}

/** 解开我们自己的编码器写出的 PNG，返回每像素的通道值 */
function decodePng(bytes: Uint8Array): { width: number; height: number; channels: number; pixels: Uint8Array } {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  let data = new Uint8Array(0);
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      channels = { 0: 1, 2: 3, 6: 4 }[bytes[at + 17]!] ?? 0;
    } else if (type === 'IDAT') {
      data = unzlibSync(bytes.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const value = data[y * (stride + 1) + 1 + i]!;
      const above = filter === 2 && y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      pixels[y * stride + i] = (value + above) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function assetOf(result: Converted, node: SceneNode): Asset {
  if (!('fill' in node) || node.fill?.type !== 'image') throw new Error('not an image fill');
  const id = node.fill.assetId;
  return result.assets.find((a) => a.meta.id === id)!;
}

const position = (node: SceneNode): [number, number] => [node.transform[4], node.transform[5]];
const radiusOf = (node: SceneNode | undefined): number => (node?.type === 'rect' ? node.cornerRadius : NaN);
const subpathsOf = (node: SceneNode | undefined): unknown => (node?.type === 'path' ? node.subpaths : null);

// ───────────── 测试用的资源 ─────────────

/** 圆心 (cx, cy)、半径 r 的圆，四段曲线 */
function circle(cx: number, cy: number, r: number): string {
  const k = r * 0.5523;
  return (
    `${cx} ${cy - r} m ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c ` +
    `${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ` +
    `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ` +
    `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c h`
  );
}

/** 左下角 (x, y)、宽 w 高 h、圆角 r 的圆角矩形 */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = r * (1 - 0.5523);
  const [x1, y1] = [x + w, y + h];
  return (
    `${x + r} ${y} m ${x1 - r} ${y} l ${x1 - k} ${y} ${x1} ${y + k} ${x1} ${y + r} c ` +
    `${x1} ${y1 - r} l ${x1} ${y1 - k} ${x1 - k} ${y1} ${x1 - r} ${y1} c ` +
    `${x + r} ${y1} l ${x + k} ${y1} ${x} ${y1 - k} ${x} ${y1 - r} c ` +
    `${x} ${y + r} l ${x} ${y + k} ${x + k} ${y} ${x + r} ${y} c h`
  );
}

const OBJECTS: Record<string, string | Uint8Array> = {
  helvetica: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  // 2 × 2 的图片：红 绿 / 蓝 黄
  image: stream(
    '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8',
    new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
  ),
  // 4 × 3 的灰色图片，用来测试裁切时的比例换算
  wide: stream(
    '/Type /XObject /Subtype /Image /Width 4 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 8',
    new Uint8Array(12).fill(128),
  ),
  // 4 × 4 的蒙版：上面两行不上色，下面两行上色
  mask: stream(
    '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ImageMask true /BitsPerComponent 1',
    new Uint8Array([0xf0, 0xf0, 0x0f, 0x0f]),
  ),
  half: '<< /Type /ExtGState /ca 0.5 /CA 0.5 >>',
  multiply: '<< /Type /ExtGState /ca 0.5 /BM /Multiply >>',
  // 从红到蓝的线性渐变
  shading:
    '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] ' +
    '/Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >>',
  // 透明组：两个互相重叠的方块
  pair: stream(
    '/Type /XObject /Subtype /Form /BBox [0 0 40 40] /Matrix [1 0 0 1 100 10] /Group << /S /Transparency >>',
    '0 0 1 rg 0 0 30 30 re f 1 1 0 rg 10 10 30 30 re f',
  ),
  single: stream(
    '/Type /XObject /Subtype /Form /BBox [0 0 40 40] /Group << /S /Transparency >>',
    '0 0 1 rg 0 0 30 30 re f',
  ),
  // Type3 字体：a 是实心方块，b 是小一圈的方块
  type3:
    '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] ' +
    '/CharProcs << /a {glyphA} /b {glyphB} >> /Encoding << /Type /Encoding /Differences [97 /a /b] >> ' +
    '/FirstChar 97 /LastChar 98 /Widths [1000 1000] /Resources << >> >>',
  glyphA: stream('', '1000 0 0 0 800 800 d1 0 0 800 800 re f'),
  glyphB: stream('', '1000 0 0 0 800 800 d1 100 100 600 600 re f'),
  // 没有内嵌字体文件的中文字体：老式中文 PDF 的常见做法
  song: '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [{songCid}] >>',
  songCid:
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /DW 1000 ' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor {songDescriptor} >>',
  songDescriptor:
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] ' +
    '/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
  layer: '<< /Type /OCG /Name (Hidden) >>',
};

const RESOURCES =
  '/Font << /F1 {helvetica} /T3 {type3} /Song {song} >> ' +
  '/XObject << /Im {image} /Wide {wide} /Mask {mask} /Pair {pair} /Single {single} >> ' +
  '/ExtGState << /Half {half} /Multiply {multiply} >> /Shading << /Sh {shading} >> /Properties << /Layer {layer} >>';

// ───────────── 页面和画板 ─────────────

describe('PDF 导入：页面', () => {
  it('每页变成一个画板，从左到右排开，也是幻灯片的一页', async () => {
    const result = await convert([
      { content: '0 0 10 10 re f', size: [200, 100] },
      { content: '0 0 10 10 re f', size: [300, 150] },
    ]);
    expect(result.boards.map((b) => [b.type, b.size])).toEqual([
      ['artboard', [200, 100]],
      ['artboard', [300, 150]],
    ]);
    expect(result.boards.map(position)).toEqual([
      [0, 0],
      [280, 0],
    ]);
    const orders = result.boards.map((b) => (b.type === 'artboard' ? b.deck?.order : undefined));
    expect(orders[0]! < orders[1]!).toBe(true);
    expect(result.report).toMatchObject({ pages: 2, totalPages: 2, objects: 2 });
  });

  it('坐标换成以左上角为原点', async () => {
    const result = await convert('1 0 0 rg 10 10 50 30 re f');
    const [rect] = result.on();
    expect(rect).toMatchObject({ type: 'rect', size: [50, 30], stroke: null, cornerRadius: 0 });
    expect(position(rect!)).toEqual([10, 60]);
    expect(rect).toMatchObject({ fill: { type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } } });
  });

  it('页面旋转 90 度时画板的宽高对调', async () => {
    const result = await convert([{ content: '10 10 50 30 re f', extra: '/Rotate 90' }]);
    expect(result.boards[0]!.size).toEqual([100, 200]);
    const [rect] = result.on();
    expect(rect!.type).toBe('rect');
    expect(rect!.size).toEqual([30, 50]);
    expect(position(rect!)).toEqual([10, 10]);
  });

  it('超过页数上限时只转换前几页，并如实报告', async () => {
    const page = { content: '0 0 10 10 re f' };
    const result = await convert([page, page, page], {}, { maxPages: 2 });
    expect(result.boards).toHaveLength(2);
    expect(result.report).toMatchObject({ pages: 2, totalPages: 3 });
  });

  it('内容太重时提前停下', async () => {
    const page = { content: 'BT /F1 18 Tf 20 60 Td (Hello) Tj ET', resources: RESOURCES };
    const result = await convert([page, page, page], {}, { maxAnchors: 1 });
    expect(result.report).toMatchObject({ pages: 1, totalPages: 3 });
  });

  it('隐藏图层里的内容不导入', async () => {
    const result = await convert(
      '/OC /Layer BDC 10 10 20 20 re f EMC 50 10 20 20 re f',
      {},
      {},
      '/OCProperties << /OCGs [{layer}] /D << /OFF [{layer}] >> >>',
    );
    expect(result.on().map(position)).toEqual([[50, 70]]);
  });

  it('不是 PDF 的文件会被拒绝', async () => {
    const attempt = importPdf(environment, new TextEncoder().encode('这不是 PDF'));
    await expect(attempt).rejects.toBeInstanceOf(PdfImportError);
    await expect(attempt).rejects.toMatchObject({ reason: 'invalid' });
  });
});

// ───────────── 形状 ─────────────

describe('PDF 导入：形状', () => {
  it('旋转过的矩形仍然是矩形，只是带了旋转', async () => {
    // 逆时针转 30 度；页面坐标 y 向下，所以角度是负的
    const result = await convert('q 0.866025 0.5 -0.5 0.866025 100 20 cm 0 0 40 20 re f Q');
    const [rect] = result.on();
    expect(rect!.type).toBe('rect');
    expect(rect!.size[0]).toBeCloseTo(40, 2);
    expect(rect!.size[1]).toBeCloseTo(20, 2);
    expect(rotationOf(rect!.transform)).toBeCloseTo(-Math.PI / 6, 3);
  });

  it('圆认成椭圆，圆角矩形认成带圆角的矩形', async () => {
    const result = await convert(`${circle(50, 50, 20)} f ${roundedRect(100, 20, 60, 40, 5)} f`);
    const [ellipse, rounded] = result.on();
    expect(ellipse).toMatchObject({ type: 'ellipse', size: [40, 40] });
    expect(position(ellipse!)).toEqual([30, 30]);
    expect(rounded).toMatchObject({ type: 'rect', size: [60, 40] });
    expect(position(rounded!)).toEqual([100, 40]);
    expect(radiusOf(rounded)).toBeCloseTo(5, 1);
  });

  it('描边的曲线变成钢笔路径', async () => {
    const result = await convert('0 0 1 RG 3 w 70 20 m 90 60 110 60 130 20 c S');
    const [path] = result.on();
    expect(path).toMatchObject({ type: 'path', fill: null, stroke: { width: 3, color: { r: 0, g: 0, b: 1, a: 1 } } });
    // 曲线最高点在 y = 50，所以盒子是 60 × 30，左上角在页面的 (70, 50)
    expect(path!.size).toEqual([60, 30]);
    expect(position(path!)).toEqual([70, 50]);
    expect(subpathsOf(path)).toMatchObject([
      {
        closed: false,
        anchors: [
          { x: 0, y: 30 },
          { x: 60, y: 30 },
        ],
      },
    ]);
  });

  it('保留透明度、混合模式和奇偶填充规则', async () => {
    const result = await convert('/Multiply gs 0 1 0 rg 20 50 40 40 re 30 60 20 20 re f*');
    const [path] = result.on();
    expect(path).toMatchObject({ type: 'path', fillRule: 'evenodd', blendMode: 'multiply' });
    expect(path).toMatchObject({ fill: { color: { r: 0, g: 1, b: 0, a: 0.5 } } });
    expect(subpathsOf(path)).toHaveLength(2);
  });

  it('渐变改成它的平均色，并记进报告', async () => {
    const result = await convert(`q ${roundedRect(20, 20, 100, 60, 8)} W n /Sh sh Q`);
    const [card] = result.on();
    // 用圆角矩形裁剪后铺渐变：还原成一个圆角矩形，而不是一个被裁剪的大色块
    expect(card).toMatchObject({ type: 'rect', size: [100, 60] });
    expect(radiusOf(card)).toBeCloseTo(8, 1);
    expect(card).toMatchObject({ fill: { color: { r: 0.5, g: 0, b: 0.5, a: 1 } } });
    expect(result.report.issues).toMatchObject({ gradients: 1, clips: 0 });
  });
});

// ───────────── 裁剪 ─────────────

describe('PDF 导入：裁剪', () => {
  it('被矩形裁剪的矩形直接算出剩下的部分', async () => {
    const result = await convert('q 100 5 40 20 re W n 0.5 g 90 0 80 40 re f Q');
    const [rect] = result.on();
    expect(rect).toMatchObject({ type: 'rect', size: [40, 20] });
    expect(position(rect!)).toEqual([100, 75]);
    expect(result.report.issues.clips).toBe(0);
  });

  it('完全在裁剪范围之外的对象不导入', async () => {
    const result = await convert('q 0 0 10 10 re W n 50 50 20 20 re f Q 150 50 20 20 re f');
    expect(result.on().map(position)).toEqual([[150, 30]]);
  });

  it('还原不了的裁剪会原样保留对象，并记进报告', async () => {
    const result = await convert('q 10 10 m 60 10 l 35 50 l h W n 0 0 30 100 re f Q');
    expect(result.on()).toHaveLength(1);
    expect(result.on()[0]).toMatchObject({ type: 'rect', size: [30, 100] });
    expect(result.report.issues.clips).toBe(1);
  });

  it('被矩形裁掉一部分的图片：框是裁剪范围，图片在框里放大并移到原位', async () => {
    // 图片占 80 × 60，从 (90, 10) 开始；裁剪框是 (100, 20) 起的 40 × 40
    const result = await convert('q 100 20 40 40 re W n 80 0 0 60 90 10 cm /Wide Do Q');
    const [frame] = result.on();
    expect(frame).toMatchObject({ type: 'rect', size: [40, 40] });
    expect(position(frame!)).toEqual([100, 40]);
    expect(frame).toMatchObject({ fill: { type: 'image', fit: 'cover', zoom: 1.5, panX: 0.5, panY: 0 } });
    expect(result.report.issues.clips).toBe(0);
  });

  it('被圆裁剪的图片：变成填了图片的椭圆', async () => {
    const result = await convert(`q ${circle(50, 50, 20)} W n 60 0 0 60 20 20 cm /Im Do Q`);
    const [avatar] = result.on();
    expect(avatar).toMatchObject({ type: 'ellipse', size: [40, 40] });
    expect(position(avatar!)).toEqual([30, 30]);
    expect(avatar).toMatchObject({ fill: { type: 'image', fit: 'cover', zoom: 1.5, panX: 0, panY: 0 } });
    expect(result.report.issues.clips).toBe(0);
  });
});

// ───────────── 图片 ─────────────

describe('PDF 导入：图片', () => {
  it('图片变成带图片填充的矩形，像素原样保留', async () => {
    const result = await convert('q 40 0 0 20 150 70 cm /Im Do Q');
    const [rect] = result.on();
    expect(rect).toMatchObject({ type: 'rect', size: [40, 20], fill: { type: 'image', fit: 'stretch' } });
    expect(position(rect!)).toEqual([150, 10]);

    const asset = assetOf(result, rect!);
    expect(asset.meta).toMatchObject({ mime: 'image/png', width: 2, height: 2 });
    const png = decodePng(asset.bytes);
    expect([png.width, png.height, png.channels]).toEqual([2, 2, 3]);
    expect([...png.pixels]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  });

  it('同一张图片用了两次，只存一份', async () => {
    const result = await convert('q 40 0 0 20 10 10 cm /Im Do Q q 40 0 0 20 100 10 cm /Im Do Q');
    expect(result.on()).toHaveLength(2);
    expect(result.assets).toHaveLength(1);
  });

  it('蒙版图片用当前的填充色上色', async () => {
    const result = await convert('1 0 0 rg q 20 0 0 20 150 60 cm /Mask Do Q');
    const [rect] = result.on();
    const png = decodePng(assetOf(result, rect!).bytes);
    expect([png.width, png.height, png.channels]).toEqual([4, 4, 4]);
    // 第一行不上色（全透明），第三行涂成红色
    expect([...png.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...png.pixels.subarray(32, 36)]).toEqual([255, 0, 0, 255]);
  });

  it('太大的图片在导入时缩小', async () => {
    const result = await convert('q 40 0 0 20 150 70 cm /Im Do Q', {}, { maxImageSide: 1 });
    expect(assetOf(result, result.on()[0]!).meta).toMatchObject({ width: 1, height: 1 });
  });
});

// ───────────── 文字 ─────────────

describe('PDF 导入：文字', () => {
  it('文字变成轮廓，同一行的几段合成一个对象，名字就是那行字', async () => {
    const result = await convert('BT /F1 18 Tf 20 60 Td (Hello) Tj ( PDF) Tj 0 -30 Td (Second) Tj ET');
    const [first, second] = result.on();
    expect(result.on()).toHaveLength(2);
    expect(first).toMatchObject({ type: 'path', name: 'Hello PDF', fillRule: 'nonzero', stroke: null });
    expect(second).toMatchObject({ type: 'path', name: 'Second' });
    // 基线在页面的 y = 40，字在基线上方；字号 18，大写字母高度大约 13
    const [x, y] = position(first!);
    expect(x).toBeGreaterThan(20);
    expect(x).toBeLessThan(24);
    expect(y).toBeGreaterThan(24);
    expect(y + first!.size[1]).toBeCloseTo(40, 0);
    expect(first!.size[0]).toBeGreaterThan(70);
    expect(position(second!)[1]).toBeGreaterThan(y + 25);
  });

  it('看不见的文字（比如扫描件的识别层）不导入', async () => {
    const result = await convert('BT /F1 18 Tf 3 Tr 20 60 Td (hidden) Tj ET');
    expect(result.on()).toHaveLength(0);
  });

  it('同时填充和描边的文字', async () => {
    const result = await convert('BT /F1 18 Tf 2 Tr 0.5 w 1 0 0 RG 0 0 1 rg 20 60 Td (AB) Tj ET');
    expect(result.on()[0]).toMatchObject({
      type: 'path',
      name: 'AB',
      fill: { color: { r: 0, g: 0, b: 1 } },
      stroke: { width: 0.5, color: { r: 1, g: 0, b: 0 } },
    });
  });

  it('Type3 字体的字也合成一段文字', async () => {
    const result = await convert('BT /T3 10 Tf 20 60 Td (ab) Tj ET');
    const [text] = result.on();
    expect(result.on()).toHaveLength(1);
    expect(text).toMatchObject({ type: 'path', name: 'ab' });
    // 两个字各占 10 宽：a 是 8 × 8 的方块，b 是里面 6 × 6 的方块
    expect(position(text!)).toEqual([20, 32]);
    expect(text!.size).toEqual([17, 8]);
  });

  it('没有内嵌字体的文字改用默认字体重排，并记进报告', async () => {
    const result = await convert('BT /Song 20 Tf 30 50 Td <4F60597D> Tj ET', {}, { fonts: { latin: 'A', cjk: 'B' } });
    const [text] = result.on();
    expect(text).toMatchObject({ type: 'text', text: '你好', sizing: 'auto' });
    expect(text).toMatchObject({ style: { fontSize: 20, fontFamily: { latin: 'A', cjk: 'B' } } });
    // 基线在页面的 y = 50，文本框的上边在它上方大约一个字号处
    expect(position(text!)[0]).toBe(30);
    expect(position(text!)[1]).toBeCloseTo(31, 0);
    expect(result.report.issues.fallbackText).toBe(1);
  });
});

// ───────────── 透明组 ─────────────

describe('PDF 导入：透明组', () => {
  it('半透明的一组对象变成一个带不透明度的编组', async () => {
    const result = await convert('q /Half gs /Pair Do Q');
    const [group] = result.on();
    expect(group).toMatchObject({ type: 'group', opacity: 0.5 });
    const children = result.childrenOf(group!.id);
    expect(children.map((c) => [c.type, ...position(c)])).toEqual([
      ['rect', 100, 60],
      ['rect', 110, 50],
    ]);
    // 组里的对象自己是不透明的：透明度只在组上算一次，重叠的地方才不会透出下面那个
    expect(children[0]).toMatchObject({ fill: { color: { a: 1 } } });
  });

  it('只有一个对象的组不建组，透明度直接给这个对象', async () => {
    const result = await convert('q /Half gs /Single Do Q');
    const [rect] = result.on();
    expect(result.on()).toHaveLength(1);
    expect(rect).toMatchObject({ type: 'rect', fill: { color: { r: 0, g: 0, b: 1, a: 0.5 } } });
  });
});

// ───────────── 几何 ─────────────

describe('路径几何', () => {
  it('识别矩形：没旋转的、旋转过的，以及不是矩形的', () => {
    const upright = asRectangle([MOVE, 10, 20, LINE, 50, 20, LINE, 50, 40, LINE, 10, 40, CLOSE], true);
    expect(upright).toMatchObject({ axisAligned: true, width: 40, height: 20, transform: [1, 0, 0, 1, 10, 20] });

    // 起点和绕向不同，认出来的结果应该一样
    const reversed = asRectangle([MOVE, 50, 40, LINE, 50, 20, LINE, 10, 20, LINE, 10, 40, LINE, 50, 40], true);
    expect(reversed).toMatchObject({ axisAligned: true, width: 40, height: 20, transform: [1, 0, 0, 1, 10, 20] });

    const tilted = asRectangle([MOVE, 0, 0, LINE, 30, 40, LINE, 22, 46, LINE, -8, 6, CLOSE], true);
    expect(tilted).toMatchObject({ axisAligned: false });
    expect(tilted!.width * tilted!.height).toBeCloseTo(500, 6);

    expect(asRectangle([MOVE, 0, 0, LINE, 40, 0, LINE, 50, 20, LINE, 0, 20, CLOSE], true)).toBeNull();
    // 没闭合的四边形：填充时算矩形，描边时不算（少一条边）
    const open = [MOVE, 0, 0, LINE, 40, 0, LINE, 40, 20, LINE, 0, 20];
    expect(asRectangle(open, false)).not.toBeNull();
    expect(asRectangle(open, true)).toBeNull();
  });

  it('转成锚点：二次曲线升阶，回到起点的闭合点并掉', () => {
    const [quad] = toSubpaths([MOVE, 0, 0, QUAD, 30, 60, 60, 0]);
    expect(quad!.anchors).toHaveLength(2);
    expect(quad!.anchors[0]).toMatchObject({ outX: 20, outY: 40 });
    expect(quad!.anchors[1]).toMatchObject({ inX: 40, inY: 40 });
    // 二次曲线的最高点在控制点高度的一半
    expect(tightBounds([quad!])).toMatchObject({ x0: 0, x1: 60, y0: 0, y1: 30 });

    const [closed] = toSubpaths([MOVE, 0, 0, LINE, 10, 0, CUBIC, 10, 5, 5, 10, 0, 10, LINE, 0, 0, CLOSE]);
    expect(closed).toMatchObject({ closed: true });
    expect(closed!.anchors).toHaveLength(3);
  });

  it('多边形不会被当成椭圆，直角矩形不会被当成圆角矩形', () => {
    const octagon: number[] = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      octagon.push(i === 0 ? MOVE : LINE, 50 + 20 * Math.cos(angle), 50 + 20 * Math.sin(angle));
    }
    octagon.push(CLOSE);
    expect(asEllipse(toSubpaths(octagon))).toBeNull();
    expect(asRoundedRect(toSubpaths([MOVE, 0, 0, LINE, 40, 0, LINE, 40, 20, LINE, 0, 20, CLOSE]))).toBeNull();
  });
});

describe('PNG 编码', () => {
  it('灰度、RGB、RGBA 都能原样解回来', () => {
    for (const channels of [1, 3, 4] as const) {
      const pixels = new Uint8Array(5 * 3 * channels).map((_, i) => (i * 37) % 256);
      const png = decodePng(encodePng(5, 3, pixels, channels));
      expect([png.width, png.height, png.channels]).toEqual([5, 3, channels]);
      expect([...png.pixels]).toEqual([...pixels]);
    }
  });

  it('尺寸和数据对不上时报错', () => {
    expect(() => encodePng(4, 4, new Uint8Array(8), 4)).toThrow();
  });
});
