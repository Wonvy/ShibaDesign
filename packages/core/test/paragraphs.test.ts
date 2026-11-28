import { describe, expect, it } from 'vitest';
import {
  listMarkers,
  normalizeParagraphs,
  paragraphGeometry,
  paragraphIndexAt,
  paragraphRanges,
  paragraphStyles,
  paragraphsAfterEdit,
  rangeParagraphStyle,
  setParagraphStyle,
  validateDocument,
  type ParagraphStyle,
  type TextNode,
} from '../src';

type Node = Pick<TextNode, 'text' | 'align' | 'paragraphs'>;
const node = (text: string, paragraphs?: TextNode['paragraphs'], align: TextNode['align'] = 'left'): Node => ({
  text,
  align,
  paragraphs,
});

describe('段落', () => {
  it('按换行分段；空文本、末尾的换行也各算一段', () => {
    expect(paragraphRanges('ab\ncd\n')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 6 },
    ]);
    expect(paragraphRanges('')).toEqual([{ start: 0, end: 0 }]);
    expect(paragraphIndexAt('ab\ncd', 2)).toBe(0);
    expect(paragraphIndexAt('ab\ncd', 3)).toBe(1);
  });

  it('只给选区碰到的段落设样式；碰到全部段落时对齐改成整段的默认值', () => {
    const n = node('一\n二\n三');
    const middle = setParagraphStyle(n, 3, 3, { align: 'center', spaceAfter: 12 });
    expect(middle).toEqual({ align: 'left', paragraphs: [null, { align: 'center', spaceAfter: 12 }] });

    const all = setParagraphStyle({ ...n, ...middle } as Node, 0, n.text.length, { align: 'right' });
    expect(all.align).toBe('right');
    expect(all.paragraphs).toEqual([null, { spaceAfter: 12 }]);
    // 和默认值一样的项不存
    expect(setParagraphStyle(n, 0, 0, { indent: 0, list: null })).toEqual({ align: 'left', paragraphs: undefined });
  });

  it('选区跨了几段时，不一致的项算作 mixed', () => {
    const n = node('一\n二\n三', [{ list: 'bullet' }, { list: 'bullet', level: 1 }]);
    const { style, mixed } = rangeParagraphStyle(n, 0, 3);
    expect(style.list).toBe('bullet');
    expect([...mixed]).toEqual(['level']);
    expect(rangeParagraphStyle(n, 0, n.text.length).mixed.has('list')).toBe(true);
  });

  it('打字时段落样式跟着走：回车分出的新段接着原来的样式，删掉换行合并时用前一段的样式', () => {
    const n = node('一\n二\n三', [null, { list: 'number' }]);
    // 在第二段末尾按回车
    expect(paragraphsAfterEdit(n, '一\n二\n\n三', 4)).toEqual([null, { list: 'number' }, { list: 'number' }]);
    // 在第三段开头按回车：新分出的空段接着第三段的样式
    expect(paragraphsAfterEdit(n, '一\n二\n\n三', 5)).toEqual([null, { list: 'number' }]);
    // 删掉第一段和第二段之间的换行
    expect(paragraphsAfterEdit(n, '一二\n三')).toBeUndefined();
    // 删掉第二段和第三段之间的换行
    expect(paragraphsAfterEdit(n, '一\n二三')).toEqual([null, { list: 'number' }]);
    // 在第三段里打字，前面的不受影响
    expect(paragraphsAfterEdit(n, '一\n二\n三四')).toEqual([null, { list: 'number' }]);
    // 一次粘贴进好几段
    expect(paragraphsAfterEdit(n, '一\n二a\nb\nc\n三')).toEqual([
      null,
      { list: 'number' },
      { list: 'number' },
      { list: 'number' },
    ]);
  });

  it('整理：数值夹到范围里，层级取整，末尾的空项去掉', () => {
    expect(normalizeParagraphs([{ indent: -5, level: 2.6, list: 'bullet' }, {}, null], 3, 'left')).toEqual([
      { level: 3, list: 'bullet' },
    ]);
    expect(normalizeParagraphs([{ align: 'left' }], 1, 'left')).toBeUndefined();
    expect(normalizeParagraphs([{ align: 'left' }], 1, 'center')).toEqual([{ align: 'left' }]);
  });

  it('列表符号：编号连续，里一级重新数，碰到普通段落从头数，层级换样式', () => {
    const n = node('a\nb\nc\nd\ne\nf\ng\nh', [
      { list: 'number' },
      { list: 'number' },
      { list: 'number', level: 1 },
      { list: 'number', level: 1 },
      { list: 'number' },
      { list: 'bullet', level: 1 },
      null,
      { list: 'number' },
    ]);
    expect(listMarkers(paragraphStyles(n))).toEqual(['1.', '2.', 'a.', 'b.', '3.', '◦', null, '1.']);
    const deep = paragraphStyles(node('x', [{ list: 'number', level: 2 }]));
    expect(listMarkers(deep)).toEqual(['i.']);
  });

  it('列表项的文字缩进一档，符号右边留半个字', () => {
    const style: ParagraphStyle = {
      align: 'left',
      spaceBefore: 0,
      spaceAfter: 0,
      indent: 10,
      firstLine: 24,
      list: 'bullet',
      level: 1,
    };
    expect(paragraphGeometry(style, 20)).toEqual({ left: 10 + 2 * 1.8 * 20, firstLine: 0, markerRight: 10 + 72 - 10 });
    expect(paragraphGeometry({ ...style, list: null }, 20)).toEqual({ left: 10, firstLine: 24, markerRight: null });
  });

  it('打开文件时检查段落样式', () => {
    const doc = (paragraphs: unknown) => ({
      version: 1,
      rootId: 'r',
      nodes: {
        r: { id: 'r', type: 'page', parent: null, index: 'a0', ...common() },
        t: {
          id: 't',
          type: 'text',
          parent: 'r',
          index: 'a0',
          ...common(),
          text: 'a\nb',
          style: {
            fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
            fontSize: 12,
            fontWeight: 400,
            lineHeight: 1.2,
            letterSpacing: 0,
          },
          align: 'left',
          sizing: 'auto',
          fill: null,
          paragraphs,
        },
      },
    });
    expect(() => validateDocument(doc([null, { list: 'bullet', level: 2, indent: 10 }]))).not.toThrow();
    expect(() => validateDocument(doc([null, null, { indent: 1 }]))).toThrow();
    expect(() => validateDocument(doc([{ list: 'star' }]))).toThrow();
    expect(() => validateDocument(doc([{ level: 99 }]))).toThrow();
    expect(() => validateDocument(doc([{ indent: -1 }]))).toThrow();
    expect(() => validateDocument(doc([{ color: 'red' }]))).toThrow();
  });
});

function common() {
  return {
    lineageId: 'l',
    seq: 1,
    transform: [1, 0, 0, 1, 0, 0],
    size: [0, 0],
    opacity: 1,
    blendMode: 'normal',
    visible: true,
    locked: false,
  };
}
