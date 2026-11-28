import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssetStore,
  DocStore,
  GLYPH_LIBRARY_MIME,
  createNode,
  encodeGlyphLibrary,
  rgba,
  setCharacterStyle,
  solid,
  textAppearanceBasis,
  type ArtboardNode,
  type ImageFill,
  type SceneNode,
  type TextNode,
} from '@shiba/core';
import { GlyphOutlines, encodePng, parseSfnt, toSfnt, toWoff } from '@shiba/io';
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
import {
  SVG_ID_PLACEHOLDER,
  SvgLayers,
  exportSvg,
  exportSvgNodes,
  type SvgExportContext,
  type SvgTextMode,
} from '../src/svg';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

function file(specifier: string): ArrayBuffer {
  const buffer = readFileSync(require.resolve(specifier));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** fontsource 的字体包：排版用 woff2，嵌入用同一个分片的 woff */
function fontsourceFaces(pkg: string, prefix: string): FontFaceSource[] {
  const unicode = require(`${pkg}/unicode.json`) as Record<string, string>;
  const root = path.dirname(require.resolve(`${pkg}/package.json`));
  const faces: FontFaceSource[] = [];
  for (const [key, range] of Object.entries(unicode)) {
    const chunk = key.replace(/[[\]]/g, '');
    for (const weight of [400, 700]) {
      for (const italic of [false, true]) {
        const name = `${prefix}-${chunk}-${weight}-${italic ? 'italic' : 'normal'}`;
        if (!existsSync(path.join(root, 'files', `${name}.woff2`))) continue;
        faces.push({
          chunk,
          weight,
          italic,
          ranges: parseUnicodeRange(range),
          load: async () => file(`${pkg}/files/${name}.woff2`),
          loadEmbeddable: async () => file(`${pkg}/files/${name}.woff`),
        });
      }
    }
  }
  return faces;
}

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
  const context: SvgExportContext = { ck, store, registry, geometry, layouts, fonts, appearances, images, assets };
  const add = <T extends SceneNode>(node: T): T => store.transact('add', (tx) => tx.create(node)) as T;
  const on = (parent = board.id) => ({ parent, index: store.indexOnTop(parent), seq: 1 });
  return { store, assets, fonts, context, board, add, on };
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

async function exportBoard(env: Env, mode: SvgTextMode = 'text'): Promise<string> {
  for (const node of env.store.children(env.board.id)) {
    if (node.type === 'text') await ensureTextFonts(env.fonts, node);
  }
  await Promise.resolve();
  return exportSvg(env.context, env.board.id, { text: mode, title: '导出 <测试>' });
}

/** 2 × 2 的 PNG：红、绿、蓝、白 */
function checkerPng(): Uint8Array {
  return encodePng(2, 2, new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), 3);
}

/** 所有某种元素的属性表 */
function elements(svg: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const match of svg.matchAll(new RegExp(`<${tag}(\\s[^>]*?)?/?>`, 'g'))) {
    const attrs: Record<string, string> = {};
    for (const [, key, value] of (match[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[key!] = value!;
    out.push(attrs);
  }
  return out;
}

/** 第 i 个 <tspan> 里的文字 */
function svgSpanText(svg: string, index: number): string {
  const match = [...svg.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/g)][index];
  return match ? match[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '';
}

/** <text> 里的文字（去掉标签、还原转义） */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) =>
    m[1]!
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  );
}

