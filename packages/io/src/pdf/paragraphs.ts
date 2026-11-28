import type { TextAlign } from '@shiba/core';
import type { PdfTextItem, PdfTextStyleRun } from './ir';

/**
 * 段落重建：把一行一行的文字拼回段落。
 *
 * PDF 里没有"段落"这回事，只有一行行摆好位置的字。要让文字可以编辑、改了之后能自动折行，
 * 得先认出哪几行是同一段：方向和字号相同、颜色字体一致、行距均匀、左右边对齐方式一致。
 * 只把画的顺序上紧挨着的行拼在一起，不跨过别的对象——这样拼完之后的上下层次和原文件完全一样。
 */

export interface TextBlock {
  lines: PdfTextItem[];
  /** 基线方向（单位向量） */
  dirX: number;
  dirY: number;
  /** 第一行基线的起点，块坐标系的原点 */
  originX: number;
  originY: number;
  /** 块坐标系里所有行的左右范围：沿基线方向量 */
  left: number;
  right: number;
  /** 基线到基线的距离；只有一行时为 0 */
  spacing: number;
  align: TextAlign;
  /** 拼好的文字，段落之间用 \n 分隔 */
  text: string;
  /** text 里每个字（UTF-16 单元）的字体、字号、颜色 */
  styles: PdfTextStyleRun[];
}

interface Placed {
  item: PdfTextItem;
  start: number;
  end: number;
  /** 基线在块坐标系里垂直向下的位置 */
  across: number;
}

interface Draft {
  lines: Placed[];
  dirX: number;
  dirY: number;
  originX: number;
  originY: number;
  align: TextAlign | null;
  spacing: number;
}

/**
 * 简化字形的部首。康熙部首可以直接用 Unicode 规范化换回普通汉字，这一组不行，只能查表。
 * 简体中文字体常把「页」「门」这些字映射到外形相同的部首码位上
 */
const SIMPLIFIED_RADICALS = new Map(
  [...'⻅见⻉贝⻋车⻓长⻔门⻚页⻛风⻜飞⻝食⻢马⻣骨⻥鱼⻦鸟⻨麦⻩黄⻬齐⻮齿⻰龙⻳龟'].flatMap((char, i, all) =>
    i % 2 === 0 ? [[char, all[i + 1]!] as const] : [],
  ),
);

/** 中日文字符（含全角标点）：这些字之间折行时不加空格 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u3040-\u30ff]/;

/**
 * 整理从 PDF 里读出来的一行文字：合并空白；把"部首"字符换回普通汉字。
 * 有些字体把「小」「一」这样的字映射到了外形相同的康熙部首码位（⼩、⼀），看着一样，搜索和输入时却对不上。
 */
export function cleanText(text: string): string {
  return plainHanzi(text).replace(/\s+/g, ' ').trim();
}

/** 把部首码位换回外形相同的普通汉字（见上面 SIMPLIFIED_RADICALS） */
export function plainHanzi(text: string): string {
  return text.replace(/[\u2e80-\u2fdf]/g, (char) => SIMPLIFIED_RADICALS.get(char) ?? char.normalize('NFKC'));
}

/** 一行字的整体样式，给没有自己样式的字（补出来的空格、换行）用 */
function lineStyle(item: PdfTextItem): PdfTextStyleRun {
  return item.styles[item.styles.length - 1] ?? { length: 0, font: item.font, size: item.size, fill: item.fill };
}

/** cleanText 的带样式版本：整理一行字，每个留下来的字带着它原来的样式 */
function cleanLine(item: PdfTextItem): { text: string; styles: PdfTextStyleRun[] } {
  const raw = plainHanzi(item.text);
  const per: PdfTextStyleRun[] = [];
  for (const run of item.styles) for (let i = 0; i < run.length; i++) per.push(run);
  let text = '';
  const styles: PdfTextStyleRun[] = [];
  let space: PdfTextStyleRun | null = null;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    const style = per[i] ?? lineStyle(item);
    // 连续的空白合成一个空格，开头结尾的去掉
    if (/\s/.test(char)) {
      if (text.length > 0) space ??= style;
      continue;
    }
    if (space) {
      text += ' ';
      styles.push(space);
      space = null;
    }
    text += char;
    styles.push(style);
  }
  return { text, styles };
}

