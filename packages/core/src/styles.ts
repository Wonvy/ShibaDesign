import {
  createId,
  type Color,
  type NodePatch,
  type PageNode,
  type SceneNode,
  type TextNode,
  type TextStyle,
} from './model';
import type { DocStore, Patch, Transaction } from './store';
import { normalizeSpans, setBaseStyle } from './text-spans';

/**
 * 颜色样式和文字样式：起了名字、可以反复用的颜色和文字格式。
 *
 * 样式记在文档根页面上（`PageNode.colorStyles`、`textStyles`）。对象链接样式时只记样式的 id
 * （`SolidFill.colorStyle`、`Stroke.colorStyle`、`TextNode.textStyle`），同时照常存着样式当前的值，
 * 所以渲染、导出、打开 PDF 这些地方完全不用认识样式。
 *
 * 一致性由整理器 `syncStyles` 维护（每次事务结束前执行，见 store.ts）：
 * - 改了样式：所有链接它的对象跟着改成新的值；删了样式：链接断开，值留着。
 * - 对象上链接着样式、值却和样式对不上，说明用户手动改过：断开链接。所以界面改颜色时不用专门去掉链接。
 */

export interface ColorStyleDef {
  id: string;
  name: string;
  color: Color;
}

export interface TextStyleDef {
  id: string;
  name: string;
  /** 字体、字号、字重、行高、字距、斜体、下划线、删除线。颜色不在里面，和常见的设计软件一样 */
  style: TextStyle;
}

/** 每种样式最多几个 */
export const MAX_STYLES = 1000;
/** 样式名最长几个字 */
export const MAX_STYLE_NAME = 200;

function rootPage(store: DocStore): PageNode | null {
  const root = store.root;
  return root.type === 'page' ? root : null;
}

export function colorStyles(store: DocStore): readonly ColorStyleDef[] {
  return rootPage(store)?.colorStyles ?? [];
}

export function textStyles(store: DocStore): readonly TextStyleDef[] {
  return rootPage(store)?.textStyles ?? [];
}

export function findColorStyle(store: DocStore, id: string | undefined): ColorStyleDef | null {
  return id === undefined ? null : (colorStyles(store).find((s) => s.id === id) ?? null);
}

export function findTextStyle(store: DocStore, id: string | undefined): TextStyleDef | null {
  return id === undefined ? null : (textStyles(store).find((s) => s.id === id) ?? null);
}

export function newStyleId(): string {
  return createId();
}

export function sameColor(a: Color, b: Color): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** 两份文字样式是否相同。斜体、下划线、删除线省略等于 false */
export function sameTextStyle(a: TextStyle, b: TextStyle): boolean {
  return (
    a.fontFamily.latin === b.fontFamily.latin &&
    a.fontFamily.cjk === b.fontFamily.cjk &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.lineHeight === b.lineHeight &&
    a.letterSpacing === b.letterSpacing &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strikethrough === !!b.strikethrough
  );
}

/** 整理成标准写法：斜体、下划线、删除线只在为 true 时出现 */
export function cleanTextStyle(style: TextStyle): TextStyle {
  const out: TextStyle = {
    fontFamily: { latin: style.fontFamily.latin, cjk: style.fontFamily.cjk },
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
  };
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.strikethrough) out.strikethrough = true;
  return out;
}

/**
 * 给整个文本套用文字样式：整段的默认样式换成样式里的值，单独设过这几项的字也一起换掉
 * （和设计软件里给整个文本套样式一样），颜色不动。
 */
export function applyTextStyle(node: TextNode, def: TextStyleDef): NodePatch {
  const { style } = def;
  const patch = setBaseStyle(node, {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    italic: !!style.italic,
    underline: !!style.underline,
    strikethrough: !!style.strikethrough,
  });
  return { ...patch, style: cleanTextStyle(style), textStyle: def.id };
}

/**
 * 样式改了之后更新链接它的文本：只换整段的默认样式，单独设过样式的字（比如加粗的一个词）保留，
 * 和新的默认样式一样的项从区间里去掉
 */
function restyleText(node: TextNode, style: TextStyle): NodePatch {
  const next = cleanTextStyle(style);
  return { style: next, spans: normalizeSpans({ ...node, style: next }) };
}

/** 填充、描边链接的颜色样式 */
function fillStyleOf(node: SceneNode): string | undefined {
  if (!('fill' in node) || !node.fill || node.fill.type !== 'solid') return undefined;
  return node.fill.colorStyle;
}

function strokeStyleOf(node: SceneNode): string | undefined {
  return 'stroke' in node && node.stroke ? node.stroke.colorStyle : undefined;
}

/** 有没有链接任何样式 */
export function hasStyleLinks(node: SceneNode): boolean {
  return (
    fillStyleOf(node) !== undefined ||
    strokeStyleOf(node) !== undefined ||
    (node.type === 'text' && node.textStyle !== undefined)
  );
}

type Lookup<T> = (id: string) => T | null | undefined;

