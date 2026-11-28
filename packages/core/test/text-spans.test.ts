import { describe, expect, it } from 'vitest';
import {
  DocumentError,
  createNode,
  rangeStyle,
  rgba,
  setCharacterStyle,
  solid,
  spansAfterEdit,
  styleAtCaret,
  styleRuns,
  textAppearanceBasis,
  validateDocument,
  type TextNode,
} from '../src';

const BLACK = rgba(0, 0, 0);
const RED = rgba(1, 0, 0);

function text(value: string, patch: Partial<TextNode> = {}): TextNode {
  return createNode('text', {
    parent: null,
    index: 'a0',
    seq: 1,
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
    fill: solid(BLACK),
    ...patch,
  });
}

/** 把一段字设成某个样式，返回改过的节点 */
function styled(node: TextNode, start: number, end: number, patch: Parameters<typeof setCharacterStyle>[3]): TextNode {
  return { ...node, ...setCharacterStyle(node, start, end, patch) } as TextNode;
}

describe('字符级样式', () => {
  it('给一段字设置样式：只记和默认样式不同的项，按样式切成连续的几段', () => {
    const node = styled(text('Hello world'), 6, 11, { fontWeight: 700, color: RED });
    expect(node.spans).toEqual([{ start: 6, end: 11, style: { fontWeight: 700, color: RED } }]);
    const runs = styleRuns(node);
    expect(runs.map((r) => [r.start, r.end, r.style.fontWeight])).toEqual([
      [0, 6, 400],
      [6, 11, 700],
    ]);
  });

  it('相邻的相同样式合成一段；设回默认值的项去掉，区间也随之消失', () => {
    let node = styled(text('abcdef'), 0, 2, { italic: true });
    node = styled(node, 2, 4, { italic: true });
    expect(node.spans).toEqual([{ start: 0, end: 4, style: { italic: true } }]);
    node = styled(node, 0, 4, { italic: false });
    expect(node.spans).toBeUndefined();
  });

  it('样式可以叠加：在粗体里再设颜色，只有重叠的那几个字两项都有', () => {
    let node = styled(text('abcdef'), 0, 4, { fontWeight: 700 });
    node = styled(node, 2, 6, { color: RED });
    expect(node.spans).toEqual([
      { start: 0, end: 2, style: { fontWeight: 700 } },
      { start: 2, end: 4, style: { fontWeight: 700, color: RED } },
      { start: 4, end: 6, style: { color: RED } },
    ]);
  });

  it('选中全部文字时改的是整段的默认样式，单独设过的字也跟着变', () => {
    let node = styled(text('abcdef'), 2, 4, { color: rgba(0, 0, 1), fontWeight: 700 });
    node = styled(node, 0, 6, { color: RED, underline: true });
    expect(node.fill).toEqual(solid(RED));
    expect(node.style.underline).toBe(true);
    // 颜色被整段的覆盖掉了，粗体还在
    expect(node.spans).toEqual([{ start: 2, end: 4, style: { fontWeight: 700 } }]);
    node = styled(node, 0, 6, { underline: false });
    expect(node.style.underline).toBeUndefined();
  });

  it('范围的样式：不一致的项记成"混合"；光标处取前一个字的样式', () => {
    const node = styled(text('abcdef'), 2, 4, { fontWeight: 700 });
    const range = rangeStyle(node, 1, 3);
    expect(range.style.fontWeight).toBe(400);
    expect([...range.mixed]).toEqual(['fontWeight']);
    expect(rangeStyle(node, 2, 4).mixed.size).toBe(0);
    expect(styleAtCaret(node, 4).fontWeight).toBe(700);
    expect(styleAtCaret(node, 2).fontWeight).toBe(400);
    expect(styleAtCaret(node, 0).fontWeight).toBe(400);
  });
});

describe('打字时区间跟着走', () => {
  const bold = (): TextNode => styled(text('ab**cd'), 2, 4, { fontWeight: 700 });

  it('在粗体后面接着打字还是粗体，在前面打字区间整体后移', () => {
    expect(spansAfterEdit(bold(), 'ab**xcd')).toEqual([{ start: 2, end: 5, style: { fontWeight: 700 } }]);
    expect(spansAfterEdit(bold(), 'xab**cd')).toEqual([{ start: 3, end: 5, style: { fontWeight: 700 } }]);
  });

  it('删掉一部分字，区间跟着缩短；整段删掉区间就没了', () => {
    expect(spansAfterEdit(bold(), 'ab*cd')).toEqual([{ start: 2, end: 3, style: { fontWeight: 700 } }]);
    expect(spansAfterEdit(bold(), 'abcd')).toBeUndefined();
  });

  it('选中一段再打字：新字接着被替换部分前面那个字的样式', () => {
    // 选中 "**c" 输入 "Z"：前一个字 b 是默认样式，所以 Z 也是
    expect(spansAfterEdit(bold(), 'abZd')).toBeUndefined();
  });

  it('指定了新字的样式时用它（光标处刚切到斜体还没打字）', () => {
    const node = text('ab');
    const italic = { ...styleAtCaret(node, 2), italic: true };
    expect(spansAfterEdit(node, 'abc', italic)).toEqual([{ start: 2, end: 3, style: { italic: true } }]);
  });
});

describe('字符级样式和保真外观、文件校验', () => {
  it('字符样式进指纹，没用到时指纹和以前一样', () => {
    const plain = text('abc');
    const withSpans = styled(plain, 0, 1, { fontWeight: 700 });
    expect(textAppearanceBasis(withSpans)).not.toBe(textAppearanceBasis(plain));
    expect(textAppearanceBasis({ ...plain, spans: undefined })).toBe(textAppearanceBasis(plain));
  });

  it('区间重叠、越界、类型不对的文件打不开', () => {
    const root = createNode('page', { parent: null, index: 'a0', seq: 1 });
    const doc = (spans: unknown) => ({
      version: 1,
      rootId: root.id,
      nodes: { [root.id]: root, t: { ...text('abcdef'), id: 't', parent: root.id, spans } },
    });
    expect(() => validateDocument(doc([{ start: 0, end: 2, style: { fontWeight: 700 } }]))).not.toThrow();
    for (const bad of [
      [{ start: 0, end: 9, style: {} }],
      [
        { start: 0, end: 3, style: {} },
        { start: 2, end: 4, style: {} },
      ],
      [{ start: 0, end: 2, style: { fontWeight: 'bold' } }],
      [{ start: 0, end: 2, style: { color: 'red' } }],
    ]) {
      expect(() => validateDocument(doc(bad))).toThrow(DocumentError);
    }
  });
});
