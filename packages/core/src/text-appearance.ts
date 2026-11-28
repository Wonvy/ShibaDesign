import type { TextNode } from './model';

/**
 * 文字的保真外观。
 *
 * 从 PDF 这类文件导入文字时，原文件用的字体我们通常没有，直接换成自己的字体重新排版，
 * 字形、字距、折行都会和原来不一样。所以导入时把每个字的轮廓和位置也存下来，
 * 文字没被改动之前就按这些轮廓画，看起来和原文件一模一样；
 * 一旦改了文字或排版参数（字体、字号、行高、对齐、宽度……），就改用正常排版。
 *
 * "有没有改过"不靠记录编辑动作来判断，而是比较一个指纹：生成外观时记下文字和排版参数的指纹，
 * 画的时候用节点当前的值再算一遍，对得上才用。这样无论从哪里改的（编辑文字、属性面板、拖动宽度），
 * 都不会画出过时的外观；撤销回去之后指纹又对上了，原样外观自动回来。改颜色、移动、旋转不影响指纹。
 */

/** 字形库的资源类型 */
export const GLYPH_LIBRARY_MIME = 'application/vnd.shibadesign.glyphs+json';

const FORMAT = 'shiba-glyphs';
const FORMAT_VERSION = 1;
/** 字形库里字形个数的上限：最大的中文字体也就三万来个字 */
const MAX_GLYPHS = 70_000;
/** 一份字形库里所有坐标值的总数上限 */
const MAX_VALUES = 20_000_000;

/**
 * 字形轮廓的路径数据：一个扁平的数字数组，每条命令是一个命令码加它的坐标，以字号为 1 个单位，y 向上。
 * 0 移动到 (x, y)；1 直线到 (x, y)；2 三次曲线 (c1x, c1y, c2x, c2y, x, y)；3 二次曲线 (cx, cy, x, y)；4 闭合。
 */
export const GLYPH_PATH_ARITY: readonly number[] = [2, 2, 6, 4, 0];

/** 32 位 FNV-1a 哈希，seed 不同得到两个互相独立的结果 */
function fnv(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 文字和排版参数的指纹。只包含会影响排版结果的字段 */
export function textAppearanceBasis(
  node: Pick<TextNode, 'text' | 'style' | 'align' | 'sizing' | 'size' | 'spans' | 'paragraphs'>,
): string {
  const { style } = node;
  // 斜体、下划线、删除线、字符级样式、段落样式是后来加的：没有用到时不进指纹，这样之前存下的指纹仍然对得上
  const extra =
    (style.italic || style.underline || style.strikethrough || node.spans?.length
      ? JSON.stringify([!!style.italic, !!style.underline, !!style.strikethrough, node.spans ?? []])
      : '') + (node.paragraphs?.length ? JSON.stringify(node.paragraphs) : '');
  const key =
    extra +
    JSON.stringify([
      node.text,
      style.fontFamily.latin,
      style.fontFamily.cjk,
      style.fontSize,
      style.fontWeight,
      style.lineHeight,
      style.letterSpacing,
      node.align,
      node.sizing,
      node.sizing === 'fixed' ? node.size[0] : 0,
    ]);
  return fnv(key, 0x811c9dc5) + fnv(key, 0x9747b28c);
}

const liveCache = new WeakMap<TextNode, boolean>();

/** 这个文本节点现在是否按保真外观显示 */
export function hasLiveAppearance(node: TextNode): boolean {
  if (!node.appearance) return false;
  let live = liveCache.get(node);
  if (live === undefined) {
    live = node.appearance.basis === textAppearanceBasis(node);
    liveCache.set(node, live);
  }
  return live;
}

/**
 * 解开的字形库。
 * 除了轮廓，还可以记下每个字形代表的文字和步进宽度：导出 PDF 时靠它们让原样显示的文字也能被搜索、复制。
 * 早期的字形库没有这两项，解开后是 null。
 */
export interface GlyphLibrary {
  glyphs: number[][];
  /** 每个字形代表的文字，可能是空串（比如单独画的重音符号） */
  text: string[] | null;
  /** 每个字形的步进宽度，以字号为 1 个单位 */
  advances: number[] | null;
}

/** 一个字形代表的文字最长多少个字符：连字最多也就几个字母 */
const MAX_GLYPH_TEXT = 32;

/** 把一组字形轮廓编码成字形库文件 */
export function encodeGlyphLibrary(
  glyphs: readonly ArrayLike<number>[],
  extra: { text?: readonly string[]; advances?: readonly number[] } = {},
): Uint8Array {
  const round = (v: number): number => Math.round(v * 10_000) / 10_000;
  const json = JSON.stringify({
    format: FORMAT,
    version: FORMAT_VERSION,
    glyphs: glyphs.map((g) => Array.from(g, round)),
    text: extra.text,
    advances: extra.advances?.map(round),
  });
  return new TextEncoder().encode(json);
}

/** 解开字形库文件。文件来自用户打开的文档，是不可信输入：格式不对时返回 null */
export function decodeGlyphLibrary(bytes: Uint8Array): GlyphLibrary | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { format, version, glyphs, text, advances } = raw as Record<string, unknown>;
  if (format !== FORMAT || typeof version !== 'number' || version > FORMAT_VERSION) return null;
  if (!Array.isArray(glyphs) || glyphs.length > MAX_GLYPHS) return null;
  let total = 0;
  for (const glyph of glyphs) {
    if (!Array.isArray(glyph)) return null;
    total += glyph.length;
    if (total > MAX_VALUES || !isGlyphPath(glyph)) return null;
  }
  // 文字和宽度只是附加信息，不对时丢掉它们，轮廓照样能用
  const sameLength = (list: unknown): list is unknown[] => Array.isArray(list) && list.length === glyphs.length;
  const validText =
    sameLength(text) && text.every((t) => typeof t === 'string' && t.length <= MAX_GLYPH_TEXT)
      ? (text as string[])
      : null;
  const validAdvances =
    sameLength(advances) && advances.every((a) => typeof a === 'number' && Number.isFinite(a))
      ? (advances as number[])
      : null;
  return { glyphs: glyphs as number[][], text: validText, advances: validAdvances };
}

/** 每个命令码都认识、后面跟的坐标个数正好、坐标都是有限的数 */
export function isGlyphPath(data: ArrayLike<unknown>): boolean {
  for (let i = 0; i < data.length;) {
    const arity = GLYPH_PATH_ARITY[data[i] as number];
    if (arity === undefined || i + arity >= data.length) return false;
    for (let k = 1; k <= arity; k++) {
      const value = data[i + k];
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    }
    i += 1 + arity;
  }
  return true;
}
