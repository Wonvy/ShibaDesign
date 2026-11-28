import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DocStore,
  GLYPH_LIBRARY_MIME,
  createNode,
  encodeGlyphLibrary,
  rgba,
  setCharacterStyle,
  solid,
  textAppearanceBasis,
  translation,
  type ArtboardNode,
  type NodeId,
  type SceneNode,
  type Stroke,
  type TextNode,
} from '@shiba/core';
import { Renderer, loadCanvasKit, parseUnicodeRange, type CanvasKit, type FontFaceSource } from '@shiba/renderer';
import { createEditor, type Editor } from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

function file(specifier: string): ArrayBuffer {
  const buffer = readFileSync(require.resolve(specifier));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** fontsource 的字体包：排版用 woff2，读字形用同一个分片的 woff */
function fontsourceFaces(pkg: string, prefix: string, weights = [400, 700]): FontFaceSource[] {
  const unicode = require(`${pkg}/unicode.json`) as Record<string, string>;
  const root = path.dirname(require.resolve(`${pkg}/package.json`));
  const faces: FontFaceSource[] = [];
  for (const [key, range] of Object.entries(unicode)) {
    const chunk = key.replace(/[[\]]/g, '');
    for (const weight of weights) {
      const name = `${prefix}-${chunk}-${weight}-normal`;
      if (!existsSync(path.join(root, 'files', `${name}.woff2`))) continue;
      faces.push({
        chunk,
        weight,
        italic: false,
        ranges: parseUnicodeRange(range),
        load: async () => file(`${pkg}/files/${name}.woff2`),
        loadEmbeddable: async () => file(`${pkg}/files/${name}.woff`),
      });
    }
  }
  return faces;
}

const WIDTH = 320;
const HEIGHT = 200;

function setup(): { editor: Editor; store: DocStore; board: ArtboardNode; add: <T extends SceneNode>(node: T) => T } {
  const store = DocStore.create();
  const board = store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size: [WIDTH, HEIGHT],
        fill: solid(rgba(1, 1, 1)),
        deck: { order: 'a0', notes: '' },
      }),
    ),
  ) as ArtboardNode;
  const editor = createEditor({
    ck,
    store,
    theme: { background: rgba(0, 0, 0), accent: '#00f', label: '#888', handleFill: '#fff' },
    defaultFonts: { latin: 'Inter', cjk: 'Noto Sans SC' },
  });
  editor.fonts.addFamily({ name: 'Inter', faces: fontsourceFaces('@fontsource/inter', 'inter') });
  // 中文只装常规体，粗体由排版引擎描粗模拟，用来测转轮廓时的模拟粗体
  editor.fonts.addFamily({
    name: 'Noto Sans SC',
    faces: fontsourceFaces('@fontsource/noto-sans-sc', 'noto-sans-sc', [400]),
  });
  const add = <T extends SceneNode>(node: T): T => store.transact('add', (tx) => tx.create(node)) as T;
  return { editor, store, board, add };
}

const on = (store: DocStore, parent: NodeId) => ({ parent, index: store.indexOnTop(parent), seq: 1 });

/** 把画板按 scale 倍画出来 */
function render(editor: Editor, board: ArtboardNode, scale = 2): Uint8ClampedArray {
  const renderer = new Renderer(
    ck,
    {} as HTMLCanvasElement,
    editor.store,
    editor.nodeTypes,
    editor.geometry,
    editor.images,
  );
  const bitmap = renderer.renderToBitmap(board.id, WIDTH * scale, HEIGHT * scale)!;
  renderer.dispose();
  return bitmap.data;
}

/** 两张图有多少像素明显不同（任一通道差超过 threshold），占全部像素的比例 */
function difference(a: Uint8ClampedArray, b: Uint8ClampedArray, threshold = 64): { ratio: number; max: number } {
  let count = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[i + k]! - b[i + k]!));
    max = Math.max(max, d);
    if (d > threshold) count++;
  }
  return { ratio: count / (a.length / 4), max };
}

/** 一样东西有没有画出来：和空白画板比有多少像素不同 */
function inked(editor: Editor, board: ArtboardNode, pixels: Uint8ClampedArray): number {
  const hidden = editor.store.children(board.id).map((n) => n.id);
  editor.store.transact('hide', (tx) => hidden.forEach((id) => tx.update(id, { visible: false })));
  const blank = render(editor, board);
  editor.store.undo();
  return difference(blank, pixels).ratio;
}

