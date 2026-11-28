import { solid, type CharacterStyle, type Color, type NodePatch, type TextNode, type TextSpan } from './model';

/**
 * 字符级样式。
 *
 * 文本节点的 style 和 fill 是整段的默认样式；和默认样式不同的字按区间记在 spans 里，
 * 每个区间只记不同的那几项。这样大多数文本没有 spans，改整段的样式也不用碰每个区间。
 *
 * 所有函数都是纯函数，返回整理过的新区间：按位置排好、互不重叠、没有空区间、
 * 相邻且样式相同的合成一个、和默认样式相同的项去掉。没有区间时返回 undefined，节点上就不留这个字段。
 */

export const CHARACTER_STYLE_KEYS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'italic',
  'underline',
  'strikethrough',
  'letterSpacing',
  'color',
] as const satisfies readonly (keyof CharacterStyle)[];

type Key = (typeof CHARACTER_STYLE_KEYS)[number];
type Override = Partial<CharacterStyle>;
type Source = Pick<TextNode, 'text' | 'style' | 'fill' | 'spans'>;

/** 整段的默认样式 */
export function baseCharacterStyle(node: Pick<TextNode, 'style' | 'fill'>): CharacterStyle {
  const { style } = node;
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    italic: style.italic ?? false,
    underline: style.underline ?? false,
    strikethrough: style.strikethrough ?? false,
    letterSpacing: style.letterSpacing,
    color: node.fill?.color ?? null,
  };
}

