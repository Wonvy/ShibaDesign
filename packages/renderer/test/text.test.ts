import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  type TextNode,
} from '@shiba/core';
import {
  FontManager,
  GeometryCache,
  NodeTypeRegistry,
  TextLayouts,
  createTextNodeType,
  TextAppearances,
  ensureTextFonts,
  loadCanvasKit,
  parseUnicodeRange,
  registerBuiltinNodeTypes,
  type CanvasKit,
  type FontFaceSource,
} from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

function file(specifier: string): ArrayBuffer {
  const buffer = readFileSync(require.resolve(specifier));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** 把 fontsource 的一个字体包登记成按分片加载的家族，并记录实际加载了哪些文件 */
function fontsourceFaces(pkg: string, prefix: string, loaded: string[]): FontFaceSource[] {
  const unicode = require(`${pkg}/unicode.json`) as Record<string, string>;
  const faces: FontFaceSource[] = [];
  for (const [key, range] of Object.entries(unicode)) {
    const chunk = key.replace(/[[\]]/g, '');
    for (const weight of [400, 700]) {
      for (const italic of [false, true]) {
        const name = `${prefix}-${chunk}-${weight}-${italic ? 'italic' : 'normal'}.woff2`;
        if (!existsSync(require.resolve(`${pkg}/package.json`).replace('package.json', `files/${name}`))) continue;
        faces.push({
          chunk,
          weight,
          italic,
          ranges: parseUnicodeRange(range),
          load: async () => {
            loaded.push(name);
            return file(`${pkg}/files/${name}`);
          },
        });
      }
    }
  }
  return faces;
}

function setup() {
  const loaded: string[] = [];
  const store = DocStore.create();
  const assets = new AssetStore();
  const fonts = new FontManager(ck);
  fonts.addFamily({ name: 'Inter', faces: fontsourceFaces('@fontsource/inter', 'inter', loaded) });
  fonts.addFamily({
    name: 'Noto Sans SC',
    faces: fontsourceFaces('@fontsource/noto-sans-sc', 'noto-sans-sc', loaded),
  });
  const layouts = new TextLayouts(ck, store, fonts);
  const appearances = new TextAppearances(ck, store, assets);
  const registry = registerBuiltinNodeTypes(new NodeTypeRegistry()).register(createTextNodeType(layouts, appearances));
  const geometry = new GeometryCache(ck, store, registry);
  fonts.onChange(() => {
    layouts.clear();
    geometry.invalidate((n) => n.type === 'text');
  });
  return { store, assets, fonts, layouts, appearances, geometry, loaded };
}

const FAMILIES = ['Inter', 'Noto Sans SC'];

function addText(store: DocStore, text: string, patch: Partial<TextNode> = {}): TextNode {
  return store.transact('text', (tx) =>
    tx.create(
      createNode('text', {
        parent: store.root.id,
        index: store.indexOnTop(store.root.id),
        seq: 1,
        text,
        style: {
          fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
          fontSize: 40,
          fontWeight: 400,
          lineHeight: 1.4,
          letterSpacing: 0,
        },
        align: 'left',
        sizing: 'auto',
        fill: solid(rgba(0, 0, 0)),
        ...patch,
      }),
    ),
  );
}

describe('parseUnicodeRange', () => {
  it('解析单个码点和区间', () => {
    expect(parseUnicodeRange('U+0000-00FF,U+0131, u+4e00')).toEqual([
      [0x0000, 0x00ff],
      [0x0131, 0x0131],
      [0x4e00, 0x4e00],
    ]);
  });
});

describe('FontManager', () => {
  it('只加载文字用到的分片', async () => {
    const { fonts, loaded } = setup();
    await fonts.ensure(FAMILIES, 'Hello', 400);
    expect(loaded).toEqual(['inter-latin-400-normal.woff2']);

    await fonts.ensure(FAMILIES, 'Hello 你好', 400);
    expect(loaded.filter((f) => f.startsWith('inter'))).toHaveLength(1);
    const noto = loaded.filter((f) => f.startsWith('noto'));
    expect(noto.length).toBeGreaterThanOrEqual(1);
    expect(noto.length).toBeLessThanOrEqual(2);
    // 西文字符由排在前面的 Inter 负责，不应该再去加载思源黑体的拉丁分片
    expect(noto).not.toContain('noto-sans-sc-latin-400-normal.woff2');
  });

  it('同一个文件不会重复加载，粗体按字重单独加载', async () => {
    const { fonts, loaded } = setup();
    await fonts.ensure(FAMILIES, 'abc', 400);
    await fonts.ensure(FAMILIES, 'cba', 400);
    expect(loaded).toEqual(['inter-latin-400-normal.woff2']);
    await fonts.ensure(FAMILIES, 'abc', 700);
    expect(loaded).toEqual(['inter-latin-400-normal.woff2', 'inter-latin-700-normal.woff2']);
  });

  it('加载完成后通知并递增 epoch', async () => {
    const { fonts } = setup();
    let notified = 0;
    fonts.onChange(() => notified++);
    const before = fonts.epoch;
    const first = fonts.resolve(FAMILIES, '字', 400);
    expect(first.pending).toBe(true);
    await fonts.ensure(FAMILIES, '字', 400);
    await Promise.resolve();
    expect(fonts.epoch).toBeGreaterThan(before);
    expect(notified).toBeGreaterThan(0);
    expect(fonts.resolve(FAMILIES, '字', 400).pending).toBe(false);
  });
});

describe('TextLayouts', () => {
  const TEXT = 'Hi 你好，世界';

  it('中英文混排都能找到字形', async () => {
    const { store, fonts, layouts } = setup();
    const node = addText(store, TEXT);
    await fonts.ensure(FAMILIES, TEXT, 400);
    const layout = layouts.get(node);
    expect(layout.pending).toBe(false);
    expect(layout.blocks[0]!.paragraph.unresolvedCodepoints()).toEqual([]);
    expect(layout.lines).toHaveLength(1);
    expect(layout.height).toBeCloseTo(56, 0);
    expect(layout.width).toBeGreaterThan(200);
  });

  it('字体没加载完时先出结果，加载完后自动得到新的排版', async () => {
    const { store, fonts, layouts, geometry } = setup();
    const node = addText(store, '你好世界');
    const before = geometry.localBounds(node).w;
    expect(layouts.get(node).pending).toBe(true);
    await fonts.ensure(FAMILIES, '你好世界', 400);
    await Promise.resolve();
    expect(layouts.get(node).pending).toBe(false);
    const after = geometry.localBounds(node).w;
    // 四个 40 像素的汉字大约 160 宽；加载前没有字形，宽度不可能是这个数
    expect(after).toBeGreaterThan(150);
    expect(after).not.toBe(before);
  });

  it('光标位置随字符递增，且与点击位置互逆', async () => {
    const { store, fonts, layouts } = setup();
    const node = addText(store, TEXT);
    await fonts.ensure(FAMILIES, TEXT, 400);
    const xs = Array.from({ length: TEXT.length + 1 }, (_, i) => layouts.caretRect(node, i).x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    expect(xs[0]).toBe(0);

    // 点在某个字符中间偏左，应该得到它前面的位置；偏右得到它后面的位置
    const i = TEXT.indexOf('世');
    const left = xs[i]!;
    const right = xs[i + 1]!;
    expect(layouts.offsetAt(node, left + (right - left) * 0.25, 20)).toBe(i);
    expect(layouts.offsetAt(node, left + (right - left) * 0.75, 20)).toBe(i + 1);
    expect(layouts.offsetAt(node, 99999, 20)).toBe(TEXT.length);
    expect(layouts.offsetAt(node, -50, 20)).toBe(0);
  });

  it('汉字是等宽的：每个字的选区矩形宽度等于字号', async () => {
    const { store, fonts, layouts } = setup();
    const node = addText(store, '你好世界');
    await fonts.ensure(FAMILIES, '你好世界', 400);
    for (let i = 0; i < 4; i++) {
      const [rect] = layouts.selectionRects(node, i, i + 1);
      expect(rect!.w).toBeCloseTo(40, 0);
    }
    expect(layouts.selectionRects(node, 2, 2)).toEqual([]);
  });

  it('换行符产生新行；空行和末尾空行上也有光标位置', async () => {
    const { store, fonts, layouts } = setup();
    const text = '第一行\n\n第三行\n';
    const node = addText(store, text);
    await fonts.ensure(FAMILIES, text, 400);
    const layout = layouts.get(node);
    expect(layout.lines).toHaveLength(4);
    const ys = [0, 4, 5, text.length].map((offset) => layouts.caretRect(node, offset).y);
    expect(ys[0]).toBeCloseTo(0, 0);
    expect(ys[1]).toBeCloseTo(56, 0);
    expect(ys[2]).toBeCloseTo(112, 0);
    expect(ys[3]).toBeCloseTo(168, 0);
    expect(layouts.caretRect(node, 4).x).toBe(0);
  });

  it('空文本也有一行的高度和一个光标位置', async () => {
    const { store, fonts, layouts } = setup();
    const node = addText(store, '');
    await fonts.ensure(FAMILIES, '', 400);
    const caret = layouts.caretRect(node, 0);
    expect(caret.h).toBeCloseTo(56, 0);
    expect(layouts.offsetAt(node, 10, 10)).toBe(0);
  });

  it('固定宽度时自动折行，上下移动光标保持横坐标', async () => {
    const { store, fonts, layouts } = setup();
    const text = '春眠不觉晓处处闻啼鸟夜来风雨声花落知多少';
    const node = addText(store, text, { sizing: 'fixed', size: [205, 0] });
    await fonts.ensure(FAMILIES, text, 400);
    const layout = layouts.get(node);
    expect(layout.width).toBe(205);
    expect(layout.lines).toHaveLength(4);
    expect(layout.lines.map((l) => l.startIndex)).toEqual([0, 5, 10, 15]);

    // 从第一行第 2 个字后面往下移，应该落到第二行第 2 个字后面
    const x = layouts.caretRect(node, 2).x;
    expect(layouts.verticalMove(node, 2, 1, x)).toBe(7);
    expect(layouts.verticalMove(node, 7, -1, x)).toBe(2);
    // 第一行再往上到开头，最后一行再往下到结尾
    expect(layouts.verticalMove(node, 2, -1, x)).toBe(0);
    expect(layouts.verticalMove(node, 17, 1, x)).toBe(text.length);
  });

  it('只是移动节点不会重新排版', async () => {
    const { store, fonts, layouts } = setup();
    const node = addText(store, 'abc');
    await fonts.ensure(FAMILIES, 'abc', 400);
    const first = layouts.get(node);
    const moved = store.transact('move', (tx) => tx.update(node.id, { transform: [1, 0, 0, 1, 50, 60] })) as TextNode;
    expect(layouts.get(moved)).toBe(first);
    const edited = store.transact('edit', (tx) => tx.update(node.id, { text: 'abcd' })) as TextNode;
    expect(layouts.get(edited)).not.toBe(first);
  });

  it('粗体比常规体宽', async () => {
    const { store, fonts, layouts } = setup();
    const text = 'Wide words';
    const regular = addText(store, text);
    const bold = addText(store, text, { style: { ...regular.style, fontWeight: 700 } });
    await fonts.ensure(FAMILIES, text, 400);
    await fonts.ensure(FAMILIES, text, 700);
    expect(layouts.get(bold).width).toBeGreaterThan(layouts.get(regular).width);
  });

  it('表情符号这类代理对不会把光标卡在半个字符上', async () => {
    const { store, fonts, layouts } = setup();
    const text = 'a😀b';
    const node = addText(store, text);
    await fonts.ensure(FAMILIES, text, 400);
    const afterA = layouts.caretRect(node, 1).x;
    const afterB = layouts.caretRect(node, text.length).x;
    expect(Number.isFinite(layouts.caretRect(node, 3).x)).toBe(true);
    expect(afterB).toBeGreaterThan(afterA);
  });
});

describe('字符级样式', () => {
  it('字号都一样时每行一样高；有更大的字时那一行跟着长高，光标的高度按各自的行算', async () => {
    const { store, fonts, layouts } = setup();
    const node = addText(store, '中文 English\nbig line\nlast', {
      style: { ...addText(store, '').style, fontSize: 20 },
    });
    await fonts.ensure(FAMILIES, node.text, 400);
    await Promise.resolve();
    const even = layouts.get(store.require(node.id) as TextNode);
    expect(even.lineHeights.map((h) => Math.round(h))).toEqual([28, 28, 28]);

    store.transact('big', (tx) => tx.update(node.id, setCharacterStyle(node, 11, 14, { fontSize: 40 })));
    const grown = store.require(node.id) as TextNode;
    await ensureTextFonts(fonts, grown);
    await Promise.resolve();
    const layout = layouts.get(grown);
    expect(layout.lineHeights[1]!).toBeCloseTo(56, 0);
    expect(layout.lineTops[2]!).toBeCloseTo(layout.lineTops[1]! + layout.lineHeights[1]!, 5);
    expect(layout.height).toBeCloseTo(
      layout.lineHeights.reduce((a, b) => a + b, 0),
      5,
    );
    const caret = layouts.caretRect(grown, 20);
    expect(caret.y).toBeCloseTo(layout.lineTops[2]!, 5);
    expect(caret.h).toBeCloseTo(layout.lineHeights[2]!, 5);
  });

  it('斜体加载斜体文件；中文字体没有斜体就用正体', async () => {
    const { store, fonts, loaded } = setup();
    const node = addText(store, 'Hi 你');
    const italic = { ...node, ...setCharacterStyle(node, 0, 4, { italic: true }) } as TextNode;
    await ensureTextFonts(fonts, italic);
    expect(loaded.some((name) => name.startsWith('inter-latin-400-italic'))).toBe(true);
    expect(loaded.some((name) => name.includes('italic') && name.startsWith('noto'))).toBe(false);
    expect(fonts.hasItalic('Inter')).toBe(true);
    expect(fonts.hasItalic('Noto Sans SC')).toBe(false);
  });

  it('粗细、颜色、下划线不同的字排在同一段里，宽度跟着变', async () => {
    const { store, fonts, layouts } = setup();
    const node = addText(store, 'Hello world');
    await fonts.ensure(FAMILIES, node.text, 400);
    await Promise.resolve();
    const plain = layouts.get(store.require(node.id) as TextNode).width;
    store.transact('bold', (tx) =>
      tx.update(node.id, setCharacterStyle(node, 6, 11, { fontWeight: 700, underline: true, color: rgba(1, 0, 0) })),
    );
    const styled = store.require(node.id) as TextNode;
    await ensureTextFonts(fonts, styled);
    await Promise.resolve();
    expect(layouts.get(styled).width).toBeGreaterThan(plain);
    expect(layouts.get(styled).pending).toBe(false);
  });
});

describe('文本节点的几何', () => {
  it('轮廓是整个文本框，点在字间空白处也能命中', async () => {
    const { store, fonts, geometry } = setup();
    const text = 'A B';
    const node = addText(store, text);
    await fonts.ensure(FAMILIES, text, 400);
    await Promise.resolve();
    const bounds = geometry.localBounds(store.require(node.id));
    expect(bounds.h).toBeCloseTo(56, 0);
    expect(geometry.hitTest(bounds.w / 2, 28, [store.root.id], 0)?.id).toBe(node.id);
    expect(geometry.hitTest(bounds.w + 20, 28, [store.root.id], 0)).toBeNull();
  });
});

describe('保真外观', () => {
  /** 把一个 1 × 1 的方块字形放进资源库，返回带保真外观的文本 */
  async function frozen(env: ReturnType<typeof setup>): Promise<TextNode> {
    const square = [0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 4];
    const meta = await env.assets.add(encodeGlyphLibrary([square]), { mime: GLYPH_LIBRARY_MIME, width: 0, height: 0 });
    const node = addText(env.store, 'AB', { size: [100, 50] });
    // 字号 10 的两个方块，基线在 y = 30；字形 y 向上，所以纵向乘 -10
    const appearance = {
      runs: [{ library: meta.id, matrix: [10, 0, 0, -10] as const, glyphs: [0, 5, 30, 0, 20, 30] }],
      basis: textAppearanceBasis(node),
      baseline: 30,
    };
    env.store.transact('freeze', (tx) => tx.update(node.id, { appearance }));
    return env.store.require(node.id) as TextNode;
  }

  it('按字形库里的轮廓和记录的位置拼出路径', async () => {
    const env = setup();
    const node = await frozen(env);
    const [only, ...rest] = env.appearances.paths(node)!;
    expect(rest).toHaveLength(0);
    expect(only!.color).toBeNull();
    expect(Array.from(only!.path.computeTightBounds())).toEqual([5, 20, 30, 30]);
    // 文本框就是原文件里的范围，和我们的排版结果无关
    expect(env.geometry.localBounds(node)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  it('一行字中间换了颜色：按颜色分成几条路径', async () => {
    const env = setup();
    const node = await frozen(env);
    const [run] = node.appearance!.runs;
    const red = rgba(1, 0, 0);
    const runs = [
      { ...run!, glyphs: run!.glyphs.slice(0, 3) },
      { ...run!, glyphs: run!.glyphs.slice(3), color: red },
    ];
    env.store.transact('color', (tx) => tx.update(node.id, { appearance: { ...node.appearance!, runs } }));
    const paths = env.appearances.paths(env.store.require(node.id) as TextNode)!;
    expect(paths.map((p) => p.color)).toEqual([null, red]);
    expect(Array.from(paths[1]!.path.computeTightBounds())).toEqual([20, 20, 30, 30]);
  });

  it('文字改过之后改用正常排版', async () => {
    const env = setup();
    const node = await frozen(env);
    await env.fonts.ensure(FAMILIES, 'ABC', 400);
    env.store.transact('type', (tx) => tx.update(node.id, { text: 'ABC' }));
    const edited = env.store.require(node.id) as TextNode;
    expect(env.geometry.localBounds(edited).w).toBe(env.layouts.get(edited).width);
  });

  it('字形库缺失时也改用正常排版', async () => {
    const env = setup();
    const node = await frozen(env);
    env.assets.replaceAll([]);
    expect(env.appearances.paths(node)).toBeNull();
  });
});

describe('段落样式', () => {
  /** 一个三段的固定宽度文本 */
  async function three(paragraphs: TextNode['paragraphs'], text = 'alpha\nbeta\ngamma') {
    const env = setup();
    const node = addText(env.store, text, { sizing: 'fixed', size: [400, 0], paragraphs });
    await ensureTextFonts(env.fonts, node);
    await Promise.resolve();
    return { ...env, node: env.store.require(node.id) as TextNode };
  }

  it('每段单独对齐；段前段后距只加在段与段之间', async () => {
    const { layouts, node } = await three([null, { align: 'right', spaceBefore: 10, spaceAfter: 20 }]);
    const layout = layouts.get(node);
    const [a, b, c] = layout.blocks;
    expect(a!.y).toBe(0);
    expect(b!.y).toBeCloseTo(a!.height + 10, 5);
    expect(c!.y).toBeCloseTo(b!.y + b!.height + 20, 5);
    expect(layout.height).toBeCloseTo(c!.y + c!.height, 5);
    // 第二段右对齐：光标在段末时贴着右边
    expect(layouts.caretRect(node, 10).x).toBeCloseTo(400, 0);
    expect(layouts.caretRect(node, 0).x).toBe(0);
    // 光标的纵坐标跟着段落挪
    expect(layouts.caretRect(node, 11).y).toBeCloseTo(c!.y, 5);
    // 点在两段之间的空隙里，算离得近的那一段
    // （第二段右对齐，点在最左边就是这一段的开头）
    expect(layouts.offsetAt(node, 0, b!.y + b!.height + 2)).toBe(6);
    expect(layouts.offsetAt(node, 400, b!.y + b!.height + 2)).toBe(10);
    expect(layouts.offsetAt(node, 0, c!.y - 2)).toBe(11);
  });

  it('左缩进把整段往右挪，首行缩进只挪第一行', async () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj';
    const { layouts, node } = await three([{ indent: 30, firstLine: 50 }], text);
    const layout = layouts.get(node);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layouts.caretRect(node, 0).x).toBeCloseTo(80, 0);
    const second = layout.lines[1]!.startIndex;
    expect(layouts.caretRect(node, second).x).toBeCloseTo(30, 0);
    // 点在缩进出来的空白里，落到这一行的开头
    expect(layouts.offsetAt(node, 5, 10)).toBe(0);
    // 首行缩进不影响字符位置
    expect(layouts.selectionRects(node, 0, 4)[0]!.x).toBeCloseTo(80, 0);
  });

  it('列表：符号和编号排在缩进出来的那一档里，文字从下一档开始；编号按段数', async () => {
    const { layouts, node } = await three([{ list: 'number' }, { list: 'number' }, { list: 'bullet', level: 1 }]);
    const layout = layouts.get(node);
    const [a, b, c] = layout.blocks;
    expect(a!.marker!.text).toBe('1.');
    expect(b!.marker!.text).toBe('2.');
    expect(c!.marker!.text).toBe('◦');
    // 字号 40：第一级文字从 72 开始，符号右边缘在 52；第二级再多一档
    expect(layouts.caretRect(node, 0).x).toBeCloseTo(72, 0);
    expect(a!.marker!.x + a!.marker!.paragraph.getMaxIntrinsicWidth()).toBeCloseTo(52, 0);
    expect(layouts.caretRect(node, 11).x).toBeCloseTo(144, 0);
    // 符号的基线和第一行对齐
    const markerBaseline = a!.marker!.y + a!.marker!.paragraph.getLineMetrics()[0]!.baseline;
    expect(markerBaseline).toBeCloseTo(layout.lines[0]!.baseline, 3);
  });

  it('空的一段也有一行和光标位置；自动宽度按最宽的一段（连同缩进）算', async () => {
    const env = setup();
    const node = addText(env.store, 'ab\n\ncd', { paragraphs: [null, null, { indent: 100 }] });
    await ensureTextFonts(env.fonts, node);
    await Promise.resolve();
    const fresh = env.store.require(node.id) as TextNode;
    const layout = env.layouts.get(fresh);
    expect(layout.lines).toHaveLength(3);
    expect(env.layouts.caretRect(fresh, 3).y).toBeCloseTo(layout.lineTops[1]!, 5);
    expect(layout.width).toBeGreaterThan(100 + env.layouts.caretRect(fresh, 6).x - env.layouts.caretRect(fresh, 4).x);
  });

  it('列表符号的字体也会预先加载', async () => {
    const env = setup();
    const node = addText(env.store, '中文', { paragraphs: [{ list: 'bullet' }] });
    await ensureTextFonts(env.fonts, node);
    await Promise.resolve();
    const layout = env.layouts.get(env.store.require(node.id) as TextNode);
    expect(layout.pending).toBe(false);
    expect(layout.blocks[0]!.marker!.paragraph.unresolvedCodepoints()).toEqual([]);
  });
});
