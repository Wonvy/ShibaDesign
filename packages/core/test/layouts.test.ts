import { describe, expect, it } from 'vitest';
import {
  DocStore,
  buildLayout,
  createNode,
  nextSeq,
  rgba,
  slideLayouts,
  solid,
  validateDocument,
  type ArtboardNode,
  type ColorStyleDef,
  type LayoutContext,
  type SceneNode,
  type TextNode,
  type TextStyleDef,
} from '../src';

const TEXTS = {
  title: '标题',
  subtitle: '副标题',
  body: '第一点\n第二点\n第三点',
  body2: '左\n右',
  caption: '注释',
  quote: '一句话',
  number: '01',
  image: '图片',
};

function setup(size: [number, number] = [1280, 720]): { store: DocStore; board: ArtboardNode } {
  const store = DocStore.create();
  const board = store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size,
        fill: solid(rgba(1, 1, 1)),
        deck: { order: 'a0', notes: '' },
      }),
    ),
  );
  return { store, board };
}

function context(board: ArtboardNode, extra: Partial<LayoutContext> = {}): LayoutContext {
  return {
    parent: board.id,
    size: board.size,
    texts: TEXTS,
    fonts: { latin: 'Inter', cjk: 'Noto Sans SC' },
    colorStyles: [],
    textStyles: [],
    background: rgba(1, 1, 1),
    ...extra,
  };
}

function place(store: DocStore, nodes: SceneNode[]): void {
  store.transact('layout', (tx) => nodes.forEach((n) => tx.create(n)));
}

describe('幻灯片版式', () => {
  it('每个版式生成的对象都在幻灯片里、能通过文件校验，层序和序号都补好了', () => {
    const ids = slideLayouts().map((l) => l.id);
    expect(ids).toEqual(['blank', 'title', 'titleContent', 'twoColumns', 'imageText', 'section', 'titleOnly', 'quote']);
    for (const id of ids) {
      const { store, board } = setup();
      const nodes = buildLayout(id, context(board), (type) => nextSeq(store, type));
      place(store, nodes);
      expect(() => validateDocument(JSON.parse(JSON.stringify(store.toJSON())))).not.toThrow();
      const indices = nodes.map((n) => n.index);
      expect(new Set(indices).size).toBe(nodes.length);
      expect([...indices].sort()).toEqual(indices);
      for (const node of nodes) {
        expect(node.parent).toBe(board.id);
        const [x, y] = [node.transform[4], node.transform[5]];
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + node.size[0]).toBeLessThanOrEqual(board.size[0] + 0.5);
        expect(y).toBeLessThan(board.size[1]);
      }
      const texts = nodes.filter((n): n is TextNode => n.type === 'text');
      expect(new Set(texts.map((t) => t.seq)).size).toBe(texts.length);
    }
  });

  it('标题和正文：正文每行一个项目符号，排在标题下面', () => {
    const { store, board } = setup();
    const [title, body] = buildLayout('titleContent', context(board), (type) => nextSeq(store, type)) as TextNode[];
    expect(title!.text).toBe('标题');
    expect(title!.style.fontWeight).toBe(700);
    expect(body!.paragraphs).toEqual([{ list: 'bullet' }, { list: 'bullet' }, { list: 'bullet' }]);
    expect(body!.transform[5]).toBeGreaterThan(title!.transform[5] + title!.style.fontSize);
    expect(body!.sizing).toBe('fixed');
  });

  it('文档里有对应用途的样式时用它们并链接上', () => {
    const { store, board } = setup();
    const heading: TextStyleDef = {
      id: 'h',
      name: '标题',
      role: 'title',
      style: {
        fontFamily: { latin: 'Tinos', cjk: 'Noto Serif SC' },
        fontSize: 80,
        fontWeight: 700,
        lineHeight: 1.1,
        letterSpacing: 0,
      },
    };
    const ink: ColorStyleDef = { id: 'ink', name: '文字', role: 'text', color: rgba(0.2, 0.1, 0.4) };
    const accent: ColorStyleDef = { id: 'acc', name: '强调', role: 'accent', color: rgba(1, 0.5, 0) };
    store.transact('styles', (tx) => tx.update(store.root.id, { textStyles: [heading], colorStyles: [ink, accent] }));
    const nodes = buildLayout(
      'section',
      context(board, { textStyles: [heading], colorStyles: [ink, accent] }),
      (type) => nextSeq(store, type),
    );
    const [bar, number, title] = nodes as [SceneNode, TextNode, TextNode];
    expect('fill' in bar && bar.fill).toEqual({ type: 'solid', color: accent.color, colorStyle: 'acc' });
    expect(number.fill).toEqual({ type: 'solid', color: accent.color, colorStyle: 'acc' });
    expect(title.textStyle).toBe('h');
    expect(title.style.fontSize).toBe(80);
    expect(title.fill).toEqual({ type: 'solid', color: ink.color, colorStyle: 'ink' });
    // 放进文档以后链接还在（和样式的值对得上，整理器不会断开）
    place(store, nodes);
    expect((store.get(title.id) as TextNode).textStyle).toBe('h');
  });

  it('没有样式时按背景选文字颜色，字号按幻灯片的高度换算', () => {
    const { store, board } = setup([1920, 1080]);
    const dark = buildLayout('title', context(board, { background: rgba(0.05, 0.05, 0.1) }), (type) =>
      nextSeq(store, type),
    ) as TextNode[];
    expect(dark[0]!.fill?.color).toEqual(rgba(1, 1, 1));
    expect(dark[0]!.style.fontSize).toBe(78);
    // 副标题是次要的颜色
    expect(dark[1]!.fill?.color.a).toBeCloseTo(0.6);
    const light = buildLayout('title', context(board), (type) => nextSeq(store, type)) as TextNode[];
    expect(light[0]!.fill?.color.r).toBeLessThan(0.2);
  });

  it('不认识的版式返回空', () => {
    const { store, board } = setup();
    expect(buildLayout('nope', context(board), (type) => nextSeq(store, type))).toEqual([]);
  });
});