describe('轮廓化描边', () => {
  const strokes: [string, Stroke][] = [
    ['实线、尖角', { color: rgba(0.1, 0.2, 0.8), width: 12 }],
    ['圆头圆角', { color: rgba(0.1, 0.2, 0.8), width: 12, cap: 'round', join: 'round' }],
    ['虚线', { color: rgba(0.8, 0.1, 0.1), width: 6, dash: [24, 10] }],
    ['多段虚线、负的起始偏移', { color: rgba(0.8, 0.1, 0.1), width: 5, dash: [30, 8, 4, 8], dashOffset: -13 }],
    ['点线', { color: rgba(0, 0.5, 0), width: 8, dash: [0, 16], cap: 'round' }],
  ];

  for (const [label, stroke] of strokes) {
    it(`${label}：转出来的路径和画布上画的描边逐像素一致`, () => {
      const { editor, store, board, add } = setup();
      const rect = add(
        createNode('rect', {
          ...on(store, board.id),
          transform: [0.94, 0.34, -0.34, 0.94, 60, 30],
          size: [150, 90],
          cornerRadius: 18,
          fill: null,
          stroke,
        }),
      );
      const ellipse = add(
        createNode('ellipse', {
          ...on(store, board.id),
          transform: translation(200, 60),
          size: [90, 110],
          fill: null,
          stroke,
        }),
      );
      const open = add(
        createNode('path', {
          ...on(store, board.id),
          transform: translation(30, 150),
          size: [260, 30],
          fillRule: 'nonzero',
          subpaths: [
            {
              closed: false,
              anchors: [
                { x: 0, y: 30, inX: 0, inY: 30, outX: 60, outY: -20 },
                { x: 130, y: 15, inX: 100, inY: 15, outX: 130, outY: 15 },
                { x: 260, y: 0, inX: 260, inY: 0, outX: 260, outY: 0 },
              ],
            },
          ],
          fill: null,
          stroke,
        }),
      );
      const before = render(editor, board);
      editor.select([rect.id, ellipse.id, open.id]);
      expect(editor.commands.run('path.outlineStroke')).toBe(true);

      // 没有填充的形状直接换成路径，id 不变，按描边颜色填充
      for (const id of [rect.id, ellipse.id, open.id]) {
        const node = store.get(id)!;
        expect(node.type).toBe('path');
        if (node.type !== 'path') continue;
        expect(node.stroke).toBeNull();
        expect(node.fill).toEqual(solid(stroke.color));
      }
      const after = render(editor, board);
      const diff = difference(before, after);
      // 只在边缘的抗锯齿上差一点。虚线在曲线上的位置要量弧长，画布按当前缩放倍数量（这里是 2 倍），
      // 转出来的按 4 倍的精度量，沿着圆角走一段以后会差零点几个像素
      expect(diff.ratio).toBeLessThan(0.002);
      expect(diff.max).toBeLessThan(224);
      expect(inked(editor, board, after)).toBeGreaterThan(0.02);

      // 一步撤销回到原来的形状
      editor.commands.run('edit.undo');
      expect(store.get(rect.id)?.type).toBe('rect');
      expect(difference(before, render(editor, board)).max).toBe(0);
    });
  }

  it('有填充的形状换成编组：下面是去掉描边的原形状，上面是描边转成的路径；动画还在', () => {
    const { editor, store, board, add } = setup();
    const rect = add(
      createNode('rect', {
        ...on(store, board.id),
        name: '卡片',
        transform: translation(40, 40),
        size: [160, 100],
        cornerRadius: 12,
        opacity: 0.8,
        fill: solid(rgba(1, 0.8, 0.2)),
        stroke: { color: rgba(0.2, 0.2, 0.2, 0.6), width: 10, dash: [20, 6] },
      }),
    );
    store.transact('animate', (tx) =>
      tx.update(board.id, {
        deck: {
          ...board.deck!,
          animations: [{ id: 'a1', target: rect.id, effect: 'fade', start: 'onClick', duration: 500, delay: 0 }],
        },
      }),
    );
    const before = render(editor, board);
    editor.select([rect.id]);
    editor.commands.run('path.outlineStroke');

    const group = store.get(rect.id)!;
    expect(group.type).toBe('group');
    expect(group.name).toBe('卡片');
    expect(group.opacity).toBe(0.8);
    const [fill, stroke] = store.children(rect.id);
    expect(fill?.type).toBe('rect');
    expect(fill && 'stroke' in fill ? fill.stroke : 'x').toBeNull();
    expect(stroke?.type).toBe('path');
    expect((store.get(board.id) as ArtboardNode).deck!.animations![0]!.target).toBe(rect.id);
    expect(editor.selection).toEqual([rect.id]);
    // 半透明的描边叠在填充上：组的不透明度是整体应用的，和原来一样
    expect(difference(before, render(editor, board)).ratio).toBeLessThan(0.001);
  });

  it('布尔组：运算对象跟着填充部分走', () => {
    const { editor, store, board, add } = setup();
    const a = add(
      createNode('rect', { ...on(store, board.id), size: [100, 100], cornerRadius: 0, fill: null, stroke: null }),
    );
    const b = add(
      createNode('ellipse', {
        ...on(store, board.id),
        transform: translation(50, 50),
        size: [100, 100],
        fill: null,
        stroke: null,
      }),
    );
    editor.select([a.id, b.id]);
    editor.commands.run('boolean.create', 'union');
    const booleanId = editor.selection[0]!;
    store.transact('style', (tx) =>
      tx.update(booleanId, { fill: solid(rgba(0.3, 0.6, 0.9)), stroke: { color: rgba(0, 0, 0), width: 6 } }),
    );
    const before = render(editor, board);
    editor.commands.run('path.outlineStroke');
    const [fill] = store.children(booleanId);
    expect(fill?.type).toBe('boolean');
    expect(store.children(fill!.id).map((n) => n.id)).toEqual([a.id, b.id]);
    expect(difference(before, render(editor, board)).ratio).toBeLessThan(0.001);
  });

  it('没有描边的形状不能用', () => {
    const { editor, store, board, add } = setup();
    const rect = add(
      createNode('rect', {
        ...on(store, board.id),
        size: [100, 100],
        cornerRadius: 0,
        fill: solid(rgba(1, 0, 0)),
        stroke: null,
      }),
    );
    editor.select([rect.id]);
    expect(editor.commands.canRun('path.outlineStroke')).toBe(false);
  });
});

