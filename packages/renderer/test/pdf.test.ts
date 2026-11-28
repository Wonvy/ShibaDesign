import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  DocStore,
  GLYPH_LIBRARY_MIME,
  createNode,
  decodeGlyphLibrary,
  encodeGlyphLibrary,
  gradientColorAt,
  rgba,
  setCharacterStyle,
  solid,
  textAppearanceBasis,
  type ArtboardNode,
  type DocumentData,
  type GradientFill,
  type GradientStop,
  type ImageFill,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import { encodePng, importPdf, type PdfEnvironment } from '@shiba/io';
import {
  FontManager,
  GeometryCache,
  ImageCache,
  NodeTypeRegistry,
  TextAppearances,
  TextLayouts,
  createTextNodeType,
  ensureTextFonts,
  loadCanvasKit,
  parseUnicodeRange,
  registerBuiltinNodeTypes,
  type CanvasKit,
  type FontFaceSource,
} from '../src';
import { exportPdf, type PdfExportContext } from '../src/pdf';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const environment: PdfEnvironment = {
  pdfjs,
  standardFontDataUrl: `${pdfjsRoot}/standard_fonts/`,
  cMapUrl: `${pdfjsRoot}/cmaps/`,
  wasmUrl: `${pdfjsRoot}/wasm/`,
  iccUrl: `${pdfjsRoot}/iccs/`,
};

function file(specifier: string): ArrayBuffer {
  const buffer = readFileSync(require.resolve(specifier));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** fontsource 的字体包：排版用 woff2，嵌进 PDF 用同一个分片的 woff */
function fontsourceFaces(pkg: string, prefix: string): FontFaceSource[] {
  const unicode = require(`${pkg}/unicode.json`) as Record<string, string>;
  const faces: FontFaceSource[] = [];
  for (const [key, range] of Object.entries(unicode)) {
    const chunk = key.replace(/[[\]]/g, '');
    for (const weight of [400, 700]) {
      for (const italic of [false, true]) {
        const name = `${pkg}/files/${prefix}-${chunk}-${weight}-${italic ? 'italic' : 'normal'}`;
        if (
          !existsSync(
            path.join(path.dirname(require.resolve(`${pkg}/package.json`)), name.slice(pkg.length + 1) + '.woff2'),
          )
        )
          continue;
        faces.push({
          chunk,
          weight,
          italic,
          ranges: parseUnicodeRange(range),
          load: async () => file(`${name}.woff2`),
          loadEmbeddable: async () => file(`${name}.woff`),
        });
      }
    }
  }
  return faces;
}

const FAMILIES = ['Inter', 'Noto Sans SC'];

function setup() {
  const store = DocStore.create();
  const assets = new AssetStore();
  const fonts = new FontManager(ck);
  fonts.addFamily({ name: 'Inter', faces: fontsourceFaces('@fontsource/inter', 'inter') });
  fonts.addFamily({ name: 'Noto Sans SC', faces: fontsourceFaces('@fontsource/noto-sans-sc', 'noto-sans-sc') });
  const layouts = new TextLayouts(ck, store, fonts);
  const appearances = new TextAppearances(ck, store, assets);
  const registry = registerBuiltinNodeTypes(new NodeTypeRegistry()).register(createTextNodeType(layouts, appearances));
  const geometry = new GeometryCache(ck, store, registry);
  const images = new ImageCache(ck, assets);
  fonts.onChange(() => {
    layouts.clear();
    geometry.invalidate((n) => n.type === 'text');
  });
  const board = store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: store.indexOnTop(store.root.id),
        seq: 1,
        size: [400, 300],
        fill: solid(rgba(1, 1, 1)),
        deck: null,
      }),
    ),
  ) as ArtboardNode;
  const context: PdfExportContext = { ck, store, registry, geometry, layouts, fonts, appearances, images, assets };
  const add = <T extends SceneNode>(node: T): T => store.transact('add', (tx) => tx.create(node)) as T;
  const on = (parent = board.id) => ({ parent, index: store.indexOnTop(parent), seq: 1 });
  return { store, assets, fonts, layouts, context, board, add, on };
}

type Env = ReturnType<typeof setup>;

