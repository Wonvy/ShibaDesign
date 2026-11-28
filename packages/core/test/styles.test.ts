import { describe, expect, it } from 'vitest';
import {
  DocStore,
  applyTextStyle,
  createNode,
  rgba,
  solid,
  translation,
  validateDocument,
  type ColorStyleDef,
  type PageNode,
  type RectNode,
  type TextNode,
  type TextStyle,
  type TextStyleDef,
} from '../src';

const RED = rgba(1, 0, 0);
const BLUE = rgba(0, 0, 1);

const BODY: TextStyle = {
  fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
  fontSize: 24,
  fontWeight: 400,
  lineHeight: 1.4,
  letterSpacing: 0,
};

function setup(): { store: DocStore; rect: RectNode; text: TextNode } {
  const store = DocStore.create();
  const root = store.root.id;
  const brand: ColorStyleDef = { id: 'brand', name: '品牌色', color: RED };
  const body: TextStyleDef = { id: 'body', name: '正文', style: BODY };
  store.transact('setup', (tx) => {
    tx.update(root, { colorStyles: [brand], textStyles: [body] });
    tx.create(
      createNode('rect', {
        id: 'r',
        parent: root,
        index: 'a0',
        seq: 1,
        size: [10, 10],
        fill: { type: 'solid', color: RED, colorStyle: 'brand' },
        stroke: { color: RED, width: 2, colorStyle: 'brand' },
        cornerRadius: 0,
      }),
    );
    tx.create(
      createNode('text', {
        id: 't',
        parent: root,
        index: 'a1',
        seq: 1,
        transform: translation(0, 40),
        text: '你好 world',
        style: BODY,
        align: 'left',
        sizing: 'auto',
        fill: solid(BLUE),
        textStyle: 'body',
        // "world" 单独加粗
        spans: [{ start: 3, end: 8, style: { fontWeight: 700 } }],
      }),
    );
  });
  store.sealHistory();
  return { store, rect: store.get('r') as RectNode, text: store.get('t') as TextNode };
}

function setColorStyle(store: DocStore, color: typeof RED): void {
  const page = store.root as PageNode;
  store.transact('style', (tx) =>
    tx.update(page.id, { colorStyles: page.colorStyles!.map((s) => (s.id === 'brand' ? { ...s, color } : s)) }),
  );
  store.sealHistory();
}

describe('颜色样式', () => {
  it('改样式时链接它的填充和描边一起改，是一步撤销', () => {
    const { store } = setup();
    setColorStyle(store, BLUE);
    const rect = store.get('r') as RectNode;
    expect(rect.fill).toEqual({ type: 'solid', color: BLUE, colorStyle: 'brand' });
    expect(rect.stroke?.color).toEqual(BLUE);
    store.undo();
    const back = store.get('r') as RectNode;
    expect(back.fill?.type === 'solid' && back.fill.color).toEqual(RED);
    expect(back.stroke?.color).toEqual(RED);
  });

  it('手动改了颜色就断开链接', () => {
    const { store } = setup();
    store.transact('color', (tx) => {
      const rect = tx.get('r') as RectNode;
      tx.update('r', { fill: { ...(rect.fill as { type: 'solid'; color: typeof RED }), color: BLUE } });
    });
    const rect = store.get('r') as RectNode;
    expect(rect.fill).toEqual({ type: 'solid', color: BLUE });
    // 描边没动，还链接着
    expect(rect.stroke?.colorStyle).toBe('brand');
    // 之后再改样式，断开的填充不跟着变
    setColorStyle(store, rgba(0, 1, 0));
    const after = store.get('r') as RectNode;
    expect(after.fill?.type === 'solid' && after.fill.color).toEqual(BLUE);
    expect(after.stroke?.color).toEqual(rgba(0, 1, 0));
  });

  it('删掉样式时链接断开，颜色留着', () => {
    const { store } = setup();
    store.transact('delete style', (tx) => tx.update(store.root.id, { colorStyles: [] }));
    const rect = store.get('r') as RectNode;
    expect(rect.fill).toEqual({ type: 'solid', color: RED });
    expect(rect.stroke).toEqual({ color: RED, width: 2 });
  });

  it('移动对象不影响链接', () => {
    const { store } = setup();
    store.transact('move', (tx) => tx.update('r', { transform: translation(5, 5) }));
    expect((store.get('r') as RectNode).fill).toEqual({ type: 'solid', color: RED, colorStyle: 'brand' });
  });
});

describe('文字样式', () => {
  it('改样式时只换整段的默认样式，单独加粗的字保留', () => {
    const { store } = setup();
    const page = store.root as PageNode;
    store.transact('style', (tx) =>
      tx.update(page.id, {
        textStyles: [{ id: 'body', name: '正文', style: { ...BODY, fontSize: 32, italic: true } }],
      }),
    );
    const text = store.get('t') as TextNode;
    expect(text.style.fontSize).toBe(32);
    expect(text.style.italic).toBe(true);
    expect(text.textStyle).toBe('body');
    expect(text.spans).toEqual([{ start: 3, end: 8, style: { fontWeight: 700 } }]);
    // 颜色不归文字样式管
    expect(text.fill?.color).toEqual(BLUE);
  });

  it('样式改成和单独设的一样时，区间里那一项去掉', () => {
    const { store } = setup();
    store.transact('style', (tx) =>
      tx.update(store.root.id, { textStyles: [{ id: 'body', name: '正文', style: { ...BODY, fontWeight: 700 } }] }),
    );
    expect((store.get('t') as TextNode).spans).toBeUndefined();
  });

  it('套用样式时整段换成样式的值，单独设过的同一项也换掉', () => {
    const { store, text } = setup();
    const heading: TextStyleDef = { id: 'h1', name: '标题', style: { ...BODY, fontSize: 64, fontWeight: 600 } };
    store.transact('apply', (tx) => {
      tx.update(store.root.id, { textStyles: [heading] });
      tx.update('t', applyTextStyle(text, heading));
    });
    const after = store.get('t') as TextNode;
    expect(after.textStyle).toBe('h1');
    expect(after.style.fontSize).toBe(64);
    expect(after.style.fontWeight).toBe(600);
    expect(after.spans).toBeUndefined();
  });

  it('手动改了整段的字号就断开链接，改个别字的不断开', () => {
    const { store } = setup();
    store.transact('spans', (tx) => tx.update('t', { spans: [{ start: 0, end: 2, style: { fontSize: 40 } }] }));
    expect((store.get('t') as TextNode).textStyle).toBe('body');
    store.transact('size', (tx) => tx.update('t', { style: { ...BODY, fontSize: 30 } }));
    expect((store.get('t') as TextNode).textStyle).toBeUndefined();
  });
});

describe('样式的校验', () => {
  it('合法的样式和链接能通过，类型不对的拒绝', () => {
    const { store } = setup();
    const data = store.toJSON();
    expect(() => validateDocument(JSON.parse(JSON.stringify(data)))).not.toThrow();
    const bad = JSON.parse(JSON.stringify(data));
    bad.nodes[data.rootId].colorStyles = [{ id: 'x', name: 'x', color: 'red' }];
    expect(() => validateDocument(bad)).toThrow();
    const badLink = JSON.parse(JSON.stringify(data));
    badLink.nodes.r.fill.colorStyle = 3;
    expect(() => validateDocument(badLink)).toThrow();
    const badText = JSON.parse(JSON.stringify(data));
    badText.nodes[data.rootId].textStyles = [{ id: 'x', name: 'x', style: { fontSize: 1 } }];
    expect(() => validateDocument(badText)).toThrow();
  });
});