describe('偏移路径', () => {
  function rectSetup() {
    const env = setup();
    const rect = env.add(
      createNode('rect', {
        ...on(env.store, env.board.id),
        transform: translation(100, 50),
        size: [100, 60],
        cornerRadius: 0,
        fill: solid(rgba(0.2, 0.4, 0.8)),
        stroke: { color: rgba(0, 0, 0), width: 2 },
      }),
    );
    env.editor.select([rect.id]);
    return { ...env, rect };
  }

  it('往外扩：新路径在原形状下面，尖角时还是矩形，每边多出偏移的距离', () => {
    const { editor, store, rect } = rectSetup();
    editor.commands.run('path.offset', { distance: 10, join: 'miter' });
    const [created] = editor.selection;
    const node = store.get(created!)!;
    expect(node.type).toBe('path');
    const bounds = editor.geometry.worldBounds(node);
    expect(bounds.x).toBeCloseTo(90, 3);
    expect(bounds.y).toBeCloseTo(40, 3);
    expect(bounds.w).toBeCloseTo(120, 3);
    expect(bounds.h).toBeCloseTo(80, 3);
    // 样式照搬，原形状还在，新路径在它下面
    expect(node.type === 'path' && node.fill).toEqual(solid(rgba(0.2, 0.4, 0.8)));
    expect(node.type === 'path' && node.stroke?.width).toBe(2);
    expect(store.get(rect.id)).toBe(rect);
    const order = store.children(rect.parent!).map((n) => n.id);
    expect(order.indexOf(created!)).toBe(order.indexOf(rect.id) - 1);
  });

  it('往里缩：在原形状上面，每边少偏移的距离；圆角外扩时四个角是圆的', () => {
    const { editor, store, rect } = rectSetup();
    editor.commands.run('path.offset', { distance: -10, join: 'miter' });
    const inner = store.get(editor.selection[0]!)!;
    const bounds = editor.geometry.worldBounds(inner);
    expect(bounds.w).toBeCloseTo(80, 3);
    expect(bounds.h).toBeCloseTo(40, 3);
    const order = store.children(rect.parent!).map((n) => n.id);
    expect(order.indexOf(inner.id)).toBe(order.indexOf(rect.id) + 1);

    editor.select([rect.id]);
    editor.commands.run('path.offset', { distance: 10, join: 'round' });
    const round = store.get(editor.selection[0]!)!;
    const outline = editor.geometry.outlineOf(round);
    const box = editor.geometry.localBounds(round);
    expect(box.w).toBeCloseTo(120, 1);
    // 角上离原来的角 10 的地方在里面，再往外一点就不在了
    const corner = 10 - 10 / Math.SQRT2;
    expect(outline.contains(corner + 0.5, corner + 0.5)).toBe(true);
    expect(outline.contains(corner - 1, corner - 1)).toBe(false);
  });

  it('缩没了的形状什么都不生成', () => {
    const { editor, store, rect } = rectSetup();
    const count = store.size;
    editor.commands.run('path.offset', { distance: -40, join: 'miter' });
    expect(store.size).toBe(count);
    expect(editor.selection).toEqual([rect.id]);
  });
});

