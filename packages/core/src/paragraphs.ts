import type { NodePatch, TextAlign, TextNode } from './model';

/**
 * 段落样式。文本里用换行分开的每一段可以有自己的对齐、段前段后距、缩进，也可以是列表的一项。
 *
 * 数据：文本节点的 paragraphs 是一个按段落序号排的数组，每一项只记和默认值不同的那几项，
 * 没有不同的写成 null；末尾的 null 去掉，全都没有时整个字段省略。默认对齐是节点的 align，其余默认为 0 / 不是列表。
 * 打字时数组跟着走：按回车分出来的新段落接着原来那段的样式，删掉换行合并的两段用前一段的样式。
 */

export const LIST_KINDS = ['bullet', 'number'] as const;
/** bullet：项目符号；number：编号 */
export type ListKind = (typeof LIST_KINDS)[number];

/** 列表最多几级（0 到 MAX_LIST_LEVEL） */
export const MAX_LIST_LEVEL = 8;

export interface ParagraphStyle {
  align: TextAlign;
  /** 段前距、段后距，文档单位。只用在段与段之间，文本框的最上面和最下面不留 */
  spaceBefore: number;
  spaceAfter: number;
  /** 整段的左缩进 */
  indent: number;
  /** 首行再缩进多少（在左缩进之外），≥ 0。列表项不用它 */
  firstLine: number;
  /** 列表：项目符号或编号；null 不是列表 */
  list: ListKind | null;
  /** 列表的层级，0 是最外层；每一级多缩进一档，符号和编号的样式也跟着换 */
  level: number;
}

export type ParagraphOverride = Partial<ParagraphStyle>;
type Key = keyof ParagraphStyle;
type Source = Pick<TextNode, 'text' | 'align' | 'paragraphs'>;

export const PARAGRAPH_KEYS: readonly Key[] = [
  'align',
  'spaceBefore',
  'spaceAfter',
  'indent',
  'firstLine',
  'list',
  'level',
];

/** 列表每一级缩进多少，以整段字号为单位。符号或编号放在这一档里，右边留半个字的空 */
export const LIST_STEP_EM = 1.8;
export const LIST_GAP_EM = 0.5;

export function defaultParagraphStyle(node: Pick<TextNode, 'align'>): ParagraphStyle {
  return { align: node.align, spaceBefore: 0, spaceAfter: 0, indent: 0, firstLine: 0, list: null, level: 0 };
}

/** 每一段的范围（字符串下标，不含换行）。空文本也有一段 */
export function paragraphRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (end < 0) {
      ranges.push({ start, end: text.length });
      return ranges;
    }
    ranges.push({ start, end });
    start = end + 1;
  }
}