function sameColor(a: PdfTextItem['fill'], b: PdfTextItem['fill']): boolean {
  if (!a || !b) return a === b;
  const close = (x: number, y: number): boolean => Math.abs(x - y) < 1e-3;
  return close(a.r, b.r) && close(a.g, b.g) && close(a.b, b.b) && close(a.a, b.a);
}

function place(draft: Draft, item: PdfTextItem): Placed {
  const dx = item.x - draft.originX;
  const dy = item.y - draft.originY;
  const start = dx * draft.dirX + dy * draft.dirY;
  return { item, start, end: start + item.length, across: -dx * draft.dirY + dy * draft.dirX };
}

/**
 * 新的一行能不能接在这一块后面。能的话返回它的位置，以及这一块的对齐方式（第二行进来时才定下来）。
 * styleOf 返回字体的类别和粗细之类的标识，不同的不拼在一起。
 */
function accept(
  draft: Draft,
  item: PdfTextItem,
  styleOf: (item: PdfTextItem) => string,
): { placed: Placed; align: TextAlign } | null {
  const first = draft.lines[0]!;
  const last = draft.lines[draft.lines.length - 1]!;
  const size = first.item.size;
  const compatible =
    !item.vertical &&
    item.dirX * draft.dirX + item.dirY * draft.dirY > 0.9995 &&
    Math.abs(item.size - size) <= size * 0.02 &&
    (item.glyphs.length === 0) === (first.item.glyphs.length === 0) &&
    item.blendMode === first.item.blendMode &&
    sameColor(item.fill, first.item.fill) &&
    item.clip === first.item.clip &&
    item.softMask === first.item.softMask &&
    styleOf(item) === styleOf(first.item);
  if (!compatible) return null;

  const placed = place(draft, item);
  // 行距：在一个字号到两倍半字号之间，并且和这一块已有的行距一致
  const gap = placed.across - last.across;
  if (gap < size * 0.9 || gap > size * 2.5) return null;
  if (draft.spacing > 0 && Math.abs(gap - draft.spacing) > Math.max(size * 0.12, draft.spacing * 0.06)) return null;

  const tolerance = size * 0.6;
  const left = Math.min(...draft.lines.map((l) => l.start));
  const right = Math.max(...draft.lines.map((l) => l.end));
  const middle = (placed.start + placed.end) / 2;
  if (placed.start >= right + size || placed.end <= left - size) return null;

  if (draft.align === null) {
    // 第二行决定对齐方式。先看左边对不对得齐；再看中线（居中的几行，第一行短的话看起来也像缩进，
    // 但真正的首行缩进会让中线错开半个缩进的距离）；最后才当作首行缩进的左对齐
    if (Math.abs(placed.start - first.start) <= tolerance) return { placed, align: 'left' };
    if (Math.abs(middle - (first.start + first.end) / 2) <= tolerance) return { placed, align: 'center' };
    if (Math.abs(placed.end - first.end) <= tolerance) return { placed, align: 'right' };
    const indent = first.start - placed.start;
    if (indent > tolerance && indent <= size * 6) return { placed, align: 'left' };
    return null;
  }
  switch (draft.align) {
    case 'left': {
      // 往右缩进的一行是新段落的开头
      const indent = placed.start - left;
      return indent >= -tolerance && indent <= size * 6 ? { placed, align: 'left' } : null;
    }
    case 'center':
      return Math.abs(middle - (first.start + first.end) / 2) <= tolerance ? { placed, align: 'center' } : null;
    default:
      return Math.abs(placed.end - right) <= tolerance ? { placed, align: 'right' } : null;
  }
}

