import type { Canvas, CanvasKit, FontWeight, LineMetrics, Paragraph } from 'canvaskit-wasm';
import {
  baseCharacterStyle,
  listMarkers,
  paragraphGeometry,
  paragraphRanges,
  paragraphStyles,
  styleOfChar,
  styleRuns,
  type CharacterStyle,
  type ParagraphStyle,
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
  const base = baseCharacterStyle(node);
  const requests = [request(base, node.text)];
  if (node.spans) {
    for (const run of styleRuns(node)) requests.push(request(run.style, node.text.slice(run.start, run.end)));
  }
  // 列表的符号和编号，用各段第一个字的样式（和排版时一样）
  if (node.paragraphs) {
    const ranges = paragraphRanges(node.text);
    listMarkers(paragraphStyles(node)).forEach((marker, i) => {
      const range = ranges[i]!;
      if (marker) requests.push(request(range.end > range.start ? styleOfChar(node, range.start) : base, marker));
    });
  }
  return requests;
}

/** 等一个文本节点用到的字体全部加载完 */
export async function ensureTextFonts(fonts: FontManager, node: TextNode): Promise<void> {
  await Promise.all(textFontRequests(node).map((r) => fonts.ensure(r.families, r.text, r.weight, r.italic)));
}

/** 列表项前面的符号或编号：单独排成一个小段落，基线和这一段第一行对齐 */
export interface TextMarker {
  paragraph: Paragraph;
  x: number;
  y: number;
  text: string;
  style: CharacterStyle;
}

/** 排好的一段（文本里用换行分开的一段） */
export interface TextBlock {
  paragraph: Paragraph;
  /** 这一段的左上角，本地坐标 */
  x: number;
  y: number;
  /** 这一段排版用的宽度和排出来的高度 */
  width: number;
  height: number;
  /** 这一段在节点文字里的范围（字符串下标，不含换行） */
  start: number;
  end: number;
  /** 段首有首行缩进的占位符时是 1：排版引擎里的位置 = 文字里的位置 - start + shift。空的一段里还有一个零宽空格 */
  shift: number;
  style: ParagraphStyle;
  marker: TextMarker | null;
  /** 这一段的行（排版引擎给的，坐标和位置都是这一段自己的） */
  lines: LineMetrics[];
  /** 第一行在整个文本的行里排第几 */
  firstLine: number;
}

export interface TextLayout {
  /** 每一段一个，从上到下 */
  blocks: TextBlock[];
  /** 文本框的宽度：固定宽度时是设定值，自动宽度时是最宽一段（连同缩进）的宽度 */
  width: number;
  height: number;
  /** 所有段落的行，位置换算成整个文本的字符下标，坐标换算成本地坐标 */
  lines: LineMetrics[];
  /** 每一行的上沿和高度（本地坐标）。光标、上下移动都按它算 */
  lineTops: number[];
  lineHeights: number[];
  /** 还有字体没加载完，当前结果可能缺字；加载完会自动重排 */
  pending: boolean;
}

/** 把排好的文本画到画布上，原点是文本框的左上角 */
export function drawTextLayout(canvas: Canvas, layout: TextLayout): void {
  for (const block of layout.blocks) {
    canvas.drawParagraph(block.paragraph, block.x, block.y);
    if (block.marker) canvas.drawParagraph(block.marker.paragraph, block.marker.x, block.marker.y);
  }
}

function disposeLayout(layout: TextLayout): void {
  for (const block of layout.blocks) {
    block.paragraph.delete();
    block.marker?.paragraph.delete();
  }
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
  paragraphs: TextNode['paragraphs'];
  epoch: number;
}

const AUTO_LAYOUT_WIDTH = 1e6;

