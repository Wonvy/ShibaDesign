import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  GLYPH_LIBRARY_MIME,
  decodeGlyphLibrary,
  hasLiveAppearance,
  rotationOf,
  validateDocument,
  type Asset,
  type GradientFill,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import {
  PdfImportError,
  encodePng,
  fontCategory,
  fontItalic,
  fontWeight,
  importPdf,
  type PdfImportOptions,
  type PdfImportResult,
} from '../src';
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
  helveticaBold: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  times: '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
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
  // 从黄到绿的径向渐变，圆心在原点、半径 30；通过图案的矩阵挪到 (60, 50)
  radial:
    '<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [0 0 0 0 0 30] ' +
    '/Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 0] /C1 [0 0.5 0] /N 1 >> /Extend [true true] >>',
  glow: '<< /PatternType 2 /Shading {radial} /Matrix [1 0 0 1 60 50] >>',
  // 从白到黑、半径 20 的径向渐变
  whiteBlack:
    '<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [0 0 0 0 0 20] ' +
    '/Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0 0 0] /N 1 >> /Extend [true true] >>',
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
  '/Font << /F1 {helvetica} /HB {helveticaBold} /TR {times} /T3 {type3} /Song {song} >> ' +
  '/XObject << /Im {image} /Wide {wide} /Mask {mask} /Pair {pair} /Single {single} >> ' +
  '/ExtGState << /Half {half} /Multiply {multiply} >> /Shading << /Sh {shading} /Radial {whiteBlack} >> /Pattern << /Glow {glow} >> ' +
  '/Properties << /Layer {layer} >>';

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

  it('铺满整页的不透明底色矩形变成画板的背景色，不再是一个对象', async () => {
    const result = await convert('0.2 0.4 0.6 rg -1 -1 202 102 re f 1 0 0 rg 10 10 50 30 re f');
    expect(result.boards[0]).toMatchObject({ fill: { type: 'solid', color: { r: 0.2, g: 0.4, b: 0.6, a: 1 } } });
    expect(result.on()).toHaveLength(1);
    // 只盖住一部分、半透明、或者不是第一个画的，都还是普通的矩形
    for (const content of [
      '0 0 1 rg 0 0 200 90 re f',
      '/Half gs 0 0 1 rg 0 0 200 100 re f',
      '1 0 0 rg 10 10 50 30 re f 0 0 1 rg 0 0 200 100 re f',
    ]) {
      const other = await convert(content);
      expect(other.boards[0]).toMatchObject({ fill: { color: { r: 1, g: 1, b: 1 } } });
      expect(other.on().length).toBeGreaterThan(0);
    }
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

  it('线性渐变还原成渐变填充，几何换算到形状自己的坐标里', async () => {
    const result = await convert(`q ${roundedRect(20, 20, 100, 60, 8)} W n /Sh sh Q`);
    const [card] = result.on();
    // 用圆角矩形裁剪后铺渐变：还原成一个填了渐变的圆角矩形，而不是一个被裁剪的大色块
    expect(card).toMatchObject({ type: 'rect', size: [100, 60] });
    expect(radiusOf(card)).toBeCloseTo(8, 1);
    // 渐变从页面上 x = 0 到 200：相对这个 100 宽、从 x = 20 开始的形状，就是 -0.2 到 1.8
    expect(card).toMatchObject({
      fill: {
        type: 'gradient',
        kind: 'linear',
        start: { x: -0.2, y: 1.333333 },
        end: { x: 1.8, y: 1.333333 },
        stops: [
          { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    });
    expect(result.report.issues).toMatchObject({ gradients: 0, clips: 0 });
  });

  it('图案里的径向渐变：矩阵相对页面，圆心和半径换算到形状上', async () => {
    const result = await convert('/Pattern cs /Glow scn 30 20 60 60 re f');
    const [shape] = result.on();
    expect(shape).toMatchObject({
      type: 'rect',
      size: [60, 60],
      fill: { type: 'gradient', kind: 'radial', start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 } },
    });
    const { stops } = (shape as unknown as { fill: { stops: { color: unknown }[] } }).fill;
    expect(stops[0]!.color).toEqual({ r: 1, g: 1, b: 0, a: 1 });
    expect(result.report.issues.gradients).toBe(0);
  });

  it('压扁的径向渐变还原成椭圆；半透明编组里的渐变，透明度乘进色标', async () => {
    // 径向渐变在宽 2 高 1 的坐标里画：圆变成横着的椭圆
    const result = await convert(
      'q 10 10 80 40 re W n 2 0 0 1 50 30 cm /Radial sh Q /Half gs 120 10 60 40 re W n /Sh sh',
    );
    const [oval, faded] = result.on() as (SceneNode & { fill: GradientFill })[];
    expect(oval!.fill).toMatchObject({ kind: 'radial', start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 }, aspect: 0.5 });
    expect(faded!.fill.stops.every((stop) => Math.abs(stop.color.a - 0.5) < 1e-6)).toBe(true);
  });

  it('铺满整页的渐变变成画板的渐变背景', async () => {
    const result = await convert('/Sh sh 0 0 1 rg 10 10 20 20 re f');
    expect(result.boards[0]).toMatchObject({ fill: { type: 'gradient', kind: 'linear' } });
    expect(result.on()).toHaveLength(1);
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

/** 文本节点的保真外观里一共有多少个字形 */
function glyphCount(node: SceneNode | undefined): number {
  if (node?.type !== 'text' || !node.appearance) return 0;
  return node.appearance.runs.reduce((sum, run) => sum + run.glyphs.length / 3, 0);
}

function asText(node: SceneNode | undefined): TextNode {
  if (node?.type !== 'text') throw new Error(`expected a text node, got ${node?.type}`);
  return node;
}

const FONTS = {
  sans: { latin: 'Sans', cjk: 'SansCJK' },
  serif: { latin: 'Serif', cjk: 'SerifCJK' },
  mono: { latin: 'Mono', cjk: 'SansCJK' },
};

describe('PDF 导入：文字', () => {
  it('一行字变成可以编辑的文本，带着原文件的字形', async () => {
    const result = await convert('BT /F1 18 Tf 20 60 Td (Hello) Tj ( PDF) Tj ET', {}, { fonts: FONTS });
    expect(result.on()).toHaveLength(1);
    const text = asText(result.on()[0]);
    expect(text).toMatchObject({ text: 'Hello PDF', sizing: 'auto', align: 'left' });
    expect(text.style).toMatchObject({ fontSize: 18, fontWeight: 400, fontFamily: FONTS.sans });
    // 按原字形显示，没改过
    expect(hasLiveAppearance(text)).toBe(true);
    // 基线在页面的 y = 40：文本框的上边加上"顶边到基线"的距离正好落在基线上
    expect(position(text)[0]).toBe(20);
    expect(text.transform[5] + text.appearance!.baseline).toBeCloseTo(40, 3);

    // 字形库：H e l o P D F 七个字形，l 出现两次只存一份
    const [run] = text.appearance!.runs;
    expect(glyphCount(text)).toBe(8);
    expect(run!.matrix).toEqual([18, 0, 0, -18]);
    // 第一个字形的原点在文本框的左边、第一行的基线上
    expect(run!.glyphs[1]).toBeCloseTo(0, 3);
    expect(run!.glyphs[2]).toBeCloseTo(text.appearance!.baseline, 3);
    const library = result.assets.find((a) => a.meta.id === run!.library)!;
    expect(library.meta.mime).toBe(GLYPH_LIBRARY_MIME);
    // 同一个字形只存一份；每个字形还记着它代表的字和步进宽度，导出 PDF 时靠它们让文字能被搜索
    const decoded = decodeGlyphLibrary(library.bytes)!;
    expect(decoded.glyphs).toHaveLength(7);
    expect(decoded.text).toEqual(['H', 'e', 'l', 'o', 'P', 'D', 'F']);
    expect(decoded.advances![0]).toBeCloseTo(0.722, 3);
  });

  it('几行字拼成一段：行距、对齐方式和宽度都从原文件里来', async () => {
    const result = await convert(
      'BT /F1 10 Tf 14 TL 20 80 Td (First line of a) Tj T* (paragraph that goes) Tj T* (on.) Tj ET',
    );
    expect(result.on()).toHaveLength(1);
    const text = asText(result.on()[0]);
    expect(text).toMatchObject({ text: 'First line of a paragraph that goes on.', sizing: 'fixed', align: 'left' });
    expect(text.style.lineHeight).toBeCloseTo(1.4, 3);
    // 宽度是最长那一行的长度
    expect(text.size[0]).toBeGreaterThan(85);
    expect(text.size[0]).toBeLessThan(100);
    expect(glyphCount(text)).toBe(32);
  });

  it('两端对齐的段落：没顶到右边的行是一段的结尾', async () => {
    // Type3 字体里每个字正好 10 宽，行长可以精确控制
    const result = await convert(
      'BT /T3 10 Tf 14 TL 20 90 Td (aaaa) Tj T* (aaaa) Tj T* (aa) Tj T* (aaaa) Tj T* (aaaa) Tj ET',
    );
    const text = asText(result.on()[0]);
    expect(result.on()).toHaveLength(1);
    expect(text).toMatchObject({ text: 'aaaa aaaa aa\naaaa aaaa', align: 'justify', sizing: 'fixed', size: [40, 70] });
  });

  it('居中的几行保留原来的断行', async () => {
    const result = await convert('BT /T3 10 Tf 14 TL 40 80 Td (aa) Tj -10 -14 Td (aaaa) Tj ET');
    expect(asText(result.on()[0])).toMatchObject({ text: 'aa\naaaa', align: 'center', sizing: 'fixed' });
  });

  it('中文段落：行与行之间不加空格，段首缩进变成全角空格', async () => {
    const result = await convert(
      'BT /Song 10 Tf 14 TL 40 80 Td <4F60597D4F60597D> Tj -20 -14 Td <4F60597D4F60597D4F60> Tj T* <597D> Tj ET',
    );
    expect(result.on()).toHaveLength(1);
    expect(asText(result.on()[0]).text).toBe('\u3000\u3000你好你好你好你好你好');
    expect(result.report.issues.fallbackText).toBe(1);
  });

  it('字号或颜色不同的行不拼在一起', async () => {
    const result = await convert('BT /F1 18 Tf 20 80 Td (Title) Tj /F1 10 Tf 0 -24 Td (Body) Tj ET');
    expect(result.on().map((n) => asText(n).text)).toEqual(['Title', 'Body']);
  });

  it('用字距调出来的词间距补成空格；隔得很远的两段分开', async () => {
    const result = await convert(
      'BT /F1 10 Tf 20 80 Td [(Hello) -300 (World) -40 (!)] TJ 0 -40 Td [(Name) -3000 (Value)] TJ ET',
    );
    expect(result.on().map((n) => asText(n).text)).toEqual(['Hello World!', 'Name', 'Value']);
  });

  it('上标和正文接成一行', async () => {
    const result = await convert('BT /F1 10 Tf 20 80 Td (E = mc) Tj /F1 6 Tf 4 Ts (2) Tj ET');
    expect(result.on().map((n) => asText(n).text)).toEqual(['E = mc2']);
    expect(asText(result.on()[0]).style.fontSize).toBe(10);
    // 上标的字号记成字符级样式
    expect(asText(result.on()[0]).spans).toEqual([{ start: 6, end: 7, style: { fontSize: 6 } }]);
  });

  it('一行里加粗、换色的词变成字符级样式；原样显示时换色的字单独成组，带着自己的颜色', async () => {
    const result = await convert(
      'BT /F1 10 Tf 20 80 Td (Make it ) Tj /HB 10 Tf (bold) Tj /F1 10 Tf ( and ) Tj 1 0 0 rg (red) Tj 0 g ( text) Tj ET',
      {},
      { fonts: FONTS },
    );
    expect(result.on()).toHaveLength(1);
    const text = asText(result.on()[0]);
    expect(text.text).toBe('Make it bold and red text');
    expect(text.style.fontWeight).toBe(400);
    expect(text.fill).toEqual({ type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } });
    expect(text.spans).toEqual([
      { start: 8, end: 12, style: { fontWeight: 700 } },
      { start: 17, end: 20, style: { color: { r: 1, g: 0, b: 0, a: 1 } } },
    ]);
    const colored = text.appearance!.runs.filter((run) => run.color);
    expect(colored.map((run) => [run.color, run.glyphs.length / 3])).toEqual([[{ r: 1, g: 0, b: 0, a: 1 }, 3]]);
  });

  it('按字体名匹配字体类别和粗细', async () => {
    const result = await convert(
      'BT /TR 12 Tf 20 80 Td (Serif) Tj /HB 12 Tf 0 -30 Td (Bold) Tj ET',
      {},
      { fonts: FONTS },
    );
    const [serif, bold] = result.on().map(asText);
    expect(serif!.style).toMatchObject({ fontFamily: FONTS.serif, fontWeight: 400 });
    expect(bold!.style).toMatchObject({ fontFamily: FONTS.sans, fontWeight: 700 });
  });

  it('Type3 字体的字也变成可以编辑的文本', async () => {
    const result = await convert('BT /T3 10 Tf 20 60 Td (ab) Tj ET');
    const text = asText(result.on()[0]);
    expect(text).toMatchObject({ text: 'ab' });
    expect(hasLiveAppearance(text)).toBe(true);
    const [run] = text.appearance!.runs;
    expect(run!.matrix).toEqual([10, 0, 0, -10]);
    // a 是 0.8 见方的方块，b 是里面 0.6 见方的方块
    const decoded = decodeGlyphLibrary(result.assets.find((a) => a.meta.id === run!.library)!.bytes)!;
    const glyphs = decoded.glyphs;
    expect(glyphs).toHaveLength(2);
    expect(decoded.text).toEqual(['a', 'b']);
    expect(Math.max(...glyphs[0]!.filter((_, i) => i % 3 !== 0))).toBeCloseTo(0.8, 3);
  });

  it('看不见的文字（比如扫描件的识别层）不导入', async () => {
    const result = await convert('BT /F1 18 Tf 3 Tr 20 60 Td (hidden) Tj ET');
    expect(result.on()).toHaveLength(0);
  });

  it('描边的文字还不能编辑，按原样变成轮廓', async () => {
    const result = await convert('BT /F1 18 Tf 2 Tr 0.5 w 1 0 0 RG 0 0 1 rg 20 60 Td (AB) Tj ET');
    expect(result.on()[0]).toMatchObject({
      type: 'path',
      name: 'AB',
      fill: { color: { r: 0, g: 0, b: 1 } },
      stroke: { width: 0.5, color: { r: 1, g: 0, b: 0 } },
    });
  });

  it('没有内嵌字体的文字改用匹配的字体重排，并记进报告', async () => {
    const result = await convert('BT /Song 20 Tf 30 50 Td <4F60597D> Tj ET', {}, { fonts: FONTS });
    const text = asText(result.on()[0]);
    expect(text).toMatchObject({ text: '你好', sizing: 'auto' });
    // 宋体是衬线一类
    expect(text.style).toMatchObject({ fontSize: 20, fontFamily: FONTS.serif });
    expect(text.appearance).toBeUndefined();
    // 基线在页面的 y = 50，文本框的上边在它上方大约一个字号处
    expect(position(text)[0]).toBe(30);
    expect(position(text)[1]).toBeCloseTo(31, 0);
    expect(result.report.issues.fallbackText).toBe(1);
  });
});

describe('字体匹配', () => {
  const font = (name: string, flags: { serif?: boolean; monospace?: boolean; bold?: boolean } = {}) => ({
    name,
    bold: flags.bold ?? false,
    italic: false,
    serif: flags.serif ?? false,
    monospace: flags.monospace ?? false,
  });

  it('按名字认出斜体', () => {
    const italic = [
      'Times-Italic',
      'Helvetica-Oblique',
      'ABCDEF+Arial-ItalicMT',
      'MinionPro-It',
      'MinionPro-BoldIt',
      'CMTI10',
      'CMSL12',
    ];
    const upright = ['Times-Roman', 'Helvetica-Bold', 'ABCDEF+Inter-Regular', 'CMR10', 'Courier', 'Digit'];
    expect(italic.filter((name) => !fontItalic(font(name)))).toEqual([]);
    expect(upright.filter((name) => fontItalic(font(name)))).toEqual([]);
    expect(fontItalic({ ...font('Unknown'), italic: true })).toBe(true);
  });

  it('按名字认出类别', () => {
    const cases: [string, string][] = [
      ['ABCDEF+Times-Roman', 'serif'],
      ['Helvetica-Bold', 'sans'],
      ['Courier', 'mono'],
      ['SimSun', 'serif'],
      ['MicrosoftYaHei', 'sans'],
      ['ABCDEF+PingFangSC-Semibold', 'sans'],
      ['CMR10', 'serif'],
      ['CMTT10', 'mono'],
      ['NotoSerifCJKsc-Regular', 'serif'],
      ['SourceHanSansSC-Medium', 'sans'],
    ];
    for (const [name, category] of cases) expect([name, fontCategory(font(name))]).toEqual([name, category]);
  });

  it('名字看不出来时用字体描述里的标志', () => {
    expect(fontCategory(font('XYZ123', { serif: true }))).toBe('serif');
    expect(fontCategory(font('XYZ123', { monospace: true }))).toBe('mono');
    expect(fontCategory(font('XYZ123'))).toBe('sans');
  });

  it('按名字认出粗细', () => {
    const cases: [string, number][] = [
      ['Helvetica', 400],
      ['Helvetica-Bold', 700],
      ['Inter-SemiBold', 600],
      ['Roboto-Light', 300],
      ['Roboto-ExtraLight', 200],
      ['Montserrat-Black', 900],
      ['HiraginoSans-W6', 600],
      ['SourceHanSansSC-Medium', 500],
    ];
    for (const [name, weight] of cases) expect([name, fontWeight(font(name))]).toEqual([name, weight]);
    expect(fontWeight(font('XYZ', { bold: true }))).toBe(700);
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