/**
 * 按样式的当前值改一个节点：链接的样式改了值的跟着改；样式没了的（或者节点上的值被用户改过的）断开链接。
 * @param colors 颜色样式的查询：返回 null 表示这个样式不存在，undefined 表示不用管
 * @param keepEdited true 时值对不上样式就断开链接（用户改过）；false 时一律改成样式的值
 */
function relink(
  node: SceneNode,
  colors: Lookup<Color>,
  texts: Lookup<TextStyle>,
  keepEdited: boolean,
): NodePatch | null {
  const patch: Record<string, unknown> = {};
  const fillStyle = fillStyleOf(node);
  if (fillStyle !== undefined && 'fill' in node && node.fill?.type === 'solid') {
    const color = colors(fillStyle);
    if (color === null || (keepEdited && color && !sameColor(color, node.fill.color))) {
      const { colorStyle: _drop, ...rest } = node.fill;
      patch.fill = rest;
    } else if (color && !sameColor(color, node.fill.color)) {
      patch.fill = { ...node.fill, color };
    }
  }
  const strokeStyle = strokeStyleOf(node);
  if (strokeStyle !== undefined && 'stroke' in node && node.stroke) {
    const color = colors(strokeStyle);
    if (color === null || (keepEdited && color && !sameColor(color, node.stroke.color))) {
      const { colorStyle: _drop, ...rest } = node.stroke;
      patch.stroke = rest;
    } else if (color && !sameColor(color, node.stroke.color)) {
      patch.stroke = { ...node.stroke, color };
    }
  }
  if (node.type === 'text' && node.textStyle !== undefined) {
    const style = texts(node.textStyle);
    if (style === null || (keepEdited && style && !sameTextStyle(style, node.style))) {
      patch.textStyle = undefined;
    } else if (style && !sameTextStyle(style, node.style)) {
      Object.assign(patch, restyleText(node, style));
    }
  }
  return Object.keys(patch).length > 0 ? (patch as NodePatch) : null;
}

/** 把 patch 写进节点；值为 undefined 的字段直接去掉，不留一个空键 */
function write(tx: Transaction, node: SceneNode, patch: NodePatch): void {
  const next = { ...node, ...patch } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
  tx.replace(next as unknown as SceneNode);
}

/** 两份样式列表之间，哪些样式的值变了（null 表示删掉了） */
function changedStyles<T extends { id: string }>(
  before: readonly T[] | undefined,
  after: readonly T[] | undefined,
  same: (a: T, b: T) => boolean,
): Map<string, T | null> {
  const out = new Map<string, T | null>();
  if (before === after) return out;
  const next = new Map((after ?? []).map((s) => [s.id, s]));
  for (const old of before ?? []) {
    const now = next.get(old.id);
    if (!now) out.set(old.id, null);
    else if (!same(old, now)) out.set(old.id, now);
  }
  return out;
}

/** 整理器：见文件开头的说明 */
export function syncStyles(tx: Transaction, store: DocStore, userPatches: readonly Patch[]): void {
  const rootId = store.root.id;
  const rootPatch = tx.patches.get(rootId);
  const before = rootPatch?.before?.type === 'page' ? rootPatch.before : null;
  const after = rootPatch?.after?.type === 'page' ? rootPatch.after : null;

  // 改了、删了样式：所有链接它的对象跟着改
  if (before && after) {
    const colorChanges = changedStyles(before.colorStyles, after.colorStyles, (a, b) => sameColor(a.color, b.color));
    const textChanges = changedStyles(before.textStyles, after.textStyles, (a, b) => sameTextStyle(a.style, b.style));
    if (colorChanges.size > 0 || textChanges.size > 0) {
      const colors: Lookup<Color> = (id) => {
        const change = colorChanges.get(id);
        return change === undefined ? undefined : (change?.color ?? null);
      };
      const texts: Lookup<TextStyle> = (id) => {
        const change = textChanges.get(id);
        return change === undefined ? undefined : (change?.style ?? null);
      };
      for (const node of [...store.all()]) {
        if (!hasStyleLinks(node)) continue;
        const patch = relink(node, colors, texts, false);
        if (patch) write(tx, node, patch);
      }
    }
  }

  // 用户改过的节点：值和链接的样式对不上（手动改了颜色、字号），或者样式不存在，断开链接
  let colorMap: Map<string, Color> | null = null;
  let textMap: Map<string, TextStyle> | null = null;
  for (const patch of userPatches) {
    if (!patch.after) continue;
    const node = tx.get(patch.id);
    if (!node || !hasStyleLinks(node)) continue;
    const page = tx.get(rootId);
    colorMap ??= new Map(((page?.type === 'page' && page.colorStyles) || []).map((s) => [s.id, s.color]));
    textMap ??= new Map(((page?.type === 'page' && page.textStyles) || []).map((s) => [s.id, s.style]));
    const colors = colorMap;
    const texts = textMap;
    const fix = relink(
      node,
      (id) => colors.get(id) ?? null,
      (id) => texts.get(id) ?? null,
      true,
    );
    if (fix) write(tx, node, fix);
  }
}