/**
 * 文本排版：把文本节点排成 Skia 段落并缓存，同时提供编辑需要的几何查询
 * （光标位置、点击位置对应的字符、选区矩形、上下行移动）。
 * 所有字符位置都是 JavaScript 字符串下标（UTF-16），坐标都是节点本地坐标。
 *
 * 每一段（用换行分开）单独排成一个 Skia 段落，按段前段后距从上往下摆：Skia 的段落样式（对齐）是整个段落共用的，
 * 也不支持缩进，所以每段各排各的。左缩进就是把这一段往右挪、排版宽度相应减小；首行缩进是在段首放一个
 * 这么宽的占位符；列表的符号单独排成一个小段落，放在缩进出来的那一档里。
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
      cached.spans === node.spans &&
      cached.paragraphs === node.paragraphs
    ) {
      return cached.layout;
    }
    if (cached) disposeLayout(cached.layout);
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
      paragraphs: node.paragraphs,
      epoch: this.fonts.epoch,
    });
    return layout;
  }

  /** 丢弃全部缓存。字体加载完成后调用 */
  clear(): void {
    for (const entry of this.entries.values()) disposeLayout(entry.layout);
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
    const block = blockAt(layout.blocks, offset);
    const local = offset - block.start + block.shift;
    const line = lineAt(block.lines, local);
    const index = line ? block.firstLine + line.lineNumber : -1;
    const top = layout.lineTops[index] ?? block.y;
    const height = layout.lineHeights[index] ?? block.height;
    const { ck } = this;
    /** 一段字符（整个文本的下标）左边或右边的横坐标，这一段自己的坐标 */
    const edge = (from: number, to: number, side: 'left' | 'right'): number | null => {
      const rects = block.paragraph.getRectsForRange(
        from - block.start + block.shift,
        to - block.start + block.shift,
        ck.RectHeightStyle.Max,
        ck.RectWidthStyle.Tight,
      );
      const rect = side === 'left' ? rects[0] : rects[rects.length - 1];
      return rect ? (side === 'left' ? rect.rect[0]! : rect.rect[2]!) : null;
    };

    let x: number | null = null;
    if (offset > block.start && line && local > line.startIndex)
      x = edge(prevBoundary(node.text, offset), offset, 'right');
    else if (offset < block.end) x = edge(offset, nextBoundary(node.text, offset), 'left');
    // 空的一段：有首行缩进时光标在占位符后面，否则按对齐方式
    if (x === null && block.shift > 0) x = block.paragraph.getRectsForPlaceholders()[0]?.rect[2] ?? null;
    x ??= line ? line.left : alignedStart(block.style.align, block.width);
    return { x: block.x + x, y: top, w: 0, h: height };
  }

  /** 本地坐标里的一个点最接近哪个字符位置 */
  offsetAt(node: TextNode, x: number, y: number): number {
    const layout = this.get(node);
    const { blocks } = layout;
    // 落在段与段之间的空隙里时，算离得近的那一段
    let block = blocks[blocks.length - 1]!;
    for (let i = 0; i < blocks.length; i++) {
      const current = blocks[i]!;
      const next = blocks[i + 1];
      const bottom = next ? (current.y + current.height + next.y) / 2 : Infinity;
      if (y < bottom) {
        block = current;
        break;
      }
    }
    if (block.lines.length === 0) return block.start;
    const localY = Math.min(Math.max(y - block.y, 0), Math.max(0, block.height - 0.01));
    const pos = block.paragraph.getGlyphPositionAtCoordinate(x - block.x, localY).pos;
    return Math.min(Math.max(block.start + pos - block.shift, block.start), block.end);
  }

  /** 一段字符范围覆盖的矩形，每行一个或多个 */
  selectionRects(node: TextNode, start: number, end: number): Rect[] {
    if (start === end) return [];
    const { ck } = this;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const rects: Rect[] = [];
    for (const block of this.get(node).blocks) {
      const a = Math.max(from, block.start);
      const b = Math.min(to, block.end);
      if (a >= b) continue;
      for (const { rect } of block.paragraph.getRectsForRange(
        a - block.start + block.shift,
        b - block.start + block.shift,
        ck.RectHeightStyle.Max,
        ck.RectWidthStyle.Tight,
      )) {
        rects.push({ x: block.x + rect[0]!, y: block.y + rect[1]!, w: rect[2]! - rect[0]!, h: rect[3]! - rect[1]! });
      }
    }
    return rects;
  }

  /** 光标上移或下移一行后的字符位置。x 是希望保持的横坐标 */
  verticalMove(node: TextNode, offset: number, direction: -1 | 1, x: number): number {
    const layout = this.get(node);
    const block = blockAt(layout.blocks, offset);
    const line = lineAt(block.lines, offset - block.start + block.shift);
    if (!line) return offset;
    const target = block.firstLine + line.lineNumber + direction;
    if (target < 0) return 0;
    if (target >= layout.lines.length) return node.text.length;
    const targetBlock = layout.blocks.find((b) => target >= b.firstLine && target < b.firstLine + b.lines.length)!;
    const middle = layout.lineTops[target]! + layout.lineHeights[target]! / 2;
    const pos = targetBlock.paragraph.getGlyphPositionAtCoordinate(x - targetBlock.x, middle - targetBlock.y).pos;
    return Math.min(Math.max(targetBlock.start + pos - targetBlock.shift, targetBlock.start), targetBlock.end);
  }

  /** 某个字符位置所在的词，双击选词用 */
  wordAt(node: TextNode, offset: number): { start: number; end: number } {
    const block = blockAt(this.get(node).blocks, offset);
    if (block.end === block.start) return { start: block.start, end: block.start };
    const local = Math.min(offset, block.end - 1) - block.start + block.shift;
    const range = block.paragraph.getWordBoundary(local);
    const map = (pos: number): number => Math.min(Math.max(block.start + pos - block.shift, block.start), block.end);
    return { start: map(range.start), end: map(range.end) };
  }

  private drop(id: NodeId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    disposeLayout(entry.layout);
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
    const strutStyle = {
      strutEnabled: true,
      fontFamilies: baseNames,
      fontSize: style.fontSize,
      heightMultiplier: style.lineHeight,
      halfLeading: true,
      forceStrutHeight: forced,
    };
    const ranges = paragraphRanges(node.text);
    const styles = paragraphStyles(node);
    const markers = listMarkers(styles);

    const drafts = ranges.map((range, i) => {
      const paragraphStyle = styles[i]!;
      const geometry = paragraphGeometry(paragraphStyle, style.fontSize);
      const builder = ck.ParagraphBuilder.MakeFromFontProvider(
        new ck.ParagraphStyle({
          textAlign: toSkAlign(ck, paragraphStyle.align),
          strutStyle,
          textStyle: this.skTextStyle(base, baseNames, style.lineHeight),
        }),
        fonts.provider,
      );
      let shift = 0;
      if (geometry.firstLine > 0) {
        // 首行缩进：段首放一个这么宽、不占高度的占位符
        builder.addPlaceholder(geometry.firstLine, 0, ck.PlaceholderAlignment.Baseline, ck.TextBaseline.Alphabetic, 0);
        shift = 1;
      }
      if (node.spans) {
        for (const run of runs) {
          const from = Math.max(run.start, range.start);
          const to = Math.min(run.end, range.end);
          if (from >= to) continue;
          const text = node.text.slice(from, to);
          builder.pushStyle(new ck.TextStyle(this.skTextStyle(run.style, resolve(run.style, text), style.lineHeight)));
          builder.addText(text);
          builder.pop();
        }
      } else if (range.end > range.start) {
        builder.addText(node.text.slice(range.start, range.end));
      }
      // 空的一段排版引擎不给行，也没有高度：放一个零宽空格，这一段就有一行的高度和光标位置。
      // 它在排版引擎里占一个位置，但换算回文字下标时都夹到这一段的范围（空）里
      if (range.end === range.start) builder.addText('\u200b');
      const paragraph = builder.build();
      builder.delete();
      return { paragraph, range, style: paragraphStyle, geometry, shift, markerText: markers[i] ?? null };
    });

    let width: number;
    if (node.sizing === 'fixed') {
      width = Math.max(1, node.size[0]);
    } else {
      // 先用极大的宽度排一次量出最宽的一段，再按这个宽度重排，这样居中和右对齐才有意义
      let widest = 0;
      for (const draft of drafts) {
        draft.paragraph.layout(AUTO_LAYOUT_WIDTH);
        widest = Math.max(widest, draft.geometry.left + draft.paragraph.getLongestLine());
      }
      width = Math.ceil(widest) + 1;
    }

    const blocks: TextBlock[] = [];
    const lines: LineMetrics[] = [];
    const lineTops: number[] = [];
    const lineHeights: number[] = [];
    let y = 0;
    drafts.forEach((draft, i) => {
      const blockWidth = Math.max(1, width - draft.geometry.left);
      draft.paragraph.layout(blockWidth);
      if (i > 0) y += drafts[i - 1]!.style.spaceAfter + draft.style.spaceBefore;
      const height = draft.paragraph.getHeight();
      const metrics = draft.paragraph.getLineMetrics();
      const block: TextBlock = {
        paragraph: draft.paragraph,
        x: draft.geometry.left,
        y,
        width: blockWidth,
        height,
        start: draft.range.start,
        end: draft.range.end,
        shift: draft.shift,
        style: draft.style,
        marker: null,
        lines: metrics,
        firstLine: lines.length,
      };
      // 行高被强制成一样时每行等分这一段的高度；否则按各行自己的高度（排版引擎给的是取整过的，按总高度缩放回去）
      const raw = metrics.map((line) => (forced ? 1 : Math.max(1, line.height)));
      const total = raw.reduce((sum, h) => sum + h, 0) || 1;
      let top = y;
      metrics.forEach((line, k) => {
        const h = (raw[k]! / total) * height;
        const map = (index: number): number =>
          Math.min(Math.max(block.start + index - block.shift, block.start), block.end);
        lines.push({
          ...line,
          lineNumber: lines.length,
          startIndex: map(line.startIndex),
          endIndex: map(line.endIndex),
          endExcludingWhitespaces: map(line.endExcludingWhitespaces),
          endIncludingNewline: map(line.endIncludingNewline),
          baseline: line.baseline + y,
          left: line.left + block.x,
        });
        lineTops.push(top);
        lineHeights.push(h);
        top += h;
      });
      if (draft.markerText && draft.geometry.markerRight !== null) {
        block.marker = this.marker(node, block, draft.markerText, draft.geometry.markerRight, base, resolve);
      }
      blocks.push(block);
      y += height;
    });
    return { blocks, width, height: y, lines, lineTops, lineHeights, pending };
  }

  /** 列表符号：用这一段第一个字的样式（不带下划线、删除线），右边缘对齐到 right，基线和第一行对齐 */
  private marker(
    node: TextNode,
    block: TextBlock,
    text: string,
    right: number,
    base: CharacterStyle,
    resolve: (style: CharacterStyle, text: string) => string[],
  ): TextMarker {
    const { ck, fonts } = this;
    const style: CharacterStyle = {
      ...(block.end > block.start ? styleOfChar(node, block.start) : base),
      underline: false,
      strikethrough: false,
    };
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(
      new ck.ParagraphStyle({ textStyle: this.skTextStyle(style, resolve(style, text), node.style.lineHeight) }),
      fonts.provider,
    );
    builder.addText(text);
    const paragraph = builder.build();
    builder.delete();
    paragraph.layout(AUTO_LAYOUT_WIDTH);
    const width = paragraph.getMaxIntrinsicWidth();
    const own = paragraph.getLineMetrics()[0]?.baseline ?? 0;
    const first = block.lines[0]?.baseline ?? own;
    return { paragraph, x: right - width, y: block.y + first - own, text, style };
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

/** 字符位置所在的那一段：范围包含它的（段末算这一段）；超出时是最后一段 */
function blockAt(blocks: readonly TextBlock[], offset: number): TextBlock {
  for (const block of blocks) if (offset <= block.end) return block;
  return blocks[blocks.length - 1]!;
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