function text(env: Env, value: string, patch: Partial<TextNode> = {}): TextNode {
  return env.add(
    createNode('text', {
      ...env.on(),
      transform: [1, 0, 0, 1, 20, 120],
      text: value,
      style: {
        fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
        fontSize: 20,
        fontWeight: 400,
        lineHeight: 1.4,
        letterSpacing: 0,
      },
      align: 'left',
      sizing: 'auto',
      fill: solid(rgba(0, 0, 0)),
      ...patch,
    }),
  );
}

async function exportAndOpen(env: Env) {
  for (const node of env.store.children(env.board.id)) {
    if (node.type === 'text') await ensureTextFonts(env.fonts, node);
  }
  await Promise.resolve();
  const bytes = await exportPdf(env.context, [env.board.id], { title: '导出测试' });
  const { standardFontDataUrl, cMapUrl } = environment;
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl, cMapUrl });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const textContent = content.items.map((item) => ('str' in item ? item.str : '')).join('');
  const ops = await page.getOperatorList();
  await task.destroy();
  return { bytes, page, textContent, ops };
}

/** 用我们自己的导入器把导出的 PDF 读回来 */
async function reimport(bytes: Uint8Array) {
  const result = await importPdf(environment, bytes);
  const nodes = Object.values(result.document.nodes);
  const childrenOf = (id: string): SceneNode[] =>
    nodes.filter((n) => n.parent === id).sort((a, b) => (a.index < b.index ? -1 : 1));
  const [board] = childrenOf(result.document.rootId);
  return { result, board: board!, items: childrenOf(board!.id), childrenOf, document: result.document as DocumentData };
}

/** 2 × 2 的 PNG：红、绿、蓝、白 */
function checkerPng(): Uint8Array {
  return encodePng(2, 2, new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), 3);
}

function pixelsOf(bytes: Uint8Array): Uint8Array {
  const image = ck.MakeImageFromEncoded(bytes)!;
  const pixels = image.readPixels(0, 0, {
    width: image.width(),
    height: image.height(),
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  }) as Uint8Array;
  image.delete();
  return pixels;
}

