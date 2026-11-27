import type { CanvasKit, FontWeight, LineMetrics, Paragraph } from 'canvaskit-wasm';
import type { DocStore, NodeId, Rect, SolidFill, TextAlign, TextNode, TextStyle } from '@shiba/core';
import { toSkColor } from '../skia';
import type { FontManager } from './fonts';

export interface TextLayout {
  paragraph: Paragraph;
  /** 文本框的宽度：固定宽度时是设定值，自动宽度时是最长一行的宽度 */
  width: number;
  height: number;
  lines: LineMetrics[];
  /** 还有字体没加载完，当前结果可能缺字；加载完会自动重排 */
  pending: boolean;
}

interface Entry {
  layout: TextLayout;
  // 排版结果只取决于下面这些字段。节点移动、改名、改透明度都不需要重排
  text: string;
  style: TextStyle;
  align: TextAlign;
  sizing: TextNode['sizing'];
  width: number;
  fill: SolidFill | null;
  epoch: number;
}

const AUTO_LAYOUT_WIDTH = 1e6;

/**
 * 文本排版：把文本节点排成 Skia 段落并缓存，同时提供编辑需要的几何查询
 * （光标位置、点击位置对应的字符、选区矩形、上下行移动）。
 * 所有字符位置都是 JavaScript 字符串下标（UTF-16），坐标都是节点本地坐标。
 */
export class TextLayouts {
  private entries = new Map<NodeId, Entry>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ck: CanvasKit,
    store: DocStore,
    readonly fonts: FontManager,
  ) {
    this.unsubscribe = store.subscribe((change) => {
      for (const patch of change.patches) {
        if (!patch.after) this.drop(patch.id);
      }
    });
  }

  get(node: TextNode): TextLayout {
    const width = node.sizing === 'fixed' ? node.size[0] : 0;
    const cached = this.entries.get(node.id);
    if (
      cached &&
      cached.epoch === this.fonts.epoch &&
      cached.text === node.text &&
      cached.style === node.style &&
      cached.align === node.align &&
      cached.sizing === node.sizing &&
      cached.width === width &&
      cached.fill === node.fill
    ) {
      return cached.layout;
    }
    cached?.layout.paragraph.delete();
    const layout = this.build(node);
    this.entries.set(node.id, {
      layout,
      text: node.text,
      style: node.style,
      align: node.align,
      sizing: node.sizing,
      width,
      fill: node.fill,
      epoch: this.fonts.epoch,
    });
    return layout;
  }

  /** 丢弃全部缓存。字体加载完成后调用 */
  clear(): void {
    for (const entry of this.entries.values()) entry.layout.paragraph.delete();
    this.entries.clear();
  }

  dispose(): void {
    this.unsubscribe();
    this.clear();
  }

  // ───────────── 编辑用的几何查询 ─────────────

  /** 光标在某个字符位置时的矩形（宽度为 0） */
  caretRect(node: TextNode, offset: number): Rect {
    const layout = this.get(node);
    const { paragraph, lines } = layout;
    const line = lineAt(lines, offset);
    if (!line) return { x: alignedStart(node.align, layout.width), y: 0, w: 0, h: layout.height };

    // 每行高度被支柱强制成一样，所以行的位置直接按行号算，比用字体的上下沿更准
    const height = layout.height / lines.length;
    const top = line.lineNumber * height;
    const { ck } = this;
    const edge = (from: number, to: number, side: 'left' | 'right'): number | null => {
      const rects = paragraph.getRectsForRange(from, to, ck.RectHeightStyle.Max, ck.RectWidthStyle.Tight);
      const rect = side === 'left' ? rects[0] : rects[rects.length - 1];
      return rect ? (side === 'left' ? rect.rect[0]! : rect.rect[2]!) : null;
    };

    let x: number | null = null;
    if (offset > line.startIndex) x = edge(prevBoundary(node.text, offset), offset, 'right');
    else if (offset < node.text.length && node.text[offset] !== '\n') {
      x = edge(offset, nextBoundary(node.text, offset), 'left');
    }
    return { x: x ?? line.left, y: top, w: 0, h: height };
  }

  /** 本地坐标里的一个点最接近哪个字符位置 */
  offsetAt(node: TextNode, x: number, y: number): number {
    const layout = this.get(node);
    if (layout.lines.length === 0) return 0;
    const clampedY = Math.min(Math.max(y, 0), Math.max(0, layout.height - 0.01));
    const pos = layout.paragraph.getGlyphPositionAtCoordinate(x, clampedY).pos;
    return Math.min(Math.max(pos, 0), node.text.length);
  }

  /** 一段字符范围覆盖的矩形，每行一个或多个 */
  selectionRects(node: TextNode, start: number, end: number): Rect[] {
    if (start === end) return [];
    const { ck } = this;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    return this.get(node)
      .paragraph.getRectsForRange(from, to, ck.RectHeightStyle.Max, ck.RectWidthStyle.Tight)
      .map(({ rect }) => ({ x: rect[0]!, y: rect[1]!, w: rect[2]! - rect[0]!, h: rect[3]! - rect[1]! }));
  }

  /** 光标上移或下移一行后的字符位置。x 是希望保持的横坐标 */
  verticalMove(node: TextNode, offset: number, direction: -1 | 1, x: number): number {
    const { lines, paragraph, height } = this.get(node);
    const current = lineAt(lines, offset);
    if (!current) return offset;
    const target = lines[current.lineNumber + direction];
    if (!target) return direction < 0 ? 0 : node.text.length;
    const middle = (target.lineNumber + 0.5) * (height / lines.length);
    return Math.min(paragraph.getGlyphPositionAtCoordinate(x, middle).pos, node.text.length);
  }

  /** 某个字符位置所在的词，双击选词用 */
  wordAt(node: TextNode, offset: number): { start: number; end: number } {
    const range = this.get(node).paragraph.getWordBoundary(Math.min(offset, Math.max(0, node.text.length - 1)));
    return { start: range.start, end: range.end };
  }

  private drop(id: NodeId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.layout.paragraph.delete();
    this.entries.delete(id);
  }

  private build(node: TextNode): TextLayout {
    const { ck, fonts } = this;
    const { style } = node;
    const families = [style.fontFamily.latin, style.fontFamily.cjk];
    const resolved = fonts.resolve(families, node.text, style.fontWeight);

    const paragraphStyle = new ck.ParagraphStyle({
      textAlign: toSkAlign(ck, node.align),
      // 不同字体的上下沿比例不一样，中英文混排的行会比纯中文的行高出几个像素。
      // 用"支柱"把每一行的高度强制成 字号 × 行高，行距才均匀。
      strutStyle: {
        strutEnabled: true,
        fontFamilies: resolved.names,
        fontSize: style.fontSize,
        heightMultiplier: style.lineHeight,
        halfLeading: true,
        forceStrutHeight: true,
      },
      textStyle: {
        color: node.fill ? toSkColor(ck, node.fill.color) : ck.TRANSPARENT,
        fontFamilies: resolved.names,
        fontSize: style.fontSize,
        fontStyle: { weight: toSkWeight(ck, style.fontWeight) },
        heightMultiplier: style.lineHeight,
        halfLeading: true,
        letterSpacing: style.letterSpacing,
      },
    });
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(paragraphStyle, fonts.provider);
    builder.addText(node.text);
    const paragraph = builder.build();
    builder.delete();

    let width: number;
    if (node.sizing === 'fixed') {
      width = Math.max(1, node.size[0]);
      paragraph.layout(width);
    } else {
      // 先用极大的宽度排一次量出最长一行，再按这个宽度重排，这样居中和右对齐才有意义
      paragraph.layout(AUTO_LAYOUT_WIDTH);
      width = Math.ceil(paragraph.getLongestLine()) + 1;
      paragraph.layout(width);
    }
    return {
      paragraph,
      width,
      height: paragraph.getHeight(),
      lines: paragraph.getLineMetrics(),
      pending: resolved.pending,
    };
  }
}