function sameColor(a: Color | null, b: Color | null): boolean {
  if (!a || !b) return a === b;
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** 两个样式项的值是否相同 */
export function sameStyleValue<K extends Key>(key: K, a: CharacterStyle[K], b: CharacterStyle[K]): boolean {
  if (key === 'fontFamily') {
    const x = a as CharacterStyle['fontFamily'];
    const y = b as CharacterStyle['fontFamily'];
    return x.latin === y.latin && x.cjk === y.cjk;
  }
  if (key === 'color') return sameColor(a as Color | null, b as Color | null);
  return a === b;
}

/** 去掉和默认样式相同的项 */
function strip(override: Override | null, base: CharacterStyle): Override | null {
  if (!override) return null;
  let out: Override | null = null;
  for (const key of CHARACTER_STYLE_KEYS) {
    const value = override[key];
    if (value === undefined || sameStyleValue(key, value, base[key])) continue;
    (out ??= {})[key] = value as never;
  }
  return out;
}

/** 样式的比较键：同样的项、同样的值得到同样的字符串 */
function keyOf(override: Override | null): string {
  if (!override) return '';
  return JSON.stringify(CHARACTER_STYLE_KEYS.map((key) => override[key] ?? null));
}

/** 每个字（UTF-16 单元）的覆盖样式，没有覆盖的是 null */
function expand(node: Source): (Override | null)[] {
  const out = new Array<Override | null>(node.text.length).fill(null);
  for (const span of node.spans ?? []) {
    const end = Math.min(span.end, out.length);
    for (let i = Math.max(0, span.start); i < end; i++) out[i] = span.style;
  }
  return out;
}

/** 把每个字的覆盖样式收拢成区间 */
function compress(chars: readonly (Override | null)[], base: CharacterStyle): TextSpan[] | undefined {
  const spans: TextSpan[] = [];
  const cache = new Map<Override, { style: Override | null; key: string }>();
  let start = 0;
  let key = '';
  let style: Override | null = null;
  for (let i = 0; i <= chars.length; i++) {
    let entry: { style: Override | null; key: string } = { style: null, key: '' };
    const raw = i < chars.length ? chars[i]! : null;
    if (raw) {
      let cached = cache.get(raw);
      if (!cached) {
        const stripped = strip(raw, base);
        cached = { style: stripped, key: keyOf(stripped) };
        cache.set(raw, cached);
      }
      entry = cached;
    }
    if (i < chars.length && entry.key === key) continue;
    if (style && i > start) spans.push({ start, end: i, style });
    start = i;
    key = entry.key;
    style = entry.style;
  }
  return spans.length > 0 ? spans : undefined;
}

/**
 * 按每个字的样式生成区间。styles 的长度应当等于文字长度，元素是这个字和默认样式不同的项（可以多给，会去掉相同的）。
 * 同一个样式对象请复用，生成得更快
 */
export function spansFromStyles(
  node: Pick<TextNode, 'style' | 'fill'>,
  styles: readonly (Partial<CharacterStyle> | null)[],
): TextSpan[] | undefined {
  return compress(styles, baseCharacterStyle(node));
}

/** 整理区间：排好序、裁到文字范围内、去掉和默认样式相同的项、合并相邻的相同样式 */
export function normalizeSpans(node: Source): TextSpan[] | undefined {
  if (!node.spans || node.spans.length === 0) return undefined;
  return compress(expand(node), baseCharacterStyle(node));
}

function resolve(base: CharacterStyle, override: Override | null): CharacterStyle {
  return override ? { ...base, ...override } : base;
}

/** 文字按样式切成的连续几段，覆盖整段文字。没有字时是一段空的默认样式 */
export function styleRuns(node: Source): { start: number; end: number; style: CharacterStyle }[] {
  const base = baseCharacterStyle(node);
  const length = node.text.length;
  const runs: { start: number; end: number; style: CharacterStyle }[] = [];
  let at = 0;
  for (const span of node.spans ?? []) {
    const start = Math.max(at, Math.min(span.start, length));
    const end = Math.min(span.end, length);
    if (end <= start) continue;
    if (start > at) runs.push({ start: at, end: start, style: base });
    runs.push({ start, end, style: resolve(base, span.style) });
    at = end;
  }
  if (at < length || runs.length === 0) runs.push({ start: at, end: length, style: base });
  return runs;
}

/** 第 index 个字的样式 */
export function styleOfChar(node: Source, index: number): CharacterStyle {
  const base = baseCharacterStyle(node);
  const span = node.spans?.find((s) => s.start <= index && index < s.end);
  return resolve(base, span?.style ?? null);
}

/**
 * 光标在 index 处时新打的字用什么样式：接着前一个字；在开头时用第一个字的。
 * 这和常见的文字处理软件一致：在粗体词的末尾接着打字还是粗体。
 */
export function styleAtCaret(node: Source, index: number): CharacterStyle {
  if (node.text.length === 0) return baseCharacterStyle(node);
  return styleOfChar(node, Math.max(0, Math.min(index - 1, node.text.length - 1)));
}

/**
 * 一段范围的样式：每一项取范围里第一个字的值，范围里不一致的项记在 mixed 里。
 * 范围为空时就是光标处的样式。
 */
export function rangeStyle(node: Source, start: number, end: number): { style: CharacterStyle; mixed: Set<Key> } {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(node.text.length, Math.max(start, end));
  const mixed = new Set<Key>();
  if (to <= from) return { style: styleAtCaret(node, from), mixed };
  const runs = styleRuns(node).filter((run) => run.end > from && run.start < to);
  const style = runs[0]!.style;
  for (const run of runs.slice(1)) {
    for (const key of CHARACTER_STYLE_KEYS) {
      if (!sameStyleValue(key, run.style[key], style[key])) mixed.add(key);
    }
  }
  return { style, mixed };
}

/**
 * 给 [start, end) 这段字设置样式，返回节点要改的字段。
 * 范围覆盖了全部文字时改整段的默认样式，并从各个区间里去掉这几项——
 * 这样"整段改成红色"之后，原来单独设了颜色的字也跟着变红。
 */
export function setCharacterStyle(node: Source, start: number, end: number, patch: Override): NodePatch {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(node.text.length, Math.max(start, end));
  if (from <= 0 && to >= node.text.length) return setBaseStyle(node, patch);
  if (to <= from) return {};
  const chars = expand(node);
  const memo = new Map<Override | null, Override>();
  for (let i = from; i < to; i++) {
    const current = chars[i] ?? null;
    let next = memo.get(current);
    if (!next) {
      next = { ...(current ?? {}), ...patch };
      memo.set(current, next);
    }
    chars[i] = next;
  }
  return { spans: compress(chars, baseCharacterStyle(node)) };
}

/** 改整段的默认样式，各个区间里的这几项一并去掉 */
export function setBaseStyle(node: Source, patch: Override): NodePatch {
  const style = { ...node.style };
  let fill = node.fill;
  for (const key of CHARACTER_STYLE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key === 'color') fill = value ? solid(value as Color) : null;
    else if (key === 'italic' || key === 'underline' || key === 'strikethrough') {
      if (value) style[key] = true;
      else delete style[key];
    } else (style as Record<string, unknown>)[key] = value;
  }
  const keys = CHARACTER_STYLE_KEYS.filter((key) => patch[key] !== undefined);
  const spans = node.spans?.map((span) => {
    const rest = { ...span.style };
    for (const key of keys) delete rest[key];
    return { ...span, style: rest };
  });
  const next = { ...node, style, fill, spans };
  return { style, fill, spans: normalizeSpans(next) };
}

/**
 * 文字改动之后的区间。前后两段文字相同的开头和结尾不动，中间被替换的部分：
 * 新打的字用 inserted 指定的样式；没有指定时接着前一个字（在开头时接着后一个字）。
 * @param inserted 新打的字要用的完整样式，比如光标处刚换了粗体还没打字时
 */
export function spansAfterEdit(node: Source, text: string, inserted?: CharacterStyle): TextSpan[] | undefined {
  if (!node.spans && !inserted) return undefined;
  const old = node.text;
  let prefix = 0;
  const limit = Math.min(old.length, text.length);
  while (prefix < limit && old.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    old.charCodeAt(old.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)
  ) {
    suffix++;
  }
  const chars = expand(node);
  const removedEnd = old.length - suffix;
  const added = text.length - suffix - prefix;
  const base = baseCharacterStyle(node);
  const inherit: Override | null = inserted ? inserted : prefix > 0 ? chars[prefix - 1]! : (chars[removedEnd] ?? null);
  const next = [
    ...chars.slice(0, prefix),
    ...new Array<Override | null>(added).fill(inherit),
    ...chars.slice(removedEnd),
  ];
  return compress(next, base);
}