describe('导出 PDF', () => {
  it('画板是一页，形状、颜色、描边、透明度、混合模式写成矢量，读回来还是同样的对象', async () => {
    const env = setup();
    env.add(
      createNode('rect', {
        ...env.on(),
        transform: [1, 0, 0, 1, 20, 20],
        size: [100, 60],
        cornerRadius: 0,
        fill: solid(rgba(1, 0, 0)),
        stroke: { color: rgba(0, 0, 1), width: 4 },
      }),
    );
    env.add(
      createNode('ellipse', {
        ...env.on(),
        transform: [1, 0, 0, 1, 150, 20],
        size: [80, 60],
        opacity: 0.5,
        blendMode: 'multiply',
        fill: solid(rgba(0, 0.5, 0)),
        stroke: null,
      }),
    );
    env.add(
      createNode('rect', {
        ...env.on(),
        transform: [1, 0, 0, 1, 260, 20],
        size: [80, 60],
        cornerRadius: 12,
        fill: solid(rgba(0.2, 0.4, 0.6, 0.5)),
        stroke: null,
      }),
    );

    const { page, bytes } = await exportAndOpen(env);
    expect(page.view).toEqual([0, 0, 400, 300]);

    const back = await reimport(bytes);
    expect(back.board.size).toEqual([400, 300]);
    const [rect, ellipse, rounded] = back.items;
    expect(rect).toMatchObject({
      type: 'rect',
      transform: [1, 0, 0, 1, 20, 20],
      size: [100, 60],
      fill: solid(rgba(1, 0, 0)),
      stroke: { color: rgba(0, 0, 1), width: 4 },
    });
    expect(ellipse).toMatchObject({ type: 'ellipse', size: [80, 60], blendMode: 'multiply' });
    // 只有一种颜色的形状，不透明度直接乘在颜色上写出去，读回来落在填充色的透明度里，看起来一样
    const { opacity, fill } = ellipse as SceneNode & { fill: { color: { a: number } } };
    expect(opacity * fill.color.a).toBeCloseTo(0.5, 2);
    expect(rounded).toMatchObject({ type: 'rect', cornerRadius: 12 });
    expect((rounded as { fill: { color: { a: number } } }).fill.color.a).toBeCloseTo(0.5, 2);
  });

  it('编组的不透明度写成透明组：先合成再整体变淡，重叠处不会更深', async () => {
    const env = setup();
    const group = env.add(createNode('group', { ...env.on(), opacity: 0.5 }));
    for (const x of [20, 60]) {
      env.add(
        createNode('rect', {
          ...env.on(group.id),
          transform: [1, 0, 0, 1, x, 20],
          size: [80, 80],
          cornerRadius: 0,
          fill: solid(rgba(1, 0.8, 0)),
          stroke: null,
        }),
      );
    }
    const { ops } = await exportAndOpen(env);
    expect(ops.fnArray).toContain(pdfjs.OPS.beginGroup);
    const back = await reimport((await exportAndOpen(env)).bytes);
    const [restored] = back.items;
    expect(restored).toMatchObject({ type: 'group', opacity: 0.5 });
    expect(back.childrenOf(restored!.id)).toHaveLength(2);
  });

  it('布尔组写成运算结果的路径', async () => {
    const env = setup();
    const union = env.add(
      createNode('boolean', { ...env.on(), op: 'union', fill: solid(rgba(0, 0, 0)), stroke: null }),
    );
    for (const x of [20, 60]) {
      env.add(
        createNode('rect', {
          ...env.on(union.id),
          transform: [1, 0, 0, 1, x, 20],
          size: [60, 60],
          cornerRadius: 0,
          fill: solid(rgba(1, 0, 0)),
          stroke: null,
        }),
      );
    }
    const back = await reimport((await exportAndOpen(env)).bytes);
    // 两个方块的并集：一个形状，范围正好是 100 × 60（运算结果的边上留着多余的点，读回来是钢笔路径）
    expect(back.items).toHaveLength(1);
    expect(back.items[0]).toMatchObject({ transform: [1, 0, 0, 1, 20, 20], size: [100, 60] });
  });

  it('文字是真正的文字：嵌入子集化的字体，能复制出原文，读回来还是可以编辑的文本', async () => {
    const env = setup();
    text(env, 'Hello 你好 world');
    const { textContent, bytes } = await exportAndOpen(env);
    expect(textContent).toBe('Hello 你好 world');
    // 只嵌入用到的字形：两个字体的子集加起来也就几十 KB
    expect(bytes.length).toBeLessThan(60_000);

    const back = await reimport(bytes);
    const [restored] = back.items;
    expect(restored).toMatchObject({ type: 'text', text: 'Hello 你好 world' });
  });

  it('字符级样式：粗体、斜体用各自的字体文件，颜色按段写，下划线画成横线；读回来还是同样的样式', async () => {
    const env = setup();
    const node = text(env, 'Plain bold italic red');
    let styled = { ...node, ...setCharacterStyle(node, 6, 10, { fontWeight: 700 }) } as TextNode;
    styled = { ...styled, ...setCharacterStyle(styled, 11, 17, { italic: true }) } as TextNode;
    styled = { ...styled, ...setCharacterStyle(styled, 18, 21, { color: rgba(1, 0, 0), underline: true }) } as TextNode;
    env.store.transact('style', (tx) => tx.update(node.id, { spans: styled.spans }));

    const { textContent, bytes, ops } = await exportAndOpen(env);
    expect(textContent).toBe('Plain bold italic red');
    const fonts = new Set(new TextDecoder('latin1').decode(bytes).match(/\/BaseFont \/[A-Z]{6}\+[\w-]+/g));
    expect([...fonts].map((f) => f.replace(/.*\+/, '')).sort()).toEqual([
      'Inter-Bold',
      'Inter-Italic',
      'Inter-Regular',
    ]);
    // 红色写了一次，下划线是一个填充的矩形
    const colors = ops.fnArray.flatMap((fn, i) => (fn === pdfjs.OPS.setFillRGBColor ? [ops.argsArray[i]] : []));
    expect(colors.length).toBeGreaterThanOrEqual(2);

    const back = await reimport(bytes);
    const restored = back.items.find((n): n is TextNode => n.type === 'text')!;
    expect(restored.text).toBe('Plain bold italic red');
    expect(restored.spans).toEqual([
      { start: 6, end: 10, style: { fontWeight: 700 } },
      { start: 11, end: 17, style: { italic: true } },
      { start: 18, end: 21, style: { color: rgba(1, 0, 0) } },
    ]);
    // 下划线读回来是文字下面的一条细长矩形
    expect(back.items.some((n) => n.type === 'rect' && n.size[1] < 3 && n.size[0] > 10)).toBe(true);
  });

  it('每个字的位置和排版结果一致：字距、两端对齐拉开的空格都写进去了', async () => {
    const env = setup();
    const node = text(env, 'Ab cd ef gh ij kl mn op qr st uv', {
      sizing: 'fixed',
      size: [200, 0],
      align: 'justify',
      style: {
        fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
        fontSize: 20,
        fontWeight: 400,
        lineHeight: 1.4,
        letterSpacing: 3,
      },
    });
    const { bytes } = await exportAndOpen(env);
    const expected: number[] = [];
    for (const line of env.layouts.get(env.store.require(node.id) as TextNode).blocks[0]!.paragraph.getShapedLines()) {
      for (const run of line.runs) {
        for (let i = 0; i < run.glyphs.length; i++) {
          // 空格没有轮廓，导入时不会留下字形（这段字全是 ASCII，字节偏移就是字符下标）
          if (node.text[run.offsets[i]!] !== ' ') expected.push(run.positions[i * 2]! + 20);
        }
      }
    }
    const back = await reimport(bytes);
    const actual: number[] = [];
    for (const item of back.items) {
      if (item.type !== 'text') continue;
      for (const run of item.appearance!.runs) {
        for (let i = 0; i < run.glyphs.length; i += 3) actual.push(run.glyphs[i + 1]! + item.transform[4]);
      }
    }
    expect(actual.length).toBe(expected.length);
    actual.forEach((x, i) => expect(x).toBeCloseTo(expected[i]!, 1));
  });

  it('列表的编号写成真正的文字，可以复制出来', async () => {
    const env = setup();
    text(env, 'One\nTwo', { paragraphs: [{ list: 'number' }, { list: 'number' }] });
    const { textContent } = await exportAndOpen(env);
    expect(textContent.replace(/\s+/g, '')).toBe('1.One2.Two');
  });

  it('排版用的 WOFF2 和嵌入用的 WOFF 字形编号不一致时，按字符换成嵌入文件里的字形（全角冒号）', async () => {
    const env = setup();
    text(env, '：', { style: { ...text(setup(), '').style, fontSize: 100 } });
    const { textContent, bytes } = await exportAndOpen(env);
    expect(textContent).toBe('：');
    // 读回来的字形是上下两个窄窄的点；换错时是数字 4
    const back = await reimport(bytes);
    const library = back.result.assets.find((a) => a.meta.mime === GLYPH_LIBRARY_MIME)!;
    const [outline] = decodeGlyphLibrary(library.bytes)!.glyphs;
    const xs: number[] = [];
    const ARITY = [2, 2, 6, 4, 0];
    let moves = 0;
    for (let i = 0; i < outline!.length;) {
      const verb = outline![i++]!;
      if (verb === 0) moves++;
      for (let k = 0; k < ARITY[verb]!; k += 2) xs.push(outline![i + k]!);
      i += ARITY[verb]!;
    }
    expect(moves).toBe(2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.25);
  });

  it('从 PDF 导入、没改过的文字按原字形写成 Type3 字体，仍然能复制出文字', async () => {
    const env = setup();
    const square = [0, 0, 0, 1, 0.7, 0, 1, 0.7, 0.7, 1, 0, 0.7, 4];
    const meta = await env.assets.add(encodeGlyphLibrary([square], { text: ['口'], advances: [0.8] }), {
      mime: GLYPH_LIBRARY_MIME,
      width: 0,
      height: 0,
    });
    const node = text(env, '口口', { size: [40, 28] });
    const appearance = {
      runs: [{ library: meta.id, matrix: [20, 0, 0, -20] as const, glyphs: [0, 0, 20, 0, 16, 20] }],
      basis: textAppearanceBasis(node),
      baseline: 20,
    };
    env.store.transact('freeze', (tx) => tx.update(node.id, { appearance }));

    const { textContent, ops, bytes } = await exportAndOpen(env);
    expect(textContent).toBe('口口');
    expect(ops.fnArray).toContain(pdfjs.OPS.showText);
    const back = await reimport(bytes);
    expect(back.items[0]).toMatchObject({ type: 'text', text: '口口' });
  });

  it('图片裁成形状放进去，调色先在像素上做好', async () => {
    const env = setup();
    const meta = await env.assets.add(checkerPng(), { mime: 'image/png', width: 2, height: 2 });
    const fill = (adjust?: ImageFill['adjust']): ImageFill => ({
      type: 'image',
      assetId: meta.id,
      fit: 'cover',
      adjust,
    });
    env.add(
      createNode('rect', {
        ...env.on(),
        transform: [1, 0, 0, 1, 20, 20],
        size: [100, 100],
        cornerRadius: 0,
        fill: fill(),
        stroke: null,
      }),
    );
    env.add(
      createNode('ellipse', {
        ...env.on(),
        transform: [1, 0, 0, 1, 200, 20],
        size: [100, 100],
        fill: fill({ brightness: 0, contrast: 0, saturation: -100, temperature: 0, tint: 0, hue: 0, blur: 0 }),
        stroke: null,
      }),
    );
    const { ops, bytes } = await exportAndOpen(env);
    expect(ops.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject)).toHaveLength(2);

    const back = await reimport(bytes);
    const [plain, gray] = back.items as (SceneNode & { fill: ImageFill })[];
    expect(plain).toMatchObject({ type: 'rect', size: [100, 100], fill: { type: 'image' } });
    // 圆形裁剪的图片读回来还是一个填了图片的椭圆
    expect(gray).toMatchObject({ type: 'ellipse', fill: { type: 'image' } });
    const original = pixelsOf(back.result.assets.find((a) => a.meta.id === plain!.fill.assetId)!.bytes);
    expect([...original.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const desaturated = pixelsOf(back.result.assets.find((a) => a.meta.id === gray!.fill.assetId)!.bytes);
    // 去色之后红色变成灰色
    expect(desaturated[0]).toBe(desaturated[1]);
    expect(desaturated[1]).toBe(desaturated[2]);
  });

  it('渐变写成 PDF 原生的渐变：线性、径向、画板背景，带透明度的色标读回来还是同样的渐变', async () => {
    const env = setup();
    const linear = (stops: GradientStop[]) => ({
      type: 'gradient' as const,
      kind: 'linear' as const,
      start: { x: 0, y: 0.5 },
      end: { x: 1, y: 0.5 },
      stops,
    });
    env.store.transact('bg', (tx) =>
      tx.update(env.board.id, {
        fill: linear([
          { offset: 0, color: rgba(1, 1, 1) },
          { offset: 1, color: rgba(0.8, 0.8, 1) },
        ]),
      }),
    );
    env.add(
      createNode('rect', {
        ...env.on(),
        transform: [1, 0, 0, 1, 20, 20],
        size: [200, 100],
        cornerRadius: 0,
        fill: linear([
          { offset: 0, color: rgba(1, 0, 0) },
          { offset: 0.5, color: rgba(0, 1, 0) },
          { offset: 1, color: rgba(0, 0, 1) },
        ]),
        stroke: null,
      }),
    );
    env.add(
      createNode('ellipse', {
        ...env.on(),
        transform: [1, 0, 0, 1, 250, 50],
        size: [100, 100],
        fill: {
          type: 'gradient',
          kind: 'radial',
          start: { x: 0.5, y: 0.5 },
          end: { x: 1, y: 0.5 },
          stops: [
            { offset: 0, color: rgba(1, 1, 0, 0) },
            { offset: 1, color: rgba(1, 0.5, 0, 1) },
          ],
        },
        stroke: null,
      }),
    );

    const { ops, bytes } = await exportAndOpen(env);
    expect(ops.fnArray.filter((fn) => fn === pdfjs.OPS.shadingFill).length).toBeGreaterThanOrEqual(3);

    const back = await reimport(bytes);
    expect(back.result.report.issues).toMatchObject({ gradients: 0, softMasks: 0 });
    expect(back.board).toMatchObject({ fill: { type: 'gradient', kind: 'linear' } });
    const [rect, ellipse] = back.items as (SceneNode & { fill: GradientFill })[];
    expect(rect).toMatchObject({
      type: 'rect',
      fill: { kind: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
    });
    const quarter = gradientColorAt(rect!.fill.stops, 0.25);
    expect([quarter.r, quarter.g, quarter.b]).toEqual([
      expect.closeTo(0.5, 1),
      expect.closeTo(0.5, 1),
      expect.closeTo(0, 1),
    ]);
    // 透明度写成软蒙版，读回来又乘回色标里
    expect(ellipse).toMatchObject({
      type: 'ellipse',
      fill: { kind: 'radial', start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 } },
    });
    expect(gradientColorAt(ellipse!.fill.stops, 0).a).toBeCloseTo(0, 1);
    expect(gradientColorAt(ellipse!.fill.stops, 0.5).a).toBeCloseTo(0.5, 1);
    expect(gradientColorAt(ellipse!.fill.stops, 1).a).toBeCloseTo(1, 1);
  });

  it('蒙版组：形状写成裁剪路径，透明度和亮度写成软蒙版，读回来还是同样的蒙版组', async () => {
    const env = setup();
    const maskGroup = (mode: 'shape' | 'alpha' | 'luminance', x: number, mask: SceneNode) => {
      const group = env.add(createNode('group', { ...env.on(), mask: mode }));
      env.add(
        createNode('rect', {
          ...env.on(group.id),
          transform: [1, 0, 0, 1, x, 20],
          size: [100, 100],
          cornerRadius: 0,
          fill: solid(rgba(1, 0, 0)),
          stroke: null,
        }),
      );
      env.add({ ...mask, ...env.on(group.id) } as SceneNode);
    };
    const circle = (x: number, color: ReturnType<typeof rgba>) =>
      createNode('ellipse', {
        parent: null,
        index: '',
        seq: 1,
        transform: [1, 0, 0, 1, x + 20, 40],
        size: [60, 60],
        fill: solid(color),
        stroke: null,
      });
    maskGroup('shape', 20, circle(20, rgba(0, 0, 1)));
    maskGroup('alpha', 140, circle(140, rgba(0, 0, 0, 0.5)));
    maskGroup('luminance', 260, circle(260, rgba(1, 1, 1)));

    const { bytes } = await exportAndOpen(env);
    const back = await reimport(bytes);
    expect(back.result.report.issues).toMatchObject({ clips: 0, softMasks: 0 });
    // 纯色方块被圆形裁剪：导入时直接变成一个红色的圆，看起来一样、编辑起来更简单
    expect(back.items.map((n) => [n.type, (n as { mask?: string }).mask])).toEqual([
      ['ellipse', undefined],
      ['group', 'alpha'],
      ['group', 'luminance'],
    ]);
    expect(back.items[0]).toMatchObject({ size: [60, 60], fill: solid(rgba(1, 0, 0)) });
    for (const group of back.items.slice(1)) {
      const children = back.childrenOf(group.id);
      // 被遮的方块在下面，蒙版（圆）在最上面
      expect(children[0]).toMatchObject({ type: 'rect', size: [100, 100] });
      expect(children.at(-1)).toMatchObject({ type: 'ellipse', size: [60, 60] });
    }
    // 透明度蒙版的半透明读回来还在
    const alphaMask = back.childrenOf(back.items[1]!.id).at(-1) as SceneNode & { fill: { color: { a: number } } };
    expect(alphaMask.fill.color.a * alphaMask.opacity).toBeCloseTo(0.5, 2);
  });

  it('不知道怎么写成矢量的节点画成图片放进去', async () => {
    const env = setup();
    env.context.registry.register({
      type: 'sparkle' as never,
      children: 'none',
      outline: (_node, { ck }) => new ck.Path(),
      draw: () => {},
    });
    env.add({ ...createNode('group', env.on()), type: 'sparkle' } as unknown as SceneNode);
    let asked = 0;
    env.context.rasterize = () => {
      asked++;
      return { png: checkerPng(), box: { x: 10, y: 10, w: 40, h: 40 } };
    };
    const { ops } = await exportAndOpen(env);
    expect(asked).toBe(1);
    expect(ops.fnArray).toContain(pdfjs.OPS.paintImageXObject);
  });
});