describe('导出 SVG', () => {
  it('画板是一个 SVG：尺寸、背景、矩形、椭圆、路径、描边、透明度、混合模式', async () => {
    const env = setup();
    env.add(
      createNode('rect', {
        ...env.on(),
        transform: [1, 0, 0, 1, 20, 20],
        size: [100, 60],
        cornerRadius: 50,
        fill: solid(rgba(1, 0, 0)),
        stroke: { color: rgba(0, 0, 1, 0.5), width: 4 },
      }),
    );
    env.add(
      createNode('ellipse', {
        ...env.on(),
        transform: [0, 1, -1, 0, 250, 20],
        size: [80, 60],
        opacity: 0.5,
        blendMode: 'multiply',
        fill: solid(rgba(0, 0.5, 0)),
        stroke: null,
      }),
    );
    env.add(
      createNode('path', {
        ...env.on(),
        subpaths: [
          {
            closed: true,
            anchors: [
              { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
              { x: 40, y: 0, inX: 40, inY: 0, outX: 40, outY: 0 },
              { x: 20, y: 30, inX: 20, inY: 30, outX: 20, outY: 30 },
            ],
          },
        ],
        fillRule: 'evenodd',
        size: [40, 30],
        fill: null,
        stroke: { color: rgba(0, 0, 0), width: 2 },
      }),
    );
    const svg = await exportBoard(env);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(
      true,
    );
    expect(elements(svg, 'svg')[0]).toMatchObject({ width: '400', height: '300', viewBox: '0 0 400 300' });
    expect(svg).toContain('<title>导出 &lt;测试&gt;</title>');
    const [background, rect] = elements(svg, 'rect');
    expect(background).toEqual({ width: '400', height: '300', fill: '#ffffff' });
    // 圆角超过短边的一半时按一半算，和画布一样
    expect(rect).toEqual({
      width: '100',
      height: '60',
      rx: '30',
      ry: '30',
      fill: '#ff0000',
      stroke: '#0000ff',
      'stroke-opacity': '0.5',
      'stroke-width': '4',
      transform: 'translate(20 20)',
    });
    expect(elements(svg, 'ellipse')[0]).toEqual({
      cx: '40',
      cy: '30',
      rx: '40',
      ry: '30',
      fill: '#008000',
      transform: 'matrix(0 1 -1 0 250 20)',
      opacity: '0.5',
      style: 'mix-blend-mode:multiply',
    });
    const [triangle] = elements(svg, 'path');
    expect(triangle).toMatchObject({
      d: 'M0 0L40 0L20 30L0 0Z',
      'fill-rule': 'evenodd',
      fill: 'none',
      'stroke-width': '2',
    });
  });

  it('虚线描边写成 stroke-dasharray，矩形改写成路径（虚线从路径起点排，和画布一致）', async () => {
    const env = setup();
    env.add(
      createNode('rect', {
        ...env.on(),
        size: [100, 60],
        cornerRadius: 0,
        fill: null,
        stroke: { color: rgba(0, 0, 0), width: 2, dash: [6], dashOffset: 1, cap: 'square', join: 'round' },
      }),
    );
    const svg = await exportBoard(env);
    expect(elements(svg, 'rect')).toHaveLength(1);
    expect(elements(svg, 'path')[0]).toMatchObject({
      d: 'M0 0L100 0L100 60L0 60Z',
      'stroke-dasharray': '6 6',
      'stroke-dashoffset': '1',
      'stroke-linecap': 'square',
      'stroke-linejoin': 'round',
    });
  });

  it('编组的不透明度写在 <g> 上（先合成再整体变淡），只有一个对象时不多包一层', async () => {
    const env = setup();
    const group = env.add(createNode('group', { ...env.on(), opacity: 0.5, transform: [1, 0, 0, 1, 10, 10] }));
    for (const x of [20, 60]) {
      env.add(
        createNode('rect', {
          ...env.on(group.id),
          transform: [1, 0, 0, 1, x, 20],
          size: [80, 80],
          cornerRadius: 0,
          fill: solid(rgba(0, 0, 1)),
          stroke: null,
        }),
      );
    }
    const svg = await exportBoard(env);
    expect(elements(svg, 'g')).toEqual([{ transform: 'translate(10 10)', opacity: '0.5' }]);
    expect(elements(svg, 'rect')).toHaveLength(3);
  });

  it('渐变：线性、椭圆的径向、带透明度的色标、画板背景，几何写在本地坐标里', async () => {
    const env = setup();
    env.store.transact('bg', (tx) =>
      tx.update(env.board.id, {
        fill: {
          type: 'gradient',
          kind: 'linear',
          start: { x: 0, y: 0 },
          end: { x: 1, y: 0 },
          stops: [
            { offset: 0, color: rgba(1, 1, 1) },
            { offset: 1, color: rgba(0, 0, 0) },
          ],
        },
      }),
    );
    env.add(
      createNode('ellipse', {
        ...env.on(),
        transform: [1, 0, 0, 1, 100, 50],
        size: [200, 100],
        fill: {
          type: 'gradient',
          kind: 'radial',
          start: { x: 0.5, y: 0.5 },
          end: { x: 1, y: 0.5 },
          aspect: 0.5,
          stops: [
            { offset: 0, color: rgba(1, 0, 0) },
            { offset: 0.5, color: rgba(1, 0, 0, 0.25) },
            { offset: 0.5, color: rgba(0, 0, 1) },
          ],
        },
        stroke: null,
      }),
    );
    const svg = await exportBoard(env);
    expect(elements(svg, 'linearGradient')[0]).toMatchObject({
      gradientUnits: 'userSpaceOnUse',
      x1: '0',
      y1: '0',
      x2: '400',
      y2: '0',
    });
    const radial = elements(svg, 'radialGradient')[0]!;
    expect(radial).toMatchObject({ gradientUnits: 'userSpaceOnUse', cx: '100', cy: '50', r: '100' });
    // 沿垂直于半径的方向压扁一半
    expect(radial.gradientTransform).toBe('matrix(1 0 0 0.5 0 25)');
    // 硬过渡：两个色标在同一位置
    expect(elements(svg, 'stop').slice(2)).toEqual([
      { offset: '0', 'stop-color': '#ff0000' },
      { offset: '0.5', 'stop-color': '#ff0000', 'stop-opacity': '0.25' },
      { offset: '0.5', 'stop-color': '#0000ff' },
    ]);
    expect(elements(svg, 'ellipse')[0]!.fill).toBe(`url(#${radial.id})`);
  });

  it('蒙版组：形状写成 clipPath，透明度和亮度写成 mask', async () => {
    const env = setup();
    const maskGroup = (mode: 'shape' | 'alpha' | 'luminance', x: number) => {
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
      env.add(
        createNode('ellipse', {
          ...env.on(group.id),
          transform: [1, 0, 0, 1, x + 20, 40],
          size: [60, 60],
          fill: solid(rgba(1, 1, 1, 0.5)),
          stroke: null,
        }),
      );
    };
    maskGroup('shape', 20);
    maskGroup('alpha', 140);
    maskGroup('luminance', 260);
    const svg = await exportBoard(env);
    const [clip] = elements(svg, 'clipPath');
    expect(clip).toMatchObject({ clipPathUnits: 'userSpaceOnUse' });
    expect(svg).toMatch(/<clipPath[^>]*>\s*<ellipse cx="30" cy="30" rx="30" ry="30" transform="translate\(40 40\)"\/>/);
    const masks = elements(svg, 'mask');
    expect(masks).toHaveLength(2);
    expect(masks[0]).toMatchObject({ maskUnits: 'userSpaceOnUse', 'mask-type': 'alpha' });
    expect(masks[1]!['mask-type']).toBeUndefined();
    // 蒙版的范围包住整个圆
    const region = masks[0]!;
    expect(Number(region.x)).toBeLessThanOrEqual(160);
    expect(Number(region.x) + Number(region.width)).toBeGreaterThanOrEqual(220);
    const groups = elements(svg, 'g').map((g) => g['clip-path'] ?? g.mask);
    expect(groups).toEqual([`url(#${clip!.id})`, `url(#${masks[0]!.id})`, `url(#${masks[1]!.id})`]);
  });

  it('图片放在 defs 里，用 use 摆进形状，按形状裁剪；同一张图只放一份，调过色的另放一份', async () => {
    const env = setup();
    const meta = await env.assets.add(checkerPng(), { mime: 'image/png', width: 2, height: 2 });
    const fill = (adjust?: ImageFill['adjust']): ImageFill => ({
      type: 'image',
      assetId: meta.id,
      fit: 'cover',
      adjust,
    });
    for (const [x, adjust] of [
      [20, undefined],
      [140, undefined],
      [260, { brightness: 0, contrast: 0, saturation: -100, temperature: 0, tint: 0, hue: 0, blur: 0 }],
    ] as const) {
      env.add(
        createNode('ellipse', {
          ...env.on(),
          transform: [1, 0, 0, 1, x, 20],
          size: [100, 50],
          fill: fill(adjust),
          stroke: { color: rgba(0, 0, 0), width: 2 },
        }),
      );
    }
    const svg = await exportBoard(env);
    const images = elements(svg, 'image');
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ width: '2', height: '2', preserveAspectRatio: 'none' });
    expect(images[0]!['xlink:href']!.startsWith('data:image/png;base64,')).toBe(true);
    expect(images[0]!['xlink:href']).not.toBe(images[1]!['xlink:href']);
    const uses = elements(svg, 'use');
    expect(uses.map((u) => u['xlink:href'])).toEqual([`#${images[0]!.id}`, `#${images[0]!.id}`, `#${images[1]!.id}`]);
    // 铺满：2 像素的图放大 50 倍盖住 100 × 50 的外框，上下各裁掉 25
    expect(uses[0]!.transform).toBe('matrix(50 0 0 50 0 -25)');
    // 描边另画一次，没有填充
    expect(elements(svg, 'ellipse').filter((e) => e.stroke === '#000000' && e.fill === 'none')).toHaveLength(3);
  });

  it('文字写成真正的文字：每个字按排版的位置摆，字体子集内嵌成 WOFF，unicode-range 只含用到的字', async () => {
    const env = setup();
    const node = text(env, 'Hello 世界 & <b>');
    const styled = setCharacterStyle(node, 0, 5, { fontWeight: 700, color: rgba(1, 0, 0) });
    env.store.transact('style', (tx) => tx.update(node.id, { spans: styled.spans }));
    const svg = await exportBoard(env);
    // 一个文本节点是一个 <text>，选中、复制时是连着的一整段；每段字是一个 <tspan>
    expect(texts(svg)).toEqual(['Hello 世界 & <b>']);
    expect(elements(svg, 'text')[0]).toEqual({
      'xml:space': 'preserve',
      style: 'white-space:pre',
      transform: 'translate(20 120)',
    });
    const runs = elements(svg, 'tspan');
    expect(runs[0]).toMatchObject({ 'font-family': "'Inter'", 'font-weight': '700', fill: '#ff0000' });
    expect(runs.some((r) => r['font-family'] === "'Noto Sans SC'")).toBe(true);
    // 每个字一个位置
    expect(runs[0]!.x!.split(' ')).toHaveLength(5);

    const faces = [...svg.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(faces.length).toBeGreaterThanOrEqual(3);
    const cjk = faces.find((f) => f.includes('Noto Sans SC'))!;
    expect(cjk).toContain('unicode-range:U+4E16,U+754C');
    // 内嵌的字体能读回来，而且只留下了用到的字形
    const base64 = /base64,([^)]*)\)/.exec(cjk)![1]!;
    const woff = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const font = parseSfnt(woff);
    expect(font.numGlyphs).toBeGreaterThan(2);
    const outlines = new GlyphOutlines(font);
    let nonEmpty = 0;
    for (let g = 1; g < font.numGlyphs; g++) if (outlines.get(g).length > 0) nonEmpty++;
    expect(nonEmpty).toBe(2);
  });

  it('自动折行的段落：折行处没画出来的空格也写进去，复制出来词不会粘在一起；模拟的斜体写成 font-style', async () => {
    const env = setup();
    const style = { ...text(setup(), '').style, italic: true };
    text(env, 'Hello wonderful world 中文斜体', { sizing: 'fixed', size: [90, 0], style });
    const svg = await exportBoard(env);
    expect(texts(svg)).toEqual(['Hello wonderful world 中文斜体']);
    const spans = elements(svg, 'tspan');
    // 西文用真正的斜体文件，中文字体没有斜体文件，由浏览器斜切（和排版引擎一样斜切四分之一）
    expect(spans.every((span) => span['font-style'] === 'italic')).toBe(true);
    expect(svg).toMatch(/font-family:"Inter";[^}]*font-style:italic/);
    expect(svg).toMatch(/font-family:"Noto Sans SC";[^}]*font-style:normal/);
    expect(elements(svg, 'text')).toHaveLength(1);
  });

  it('段落样式：列表的符号和编号写成文字放在缩进里，每段按自己的对齐和缩进摆', async () => {
    const env = setup();
    text(env, '第一项\n第二项\n居中', {
      sizing: 'fixed',
      size: [300, 0],
      paragraphs: [{ list: 'number' }, { list: 'number', spaceBefore: 10 }, { align: 'center' }],
    });
    const svg = await exportBoard(env);
    expect(texts(svg)).toEqual(['1.第一项2.第二项居中']);
    const spans = elements(svg, 'tspan');
    /** 某个字的横坐标：找到它所在的 <tspan>，取 x 列表里对应的那一个 */
    const xOf = (char: string): number => {
      const index = spans.findIndex((_, i) => svgSpanText(svg, i).includes(char));
      return Number(spans[index]!.x!.split(' ')[[...svgSpanText(svg, index)].indexOf(char)]);
    };
    // 字号 20：编号右边缘在 26，文字从 36 开始
    expect(xOf('第')).toBeCloseTo(36, 0);
    expect(xOf('1')).toBeLessThan(26);
    // 居中的那一段在 300 宽的框里居中
    expect(xOf('居')).toBeCloseTo(150 - 20, 0);
  });

  it('文字转轮廓：没有 <text>，每段字是一条路径，形状和字体里的字形一致', async () => {
    const env = setup();
    text(env, 'Io 中', { style: { ...text(setup(), '').style, italic: true } });
    const svg = await exportBoard(env, 'outline');
    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('@font-face');
    const paths = elements(svg, 'path');
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const p of paths) expect(p.d!.length).toBeGreaterThan(50);
  });

  it('排版用的 WOFF2 和嵌入用的 WOFF 字形编号不一致时，按字符换成嵌入文件里的字形（全角冒号）', async () => {
    const env = setup();
    text(env, '：', { style: { ...text(setup(), '').style, fontSize: 100 } });
    // 转轮廓：画出来是上下两个点，不是别的字
    const outline = await exportBoard(env, 'outline');
    const [path] = elements(outline, 'path');
    expect(path!.d!.match(/M/g)).toHaveLength(2);
    // 两个点都很窄（换错的那个字形是数字 4，宽得多）
    const numbers = path!.d!.match(/-?[\d.]+/g)!.map(Number);
    const xs = numbers.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(25);
    // 真正的文字：内嵌的子集里，浏览器按字符映射表找到的那个字形是有轮廓的
    const svg = await exportBoard(env);
    const face = [...svg.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]!).find((f) => f.includes('U+FF1A'))!;
    const sfnt = toSfnt(Uint8Array.from(atob(/base64,([^)]*)\)/.exec(face)![1]!), (c) => c.charCodeAt(0)));
    const typeface = ck.Typeface.MakeTypefaceFromData(sfnt.slice().buffer)!;
    const [glyph] = typeface.getGlyphIDs('：');
    typeface.delete();
    expect(glyph).toBeGreaterThan(0);
    expect(new GlyphOutlines(parseSfnt(sfnt)).get(glyph!).length).toBeGreaterThan(0);
  });

  it('从 PDF 导入、没改过的文字按原字形画成路径，上面叠一层看不见、可以搜索的文字', async () => {
    const env = setup();
    const square = [0, 0, 0, 1, 0.7, 0, 1, 0.7, 0.7, 1, 0, 0.7, 4];
    const meta = await env.assets.add(encodeGlyphLibrary([square], { text: ['口'], advances: [0.8] }), {
      mime: GLYPH_LIBRARY_MIME,
      width: 0,
      height: 0,
    });
    const node = text(env, '口 口 口', { size: [40, 28] });
    const appearance = {
      runs: [
        { library: meta.id, matrix: [20, 0, 0, -20] as const, glyphs: [0, 0, 20, 0, 24, 20] },
        // 第二段字（比如换了颜色）和前一段之间的空格也要找回来
        { library: meta.id, matrix: [20, 0, 0, -20] as const, glyphs: [0, 48, 20], color: rgba(1, 0, 0) },
      ],
      basis: textAppearanceBasis(node),
      baseline: 20,
    };
    env.store.transact('freeze', (tx) => tx.update(node.id, { appearance }));
    const svg = await exportBoard(env);
    expect(elements(svg, 'path')[0]!.d).toBe('M0 20L14 20L14 6L0 6ZM24 20L38 20L38 6L24 6Z');
    expect(elements(svg, 'path')[1]).toMatchObject({ fill: '#ff0000' });
    // 空格是 PDF 里没画出来的字，从节点的文字里找回来，放在前一个字的末尾；方向相同的几段字是同一个 <text>
    expect(texts(svg)).toEqual(['口 口 口']);
    expect(elements(svg, 'text')[0]).toMatchObject({ 'fill-opacity': '0' });
    expect(elements(svg, 'tspan')[0]).toMatchObject({ x: '0 16 24', y: '20', 'font-size': '20' });
    expect(elements(svg, 'tspan')[1]).toMatchObject({ x: '40 48' });

    const outlines = await exportBoard(env, 'outline');
    expect(outlines).not.toContain('<text');
  });

  it('网页播放器的图层：同样的内容得到一模一样的 SVG，id 留着前缀占位符给播放器换', async () => {
    const env = setup();
    const shape = (x: number, color = rgba(1, 0, 0)) =>
      env.add(
        createNode('ellipse', {
          ...env.on(),
          transform: [1, 0, 0, 1, x, 20],
          size: [50, 50],
          fill: {
            type: 'gradient',
            kind: 'linear',
            start: { x: 0, y: 0 },
            end: { x: 1, y: 1 },
            stops: [
              { offset: 0, color },
              { offset: 1, color: rgba(0, 0, 0) },
            ],
          },
          stroke: null,
          blendMode: 'screen',
          opacity: 0.8,
        }),
      );
    const a = shape(20);
    const b = shape(100);
    const c = shape(180, rgba(0, 1, 0));
    const label = text(env, '图层');
    await ensureTextFonts(env.fonts, label);
    const layers = await SvgLayers.create(env.context, [a.id, b.id, c.id, label.id]);
    const layer = (n: SceneNode) => layers.layer(n.id)!;
    const [la, lb, lc, lt] = [layer(a), layer(b), layer(c), layer(label)];
    expect(la.svg).toBe(lb.svg);
    expect(lc.svg).not.toBe(la.svg);
    const id = /id="([^"]+)"/.exec(la.svg)![1]!;
    expect(id.startsWith(SVG_ID_PLACEHOLDER)).toBe(true);
    expect(la.svg).toContain(`url(#${id})`);
    // 自己的变换和混合模式由播放器负责，不透明度写在里面
    expect(la.svg).not.toContain('mix-blend-mode');
    expect(la.svg).not.toContain('translate');
    expect(la.svg).toContain('opacity="0.8"');
    expect(la.box).toEqual({ x: -1, y: -1, w: 52, h: 52 });
    // 两个字在中文字体的不同分片里，是两段字
    expect(texts(lt.svg).join('')).toBe('图层');
    expect(lt.svg).not.toContain('@font-face');
    const css = layers.fontCss();
    expect(css).toContain('unicode-range:U+56FE}');
    expect(css).toContain('unicode-range:U+5C42}');
    layers.dispose();
  });

  it('导出选中的对象：画面正好框住它们（描边留出余量），各自按在画布上的位置摆；父节点的不透明度不算', async () => {
    const env = setup();
    env.store.transact('move board', (tx) => tx.update(env.board.id, { transform: [1, 0, 0, 1, 500, 300] }));
    const group = env.add(createNode('group', { ...env.on(), opacity: 0.5, transform: [1, 0, 0, 1, 10, 10] }));
    const rect = env.add(
      createNode('rect', {
        ...env.on(group.id),
        transform: [1, 0, 0, 1, 20, 20],
        size: [80, 40],
        cornerRadius: 0,
        fill: solid(rgba(0, 0, 1)),
        stroke: { color: rgba(0, 0, 0), width: 4 },
      }),
    );
    const ellipse = env.add(
      createNode('ellipse', {
        ...env.on(),
        transform: [1, 0, 0, 1, 150, 100],
        size: [40, 40],
        fill: solid(rgba(1, 0, 0)),
        stroke: null,
      }),
    );
    const svg = await exportSvgNodes(env.context, [rect.id, ellipse.id], { text: 'text', title: '选中' });
    // 矩形的世界坐标是 (530, 330)，描边宽 4，四周留 3；椭圆在 (650, 400)，没有描边，四周留 1
    expect(elements(svg, 'svg')[0]).toMatchObject({ width: '164', height: '114', viewBox: '0 0 164 114' });
    expect(elements(svg, 'rect')).toEqual([
      expect.objectContaining({ width: '80', height: '40', transform: 'translate(3 3)' }),
    ]);
    expect(elements(svg, 'ellipse')[0]).toMatchObject({ transform: 'translate(123 73)' });
    expect(svg).not.toContain('opacity');
    expect(svg).toContain('<title>选中</title>');
    await expect(exportSvgNodes(env.context, [], { text: 'text' })).rejects.toThrow();
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
    env.context.rasterize = () => ({ png: checkerPng(), box: { x: 10, y: 10, w: 40, h: 40 } });
    const svg = await exportBoard(env);
    expect(elements(svg, 'image')[0]).toMatchObject({ x: '10', y: '10', width: '40', height: '40' });
  });
});

