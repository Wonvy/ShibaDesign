import type { CanvasKit, FontWeight, LineMetrics, Paragraph } from 'canvaskit-wasm';
import {
  baseCharacterStyle,
  styleRuns,
  type CharacterStyle,
  type DocStore,
  type NodeId,
  type Rect,
  type SolidFill,
  type TextAlign,
  type TextNode,
  type TextSpan,
  type TextStyle,
} from '@shiba/core';
import { toSkColor } from '../skia';
import type { FontManager } from './fonts';

/** 排版一个文本节点要用到的字体：每种样式的字体家族、字重、正斜体，以及用这种样式的那些字 */
export interface TextFontRequest {
  families: string[];
  text: string;
  weight: number;
  italic: boolean;
}

/** 一个文本节点要用到哪些字体。排版和"等字体加载完"都按它来，两边才对得上 */
export function textFontRequests(node: TextNode): TextFontRequest[] {
  const request = (style: CharacterStyle, text: string): TextFontRequest => ({
    families: [style.fontFamily.latin, style.fontFamily.cjk],
    text,
    weight: style.fontWeight,
    italic: style.italic,
  });
  // 第一项是整段的默认样式，用全部文字：行高的"支柱"和空文本都靠它
  const requests = [request(baseCharacterStyle(node), node.text)];
  if (node.spans) {
    for (const run of styleRuns(node)) requests.push(request(run.style, node.text.slice(run.start, run.end)));
  }
  return requests;
}

/** 等一个文本节点用到的字体全部加载完 */
export async function ensureTextFonts(fonts: FontManager, node: TextNode): Promise<void> {
  await Promise.all(textFontRequests(node).map((r) => fonts.ensure(r.families, r.text, r.weight, r.italic)));
}

export interface TextLayout {
  paragraph: Paragraph;
  /** 文本框的宽度：固定宽度时是设定值，自动宽度时是最长一行的宽度 */
  width: number;
  height: number;
  lines: LineMetrics[];
  /** 每一行的上沿和高度（本地坐标）。光标、上下移动都按它算 */
  lineTops: number[];
  lineHeights: number[];
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
  spans: readonly TextSpan[] | undefined;
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
      cached.fill === node.fill &&
      cached.spans === node.spans
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
      spans: node.spans,
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
    const top = layout.lineTops[line.lineNumber] ?? 0;
    const height = layout.lineHeights[line.lineNumber] ?? layout.height;
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
    const { lines, paragraph, lineTops, lineHeights } = this.get(node);
    const current = lineAt(lines, offset);
    if (!current) return offset;
    const target = lines[current.lineNumber + direction];
    if (!target) return direction < 0 ? 0 : node.text.length;
    const middle = lineTops[target.lineNumber]! + lineHeights[target.lineNumber]! / 2;
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
    let pending = false;
    const resolve = (s: CharacterStyle, text: string): string[] => {
      const resolved = fonts.resolve([s.fontFamily.latin, s.fontFamily.cjk], text, s.fontWeight, s.italic);
      if (resolved.pending) pending = true;
      return resolved.names;
    };
    const base = baseCharacterStyle(node);
    const baseNames = resolve(base, node.text);
    const runs = styleRuns(node);

    // 不同字体的上下沿比例不一样，中英文混排的行会比纯中文的行高出几个像素。
    // 用"支柱"把每一行的高度强制成 字号 × 行高，行距才均匀。
    // 但有字比默认字号大时不能强制，否则大字的行会和上下行叠在一起：这时支柱只是最小行高，行跟着大字长高
    const forced = runs.every((run) => run.style.fontSize <= style.fontSize + 1e-6);
    const paragraphStyle = new ck.ParagraphStyle({
      textAlign: toSkAlign(ck, node.align),
      strutStyle: {
        strutEnabled: true,
        fontFamilies: baseNames,
        fontSize: style.fontSize,
        heightMultiplier: style.lineHeight,
        halfLeading: true,
        forceStrutHeight: forced,
      },
      textStyle: this.skTextStyle(base, baseNames, style.lineHeight),
    });
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(paragraphStyle, fonts.provider);
    if (node.spans) {
      for (const run of runs) {
        const text = node.text.slice(run.start, run.end);
        builder.pushStyle(new ck.TextStyle(this.skTextStyle(run.style, resolve(run.style, text), style.lineHeight)));
        builder.addText(text);
        builder.pop();
      }
    } else {
      builder.addText(node.text);
    }
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
    const height = paragraph.getHeight();
    const lines = paragraph.getLineMetrics();
    // 行高被强制成一样时每行等分总高度；否则按各行自己的高度（排版引擎给的是取整过的，按总高度缩放回去）
    const raw = lines.map((line) => (forced ? 1 : Math.max(1, line.height)));
    const total = raw.reduce((sum, h) => sum + h, 0) || 1;
    const lineHeights = raw.map((h) => (h / total) * height);
    const lineTops: number[] = [];
    let top = 0;
    for (const h of lineHeights) {
      lineTops.push(top);
      top += h;
    }
    return { paragraph, width, height, lines, lineTops, lineHeights, pending };
  }

  private skTextStyle(style: CharacterStyle, families: string[], lineHeight: number) {
    const { ck } = this;
    const decoration =
      (style.underline ? ck.UnderlineDecoration : 0) | (style.strikethrough ? ck.LineThroughDecoration : 0);
    const color = style.color ? toSkColor(ck, style.color) : ck.TRANSPARENT;
    return {
      color,
      fontFamilies: families,
      fontSize: style.fontSize,
      fontStyle: {
        weight: toSkWeight(ck, style.fontWeight),
        slant: style.italic ? ck.FontSlant.Italic : ck.FontSlant.Upright,
      },
      heightMultiplier: lineHeight,
      halfLeading: true,
      letterSpacing: style.letterSpacing,
      decoration,
      decorationColor: color,
      decorationThickness: 1,
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