describe('文字转轮廓', () => {
  function textNode(store: DocStore, board: ArtboardNode, patch: Partial<TextNode> = {}): TextNode {
    return createNode('text', {
      ...on(store, board.id),
      transform: [1, 0, 0, 1, 16, 30],
      text: 'Outline 文字转轮廓\nfine 第二行',
      style: {
        fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
        fontSize: 28,
        fontWeight: 400,
        lineHeight: 1.4,
        letterSpacing: 0,
      },
      align: 'left',
      sizing: 'auto',
      fill: solid(rgba(0.1, 0.1, 0.1)),
      ...patch,
    });
  }

  it('换成路径，样子和画布上排的字一致；id 和名字保留，一步撤销', async () => {
    const { editor, store, board, add } = setup();
    const text = add(textNode(store, board));
    await editor.fontsReady(board.id);
    const before = render(editor, board);
    editor.select([text.id]);

    const replaced = await editor.outlineText([text.id]);
    expect(replaced).toEqual([text.id]);
    const node = store.get(text.id)!;
    expect(node.type).toBe('path');
    expect(node.name).toBe('Outline 文字转轮廓');
    expect(editor.selection).toEqual([text.id]);
    const after = render(editor, board);
    const diff = difference(before, after);
    // 字形轮廓来自同一个字体，只在字的边缘有抗锯齿上的差别
    expect(diff.ratio).toBeLessThan(0.005);
    expect(diff.max).toBeLessThan(224);
    expect(inked(editor, board, after)).toBeGreaterThan(0.01);

    store.undo();
    expect(store.get(text.id)).toBe(text);
  });

  it('几种颜色、下划线、模拟粗体：每种颜色一条路径，放在编组里', async () => {
    const { editor, store, board, add } = setup();
    let text = textNode(store, board, { text: 'Red 红色 blue 蓝色\nUnder 下划线' });
    text = { ...text, ...setCharacterStyle(text, 0, 6, { color: rgba(0.9, 0.1, 0.1) }) } as TextNode;
    text = { ...text, ...setCharacterStyle(text, 7, 14, { color: rgba(0.1, 0.2, 0.9), fontWeight: 700 }) } as TextNode;
    text = { ...text, ...setCharacterStyle(text, 15, 24, { underline: true, strikethrough: true }) } as TextNode;
    add(text);
    await editor.fontsReady(board.id);
    const before = render(editor, board);

    await editor.outlineText([text.id]);
    const group = store.get(text.id)!;
    expect(group.type).toBe('group');
    const parts = store.children(text.id);
    expect(parts.map((p) => p.type)).toEqual(['path', 'path', 'path']);
    const afterPx = render(editor, board);
    // 模拟粗体、下划线、删除线都和画布上一致：差别只在边缘的抗锯齿上
    const diff = difference(before, afterPx);
    expect(diff.ratio).toBeLessThan(0.005);
    expect(diff.max).toBeLessThan(224);
  });

  it('从 PDF 导入、没改过的文字用原文件的字形转：每种颜色一条路径', async () => {
    const { editor, store, board, add } = setup();
    const square = [0, 0, 0, 1, 0.7, 0, 1, 0.7, 0.7, 1, 0, 0.7, 4];
    const meta = await editor.assets.add(encodeGlyphLibrary([square], { text: ['口'], advances: [0.8] }), {
      mime: GLYPH_LIBRARY_MIME,
      width: 0,
      height: 0,
    });
    const text = add(textNode(store, board, { text: '口口口', size: [80, 40] }));
    const appearance = {
      runs: [
        { library: meta.id, matrix: [40, 0, 0, -40] as const, glyphs: [0, 0, 40, 0, 40, 40] },
        { library: meta.id, matrix: [40, 0, 0, -40] as const, glyphs: [0, 80, 40], color: rgba(1, 0, 0) },
      ],
      basis: textAppearanceBasis(text),
      baseline: 40,
    };
    store.transact('freeze', (tx) => tx.update(text.id, { appearance }));
    const before = render(editor, board);

    await editor.outlineText([text.id]);
    const parts = store.children(text.id);
    expect(parts.map((p) => (p.type === 'path' ? p.fill : null))).toEqual([
      solid(rgba(0.1, 0.1, 0.1)),
      solid(rgba(1, 0, 0)),
    ]);
    // 两个黑色的方块在一条路径里：外框是 (16, 42) 起、宽 68、高 28
    expect(editor.geometry.worldBounds(parts[0]!)).toEqual({ x: 16, y: 42, w: 68, h: 28 });
    expect(difference(before, render(editor, board)).max).toBe(0);
  });

  it('没有填充的文字不转', async () => {
    const { editor, store, board, add } = setup();
    const text = add(textNode(store, board, { fill: null }));
    expect(await editor.outlineText([text.id])).toEqual([]);
    expect(store.get(text.id)).toBe(text);
  });
});