describe('字体工具', () => {
  const inter = (): Uint8Array => new Uint8Array(file('@fontsource/inter/files/inter-latin-400-normal.woff'));

  it('WOFF 封装：解开以后每张表和原来一模一样', () => {
    const sfnt = toSfnt(inter());
    const back = toSfnt(toWoff(sfnt));
    const a = parseSfnt(sfnt);
    const b = parseSfnt(back);
    expect([...b.tables.keys()].sort()).toEqual([...a.tables.keys()].sort());
    for (const [tag, table] of a.tables) {
      const other = b.tables.get(tag)!;
      expect(back.subarray(other.offset, other.offset + other.length)).toEqual(
        sfnt.subarray(table.offset, table.offset + table.length),
      );
    }
    expect(toWoff(sfnt).length).toBeLessThan(sfnt.length * 0.8);
  });

  it('读字形轮廓：字母 o 是两圈，外框和字体里记的一致', () => {
    const font = parseSfnt(inter());
    const typeface = ck.Typeface.MakeTypefaceFromData(toSfnt(inter()).slice().buffer)!;
    const [glyph] = typeface.getGlyphIDs('o');
    typeface.delete();
    const outline = new GlyphOutlines(font).get(glyph!);
    expect(outline.filter((v, i, all) => v === 0 && (i === 0 || all[i - 1] !== undefined)).length).toBeGreaterThan(0);
    const moves = countVerbs(outline, 0);
    expect(moves).toBe(2);
    const ys = points(outline).map((p) => p[1]);
    // 小写字母的高度大约是字号的一半，基线附近有一点下探
    expect(Math.max(...ys)).toBeGreaterThan(0.45);
    expect(Math.max(...ys)).toBeLessThan(0.6);
    expect(Math.min(...ys)).toBeLessThan(0.01);
  });
});

