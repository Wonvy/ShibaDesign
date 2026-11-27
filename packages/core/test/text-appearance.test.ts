import { describe, expect, it } from 'vitest';
import {
  DocStore,
  DocumentError,
  createNode,
  decodeGlyphLibrary,
  encodeGlyphLibrary,
  hasLiveAppearance,
  referencedAssetIds,
  rgba,
  solid,
  textAppearanceBasis,
  validateDocument,
  type TextNode,
} from '../src';

function frozenText(store: DocStore): TextNode {
  const node = createNode('text', {
    parent: store.root.id,
    index: 'a0',
    seq: 1,
    size: [200, 40],
    text: 'Hello',
    style: {
      fontFamily: { latin: 'Arimo', cjk: 'Noto Sans SC' },
      fontSize: 20,
      fontWeight: 400,
      lineHeight: 1.2,
      letterSpacing: 0,
    },
    align: 'left',
    sizing: 'auto',
    fill: solid(rgba(0, 0, 0)),
  });
  const appearance = {
    runs: [{ library: 'ab12cd34ef', matrix: [20, 0, 0, -20] as const, glyphs: [0, 0, 19, 1, 12, 19] }],
    basis: textAppearanceBasis(node),
    baseline: 19,
  };
  return store.transact('add', (tx) => tx.create({ ...node, appearance }));
}

describe('文字的保真外观', () => {
  it('改文字、字体、字号、对齐、宽度之后不再按原字形显示', () => {
    const store = DocStore.create();
    const node = frozenText(store);
    expect(hasLiveAppearance(node)).toBe(true);
    const patched = (patch: Partial<TextNode>): boolean => hasLiveAppearance({ ...node, ...patch });
    expect(patched({ text: 'Hello!' })).toBe(false);
    expect(patched({ style: { ...node.style, fontSize: 21 } })).toBe(false);
    expect(patched({ style: { ...node.style, fontFamily: { latin: 'Tinos', cjk: 'Noto Sans SC' } } })).toBe(false);
    expect(patched({ align: 'center' })).toBe(false);
    expect(patched({ sizing: 'fixed' })).toBe(false);
  });

  it('改颜色、移动、改透明度不影响', () => {
    const store = DocStore.create();
    const node = frozenText(store);
    const patched = (patch: Partial<TextNode>): boolean => hasLiveAppearance({ ...node, ...patch });
    expect(patched({ fill: solid(rgba(1, 0, 0)) })).toBe(true);
    expect(patched({ transform: [1, 0, 0, 1, 50, 60] })).toBe(true);
    expect(patched({ opacity: 0.5 })).toBe(true);
    // 自动宽度时宽度不参与排版
    expect(patched({ size: [300, 40] })).toBe(true);
    expect(hasLiveAppearance({ ...node, sizing: 'fixed', size: [300, 40] })).toBe(false);
  });

  it('撤销回去之后又按原字形显示', () => {
    const store = DocStore.create();
    const node = frozenText(store);
    store.transact('type', (tx) => tx.update(node.id, { text: 'Changed' }));
    expect(hasLiveAppearance(store.require(node.id) as TextNode)).toBe(false);
    store.undo();
    expect(hasLiveAppearance(store.require(node.id) as TextNode)).toBe(true);
  });

  it('字形库算作文档引用的资源', () => {
    const store = DocStore.create();
    frozenText(store);
    expect([...referencedAssetIds(store)]).toEqual(['ab12cd34ef']);
  });

  it('文件里的保真外观要过校验', () => {
    const store = DocStore.create();
    const node = frozenText(store);
    const data = store.toJSON();
    expect(() => validateDocument(data)).not.toThrow();
    const broken = (appearance: unknown): unknown => ({
      ...data,
      nodes: { ...data.nodes, [node.id]: { ...data.nodes[node.id], appearance } },
    });
    expect(() => validateDocument(broken({ ...node.appearance, basis: 1 }))).toThrow(DocumentError);
    expect(() =>
      validateDocument(broken({ ...node.appearance, runs: [{ library: 'x', matrix: [1, 0, 0], glyphs: [] }] })),
    ).toThrow(DocumentError);
    // 字形数据必须三个一组，序号是非负整数
    const run = { library: 'x', matrix: [1, 0, 0, 1], glyphs: [0, 1] };
    expect(() => validateDocument(broken({ ...node.appearance, runs: [run] }))).toThrow(DocumentError);
    expect(() => validateDocument(broken({ ...node.appearance, runs: [{ ...run, glyphs: [-1, 0, 0] }] }))).toThrow(
      DocumentError,
    );
  });
});

describe('字形库', () => {
  it('编码后能原样解回来，坐标保留四位小数', () => {
    const square = [0, 0, 0, 1, 0.123456, 0, 1, 0.5, 0.5, 4];
    const curve = [0, 0, 0, 2, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 3, 0.7, 0.8, 0.9, 1, 4];
    expect(decodeGlyphLibrary(encodeGlyphLibrary([square, curve, []]))).toEqual({
      glyphs: [[0, 0, 0, 1, 0.1235, 0, 1, 0.5, 0.5, 4], curve, []],
      text: null,
      advances: null,
    });
  });

  it('还可以记下每个字形代表的文字和步进宽度；对不上时丢掉这两项，轮廓照用', () => {
    const square = [0, 0, 0, 1, 1, 1, 4];
    const decoded = decodeGlyphLibrary(
      encodeGlyphLibrary([square, []], { text: ['口', ''], advances: [1.23456, 0.25] }),
    );
    expect(decoded).toEqual({ glyphs: [square, []], text: ['口', ''], advances: [1.2346, 0.25] });

    const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const base = { format: 'shiba-glyphs', version: 1, glyphs: [square] };
    expect(decodeGlyphLibrary(encode({ ...base, text: ['a', 'b'], advances: ['x'] }))).toEqual({
      glyphs: [square],
      text: null,
      advances: null,
    });
    expect(decodeGlyphLibrary(encode({ ...base, text: ['x'.repeat(100)] }))!.text).toBeNull();
  });

  it('格式不对的字形库解不开', () => {
    const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const library = (glyphs: unknown): Uint8Array => encode({ format: 'shiba-glyphs', version: 1, glyphs });
    expect(decodeGlyphLibrary(new TextEncoder().encode('not json'))).toBeNull();
    expect(decodeGlyphLibrary(encode({ format: 'other', version: 1, glyphs: [] }))).toBeNull();
    expect(decodeGlyphLibrary(encode({ format: 'shiba-glyphs', version: 99, glyphs: [] }))).toBeNull();
    // 不认识的命令、坐标不够、坐标不是数
    expect(decodeGlyphLibrary(library([[7, 0, 0]]))).toBeNull();
    expect(decodeGlyphLibrary(library([[2, 0, 0, 1]]))).toBeNull();
    expect(decodeGlyphLibrary(library([[0, 'x', 0]]))).toBeNull();
    expect(decodeGlyphLibrary(library([[0, 0, 0, 1, 1, 1, 4]]))!.glyphs).toEqual([[0, 0, 0, 1, 1, 1, 4]]);
  });
});