/** 某个字符位置在第几段（前面有几个换行） */
export function paragraphIndexAt(text: string, offset: number): number {
  let count = 0;
  const limit = Math.min(Math.max(0, offset), text.length);
  for (let i = 0; i < limit; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

/** 每一段的完整样式 */
export function paragraphStyles(node: Source): ParagraphStyle[] {
  const base = defaultParagraphStyle(node);
  const count = paragraphRanges(node.text).length;
  const out: ParagraphStyle[] = [];
  for (let i = 0; i < count; i++) out.push({ ...base, ...(node.paragraphs?.[i] ?? {}) });
  return out;
}

/** 选区碰到的段落（选区为空时是光标所在的那一段）：第一段和最后一段的序号 */
export function paragraphSpan(text: string, start: number, end: number): [number, number] {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return [paragraphIndexAt(text, from), paragraphIndexAt(text, to)];
}

/** 选区碰到的那些段落的样式；不一致的项记在 mixed 里，style 里是第一段的值 */
export function rangeParagraphStyle(
  node: Source,
  start: number,
  end: number,
): { style: ParagraphStyle; mixed: Set<Key> } {
  const styles = paragraphStyles(node);
  const [first, last] = paragraphSpan(node.text, start, end);
  const style = styles[first] ?? defaultParagraphStyle(node);
  const mixed = new Set<Key>();
  for (let i = first + 1; i <= last; i++) {
    for (const key of PARAGRAPH_KEYS) if (styles[i]![key] !== style[key]) mixed.add(key);
  }
  return { style, mixed };
}

/**
 * 给选区碰到的段落设样式。碰到了全部段落时，对齐改的是整段的默认值（节点的 align），并去掉各段自己的对齐
 */
export function setParagraphStyle(node: Source, start: number, end: number, patch: ParagraphOverride): NodePatch {
  const count = paragraphRanges(node.text).length;
  const [first, last] = paragraphSpan(node.text, start, end);
  const all = first === 0 && last === count - 1;
  const align = all && patch.align !== undefined ? patch.align : node.align;
  const list: (ParagraphOverride | null)[] = [];
  for (let i = 0; i < count; i++) {
    const own: ParagraphOverride = { ...(node.paragraphs?.[i] ?? {}) };
    if (i >= first && i <= last) {
      Object.assign(own, patch);
      if (all && patch.align !== undefined) delete own.align;
    }
    list.push(own);
  }
  return { align, paragraphs: normalizeParagraphs(list, count, align) };
}

/**
 * 文字改动之后的段落样式：前后不变的段落不动，被替换的那一段（以及新分出来的段落）用改动开始处那一段的样式。
 * @param caret 改动之后光标的位置（改动在它前面结束）。在段末按回车和在下一段开头按回车得到的文字一样，
 *   靠它才分得清新分出的段落该接着哪一段的样式
 */
export function paragraphsAfterEdit(
  node: Source,
  text: string,
  caret?: number,
): (ParagraphOverride | null)[] | undefined {
  if (!node.paragraphs) return undefined;
  const old = node.text;
  // 先定不变的结尾（不越过光标），再定不变的开头
  let suffix = 0;
  const maxSuffix = Math.min(old.length, text.length, caret === undefined ? Infinity : text.length - caret);
  while (suffix < maxSuffix && old.charCodeAt(old.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)) {
    suffix++;
  }
  let prefix = 0;
  const maxPrefix = Math.min(old.length, text.length) - suffix;
  while (prefix < maxPrefix && old.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
  const first = paragraphIndexAt(old, prefix);
  const last = paragraphIndexAt(old, old.length - suffix);
  const added = paragraphIndexAt(text.slice(prefix, text.length - suffix), Infinity);
  const entry = (i: number): ParagraphOverride | null => node.paragraphs?.[i] ?? null;
  const oldCount = paragraphRanges(old).length;
  const list: (ParagraphOverride | null)[] = [];
  for (let i = 0; i < first; i++) list.push(entry(i));
  for (let i = 0; i <= added; i++) list.push(entry(first));
  for (let i = last + 1; i < oldCount; i++) list.push(entry(i));
  return normalizeParagraphs(list, paragraphRanges(text).length, node.align);
}

/**
 * 整理成规范的样子：每项只留和默认值不同的值，没有的写成 null；末尾的 null 去掉；全空时返回 undefined。
 * 数值夹到合理范围，列表的层级取整
 */
export function normalizeParagraphs(
  list: readonly (ParagraphOverride | null | undefined)[],
  count: number,
  align: TextAlign,
): (ParagraphOverride | null)[] | undefined {
  const base = defaultParagraphStyle({ align });
  const out: (ParagraphOverride | null)[] = [];
  for (let i = 0; i < count; i++) {
    const source = list[i];
    if (!source) {
      out.push(null);
      continue;
    }
    const clean: ParagraphOverride = {};
    for (const key of PARAGRAPH_KEYS) {
      const value = source[key];
      if (value === undefined) continue;
      const fixed =
        key === 'level' ? clampLevel(value as number) : typeof value === 'number' ? clampLength(value) : value;
      if (fixed !== base[key]) (clean as Record<string, unknown>)[key] = fixed;
    }
    out.push(Object.keys(clean).length > 0 ? clean : null);
  }
  while (out.length > 0 && out[out.length - 1] === null) out.pop();
  return out.length > 0 ? out : undefined;
}

function clampLength(value: number): number {
  return Number.isFinite(value) ? Math.min(10_000, Math.max(0, value)) : 0;
}

function clampLevel(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_LIST_LEVEL, Math.max(0, Math.round(value))) : 0;
}

// ───────────── 列表 ─────────────

const BULLETS = ['•', '◦', '▪'];

/**
 * 每一段的列表符号（不是列表的段落是 null）。编号：同一级连续的编号项依次加一，
 * 碰到不是列表的段落从头数；更外一级的项之后，里面一级重新数；同一级夹了项目符号也重新数。
 * 编号的样式按层级轮换：1. → a. → i.
 */
export function listMarkers(styles: readonly ParagraphStyle[]): (string | null)[] {
  const counters: number[] = [];
  return styles.map((style) => {
    if (!style.list) {
      counters.length = 0;
      return null;
    }
    const level = style.level;
    counters.length = Math.min(counters.length, level + 1);
    if (style.list === 'bullet') {
      counters[level] = 0;
      return BULLETS[level % BULLETS.length]!;
    }
    const n = (counters[level] ?? 0) + 1;
    counters[level] = n;
    for (let i = 0; i < level; i++) counters[i] ??= 0;
    return `${formatNumber(n, level % 3)}.`;
  });
}

function formatNumber(n: number, style: number): string {
  if (style === 1) return alphabetic(n);
  if (style === 2) return roman(n);
  return String(n);
}

function alphabetic(n: number): string {
  let out = '';
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) out = String.fromCharCode(97 + ((v - 1) % 26)) + out;
  return out;
}

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  let rest = n;
  for (const [value, letters] of table) {
    while (rest >= value) {
      out += letters;
      rest -= value;
    }
  }
  return out;
}

/**
 * 一段的水平几何：文字从哪里开始（left），首行再缩进多少（firstLine），列表符号的右边缘在哪（markerRight）。
 * 列表项的文字缩进 (层级 + 1) 档，符号放在最后一档里、右边留半个字的空，所以不同位数的编号按小数点对齐
 * @param em 整段的字号
 */
export function paragraphGeometry(
  style: ParagraphStyle,
  em: number,
): { left: number; firstLine: number; markerRight: number | null } {
  if (!style.list) return { left: style.indent, firstLine: style.firstLine, markerRight: null };
  const left = style.indent + (style.level + 1) * LIST_STEP_EM * em;
  return { left, firstLine: 0, markerRight: left - LIST_GAP_EM * em };
}