/** 路径数据里某种指令有几个 */
function countVerbs(data: number[], verb: number): number {
  const ARITY = [2, 2, 6, 4, 0];
  let count = 0;
  for (let i = 0; i < data.length;) {
    const v = data[i++]!;
    if (v === verb) count++;
    i += ARITY[v]!;
  }
  return count;
}

function points(data: number[]): [number, number][] {
  const ARITY = [2, 2, 6, 4, 0];
  const out: [number, number][] = [];
  for (let i = 0; i < data.length;) {
    const v = data[i++]!;
    for (let k = 0; k < ARITY[v]!; k += 2) out.push([data[i + k]!, data[i + k + 1]!]);
    i += ARITY[v]!;
  }
  return out;
}

describe('导出 SVG：箭头和多边形', () => {
  const corner = (x: number, y: number) => ({ x, y, inX: x, inY: y, outX: x, outY: y });

  it('箭头是一条描边的线加一个填充的箭头路径，颜色和描边一样；多边形写成路径', async () => {
    const env = setup();
    env.add(
      createNode('path', {
        ...env.on(),
        transform: [1, 0, 0, 1, 40, 60],
        size: [200, 0],
        subpaths: [{ closed: false, anchors: [corner(0, 0), corner(200, 0)] }],
        fillRule: 'nonzero',
        fill: null,
        stroke: { color: rgba(0, 0, 1), width: 4, arrowStart: 'circle', arrowEnd: 'arrow' },
      }),
    );
    env.add(
      createNode('polygon', {
        ...env.on(),
        transform: [1, 0, 0, 1, 40, 120],
        size: [100, 100],
        sides: 6,
        cornerRadius: 8,
        fill: solid(rgba(1, 0.5, 0)),
        stroke: null,
      }),
    );
    const svg = await exportBoard(env);
    const paths = elements(svg, 'path');
    const line = paths.find((p) => p['stroke'] === '#0000ff')!;
    expect(line['stroke-width']).toBe('4');
    expect(line['fill']).toBe('none');
    const heads = paths.filter((p) => p['fill'] === '#0000ff' && !p['stroke']);
    expect(heads).toHaveLength(1);
    // 起点的圆和终点的箭头在同一条路径里：至少两段子路径
    expect(heads[0]!['d']!.match(/M/g)!.length).toBeGreaterThanOrEqual(2);
    const hexagon = paths.find((p) => p['fill'] === '#ff8000')!;
    expect(hexagon['d']).toMatch(/Z/);
  });
});