function finish(draft: Draft): TextBlock {
  const { lines } = draft;
  const size = lines[0]!.item.size;
  const left = Math.min(...lines.map((l) => l.start));
  const right = Math.max(...lines.map((l) => l.end));
  let align: TextAlign = draft.align ?? 'left';
  const breaks = lines.map(() => false);

  if (align === 'left' && lines.length >= 3) {
    // 两端对齐：除了每段最后一行，各行都顶到右边。顶到右边的行占多数就当作两端对齐，
    // 没顶到右边的那些行就是一段的结尾，下一行另起一段
    const body = lines.slice(0, -1);
    const flush = body.filter((l) => right - l.end <= size * 0.5).length;
    if (flush >= 2 && flush >= body.length * 0.6) {
      align = 'justify';
      body.forEach((line, i) => {
        if (right - line.end > size * 1.5) breaks[i + 1] = true;
      });
    }
  }
  if (align === 'center' || align === 'right') {
    // 居中和右对齐的多半是标题、署名、地址这类每行单独断开的文字，保留原来的断行
    breaks.fill(true, 1);
  }
  if (align === 'left' || align === 'justify') {
    // 比左边多缩进一截的行是新段落的开头
    lines.forEach((line, i) => {
      if (i > 0 && line.start - left > size * 0.6) breaks[i] = true;
    });
  }

  // 文字和每个字的样式一起拼：补出来的缩进、换行、空格跟着旁边的字
  let text = '';
  const styles: PdfTextStyleRun[] = [];
  lines.forEach((line, i) => {
    const cleaned = cleanLine(line.item);
    let content = cleaned.text;
    const contentStyles = cleaned.styles;
    const own = contentStyles[0] ?? lineStyle(line.item);
    // 中文段落开头习惯空两格：缩进按全角空格保留下来，换成我们的字体之后段首照样空出来
    const indent = Math.round((line.start - left) / size);
    if ((align === 'left' || align === 'justify') && indent >= 1 && CJK.test(content[0] ?? '')) {
      const count = Math.min(indent, 4);
      content = '\u3000'.repeat(count) + content;
      contentStyles.unshift(...new Array<PdfTextStyleRun>(count).fill(own));
    }
    const previousStyle = styles[styles.length - 1] ?? own;
    if (i === 0) {
      text = content;
    } else if (breaks[i]) {
      text += '\n' + content;
      styles.push(previousStyle);
    } else {
      const previous = text[text.length - 1] ?? '';
      const glued = CJK.test(previous) || CJK.test(content[0] ?? '') || (previous === '-' && text.length > 1);
      if (!glued) {
        text += ' ';
        styles.push(previousStyle);
      }
      text += content;
    }
    styles.push(...contentStyles);
  });

  return {
    lines: lines.map((l) => l.item),
    dirX: draft.dirX,
    dirY: draft.dirY,
    originX: draft.originX,
    originY: draft.originY,
    left,
    right,
    spacing: lines.length > 1 ? (lines[lines.length - 1]!.across - lines[0]!.across) / (lines.length - 1) : 0,
    align: lines.length > 1 ? align : 'left',
    text,
    styles,
  };
}

/** 把按画的顺序排好的一串文字行拼成段落 */
export function groupLines(items: readonly PdfTextItem[], styleOf: (item: PdfTextItem) => string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let draft: Draft | null = null;
  for (const item of items) {
    const accepted = draft ? accept(draft, item, styleOf) : null;
    if (draft && accepted) {
      draft.lines.push(accepted.placed);
      draft.align = accepted.align;
      if (draft.lines.length === 2) draft.spacing = accepted.placed.across - draft.lines[0]!.across;
      continue;
    }
    if (draft) blocks.push(finish(draft));
    draft = { lines: [], dirX: item.dirX, dirY: item.dirY, originX: item.x, originY: item.y, align: null, spacing: 0 };
    draft.lines.push(place(draft, item));
  }
  if (draft) blocks.push(finish(draft));
  return blocks;
}