/** 字符位置所在的行：起点不超过它的最后一行 */
function lineAt(lines: readonly LineMetrics[], offset: number): LineMetrics | null {
  let found: LineMetrics | null = null;
  for (const line of lines) {
    if (line.startIndex <= offset) found = line;
    else break;
  }
  return found;
}

/** 空文本或空行时，光标按对齐方式应该出现在哪 */
function alignedStart(align: TextAlign, width: number): number {
  if (align === 'center') return width / 2;
  if (align === 'right') return width;
  return 0;
}

/** 前一个字符的起点。遇到代理对（比如表情符号）要整个跳过 */
function prevBoundary(text: string, offset: number): number {
  const low = text.charCodeAt(offset - 1);
  const high = text.charCodeAt(offset - 2);
  const isPair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return Math.max(0, offset - (isPair ? 2 : 1));
}

function nextBoundary(text: string, offset: number): number {
  const high = text.charCodeAt(offset);
  const low = text.charCodeAt(offset + 1);
  const isPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return Math.min(text.length, offset + (isPair ? 2 : 1));
}

function toSkAlign(ck: CanvasKit, align: TextAlign) {
  switch (align) {
    case 'center':
      return ck.TextAlign.Center;
    case 'right':
      return ck.TextAlign.Right;
    case 'justify':
      return ck.TextAlign.Justify;
    default:
      return ck.TextAlign.Left;
  }
}

function toSkWeight(ck: CanvasKit, weight: number): FontWeight {
  const w = ck.FontWeight;
  const table: [number, FontWeight][] = [
    [100, w.Thin],
    [200, w.ExtraLight],
    [300, w.Light],
    [400, w.Normal],
    [500, w.Medium],
    [600, w.SemiBold],
    [700, w.Bold],
    [800, w.ExtraBold],
    [900, w.Black],
  ];
  let best = table[3]!;
  for (const entry of table) {
    if (Math.abs(entry[0] - weight) < Math.abs(best[0] - weight)) best = entry;
  }
  return best[1];
}
