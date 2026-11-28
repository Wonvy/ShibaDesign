import { translation } from './matrix';
import {
  createNode,
  rgba,
  type Color,
  type NodeId,
  type NodeType,
  type SceneNode,
  type SolidFill,
  type TextAlign,
  type TextNode,
  type TextStyle,
} from './model';
import type { ParagraphOverride } from './paragraphs';
import { keysBetween } from './store';
import {
  cleanTextStyle,
  colorStyleFor,
  textStyleFor,
  type ColorRole,
  type ColorStyleDef,
  type TextRole,
  type TextStyleDef,
} from './styles';

/**
 * 幻灯片版式：新建幻灯片时选的标题页、标题和正文、两栏、图文……每个版式是一个函数，
 * 按幻灯片大小摆好文本框和图片占位框。
 *
 * 版式按用途取文档里的样式（见 styles.ts 的 COLOR_ROLES、TEXT_ROLES）：模板定好了"标题""正文""文字颜色"，
 * 新建的幻灯片就用模板的字体和配色，并且链接到这些样式，改样式时一起变。文档里没有这些样式时用默认值，
 * 文字颜色按背景的深浅选深色或浅色。
 *
 * 占位的文字由界面层按当前语言给（内核不产生给人看的文字）。
 * 新增版式：写一个 SlideLayout，调用 registerLayout；再到两个语言包的 layout 下加上它的名字。
 */

/** 版式里要填文字的地方 */
export const LAYOUT_SLOTS = ['title', 'subtitle', 'body', 'body2', 'caption', 'quote', 'number', 'image'] as const;
export type LayoutSlot = (typeof LAYOUT_SLOTS)[number];
/** 各处的占位文字；image 是图片占位框的名字。正文里每行一个要点 */
export type LayoutTexts = Partial<Record<LayoutSlot, string>>;

export interface LayoutContext {
  /** 新幻灯片（画板）的 id 和大小 */
  parent: NodeId;
  size: readonly [number, number];
  texts: LayoutTexts;
  /** 没有文字样式时用的字体 */
  fonts: { latin: string; cjk: string };
  colorStyles: readonly ColorStyleDef[];
  textStyles: readonly TextStyleDef[];
  /** 幻灯片的背景色：没有"文字"颜色样式时，按它的深浅决定文字用深色还是浅色 */
  background: Color;
}

export interface SlideLayout {
  id: string;
  /** 生成这一页上的对象，从下到上。index 和 seq 由 buildLayout 补上 */
  build(ctx: LayoutContext): SceneNode[];
}

const registry = new Map<string, SlideLayout>();

export function registerLayout(layout: SlideLayout): void {
  registry.set(layout.id, layout);
}

/** 所有版式，按注册的顺序 */
export function slideLayouts(): SlideLayout[] {
  return [...registry.values()];
}

export function slideLayout(id: string): SlideLayout | undefined {
  return registry.get(id);
}

/**
 * 按版式生成一页上的对象：补上层序和序号，返回要创建的节点（从下到上）。版式不存在时返回空列表
 * @param nextSeq 某类节点的下一个序号，通常是 tree.ts 的 nextSeq
 */
export function buildLayout(id: string, ctx: LayoutContext, nextSeq: (type: NodeType) => number): SceneNode[] {
  const layout = registry.get(id);
  if (!layout) return [];
  const nodes = layout.build(ctx);
  const indices = keysBetween(null, null, nodes.length);
  const counters = new Map<string, number>();
  return nodes.map((node, i) => {
    const seq = counters.get(node.type) ?? nextSeq(node.type as NodeType);
    counters.set(node.type, seq + 1);
    return { ...node, index: indices[i]!, seq };
  });
}

// ───────────── 默认的字和颜色 ─────────────

/** 默认值按 720 高的幻灯片定，别的大小按高度换算 */
const BASE_HEIGHT = 720;

const DEFAULT_TEXT: Record<TextRole, { size: number; weight: number; lineHeight: number }> = {
  title: { size: 52, weight: 700, lineHeight: 1.25 },
  subtitle: { size: 26, weight: 400, lineHeight: 1.4 },
  body: { size: 24, weight: 400, lineHeight: 1.5 },
  caption: { size: 16, weight: 400, lineHeight: 1.4 },
};

const DARK_TEXT = rgba(0.106, 0.118, 0.137);
const DEFAULT_ACCENT = rgba(0.145, 0.388, 0.922);

function luminance(c: Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function isDark(ctx: LayoutContext): boolean {
  return luminance(ctx.background) < 0.5;
}

/** 某个用途的颜色：有这个用途的颜色样式时链接它，否则按背景选 */
function colorFill(ctx: LayoutContext, role: ColorRole): SolidFill {
  const style = colorStyleFor(ctx.colorStyles, role);
  if (style) return { type: 'solid', color: style.color, colorStyle: style.id };
  const text = isDark(ctx) ? rgba(1, 1, 1) : DARK_TEXT;
  if (role === 'accent') return { type: 'solid', color: DEFAULT_ACCENT };
  if (role === 'muted') return { type: 'solid', color: { ...text, a: 0.6 } };
  if (role === 'background') return { type: 'solid', color: ctx.background };
  return { type: 'solid', color: text };
}

function textStyleOf(ctx: LayoutContext, role: TextRole): { style: TextStyle; link?: string } {
  const def = textStyleFor(ctx.textStyles, role);
  if (def) return { style: cleanTextStyle(def.style), link: def.id };
  const base = DEFAULT_TEXT[role];
  const unit = ctx.size[1] / BASE_HEIGHT;
  return {
    style: {
      fontFamily: { ...ctx.fonts },
      fontSize: Math.round(base.size * unit),
      fontWeight: base.weight,
      lineHeight: base.lineHeight,
      letterSpacing: 0,
    },
  };
}

/** 一行字大概多高，用来往下排下一个文本框 */
function lineHeightOf(ctx: LayoutContext, role: TextRole): number {
  const { style } = textStyleOf(ctx, role);
  return style.fontSize * style.lineHeight;
}

interface TextOptions {
  role: TextRole;
  slot: LayoutSlot;
  x: number;
  y: number;
  w: number;
  align?: TextAlign;
  color?: ColorRole;
  /** 每行一个项目符号 */
  list?: boolean;
}

function textBox(ctx: LayoutContext, options: TextOptions): TextNode {
  const text = ctx.texts[options.slot] ?? '';
  const { style, link } = textStyleOf(ctx, options.role);
  const paragraphs: ParagraphOverride[] | undefined = options.list
    ? text.split('\n').map(() => ({ list: 'bullet' as const }))
    : undefined;
  return createNode('text', {
    parent: ctx.parent,
    index: '',
    seq: 0,
    transform: translation(options.x, options.y),
    size: [Math.max(1, options.w), 0],
    text,
    style,
    align: options.align ?? 'left',
    sizing: 'fixed',
    fill: colorFill(ctx, options.color ?? 'text'),
    ...(paragraphs && { paragraphs }),
    ...(link && { textStyle: link }),
  });
}

/**
 * 图片占位框：一个灰色的矩形，选中后在外观面板里换成图片填充。
 * 颜色比编辑器画布的底色深一档，铺到幻灯片边上时也看得出幻灯片的边界
 */
function imageBox(ctx: LayoutContext, x: number, y: number, w: number, h: number): SceneNode {
  return createNode('rect', {
    parent: ctx.parent,
    index: '',
    seq: 0,
    name: ctx.texts.image,
    transform: translation(x, y),
    size: [w, h],
    fill: { type: 'solid', color: isDark(ctx) ? rgba(1, 1, 1, 0.14) : rgba(0.8, 0.82, 0.86) },
    stroke: null,
    cornerRadius: 0,
  });
}

/** 强调色的短横条 */
function accentBar(ctx: LayoutContext, x: number, y: number): SceneNode {
  const unit = ctx.size[1] / BASE_HEIGHT;
  return createNode('rect', {
    parent: ctx.parent,
    index: '',
    seq: 0,
    transform: translation(x, y),
    size: [Math.round(56 * unit), Math.max(2, Math.round(6 * unit))],
    fill: colorFill(ctx, 'accent'),
    stroke: null,
    cornerRadius: Math.max(1, Math.round(3 * unit)),
  });
}

/** 页边距 */
function margins(ctx: LayoutContext): { x: number; top: number; w: number; h: number } {
  const [w, h] = ctx.size;
  return { x: Math.round(w * 0.075), top: Math.round(h * 0.12), w, h };
}

// ───────────── 内置版式 ─────────────

const BUILTIN: SlideLayout[] = [
  { id: 'blank', build: () => [] },
  {
    id: 'title',
    build(ctx) {
      const m = margins(ctx);
      const y = Math.round(m.h * 0.34);
      return [
        textBox(ctx, { role: 'title', slot: 'title', x: m.x, y, w: m.w - m.x * 2, align: 'center' }),
        textBox(ctx, {
          role: 'subtitle',
          slot: 'subtitle',
          x: m.x,
          y: Math.round(y + lineHeightOf(ctx, 'title') + m.h * 0.04),
          w: m.w - m.x * 2,
          align: 'center',
          color: 'muted',
        }),
      ];
    },
  },
  {
    id: 'titleContent',
    build(ctx) {
      const m = margins(ctx);
      const bodyY = Math.round(m.top + lineHeightOf(ctx, 'title') + m.h * 0.06);
      return [
        textBox(ctx, { role: 'title', slot: 'title', x: m.x, y: m.top, w: m.w - m.x * 2 }),
        textBox(ctx, { role: 'body', slot: 'body', x: m.x, y: bodyY, w: m.w - m.x * 2, list: true }),
      ];
    },
  },
  {
    id: 'twoColumns',
    build(ctx) {
      const m = margins(ctx);
      const gap = Math.round(m.w * 0.05);
      const column = (m.w - m.x * 2 - gap) / 2;
      const bodyY = Math.round(m.top + lineHeightOf(ctx, 'title') + m.h * 0.06);
      return [
        textBox(ctx, { role: 'title', slot: 'title', x: m.x, y: m.top, w: m.w - m.x * 2 }),
        textBox(ctx, { role: 'body', slot: 'body', x: m.x, y: bodyY, w: column, list: true }),
        textBox(ctx, { role: 'body', slot: 'body2', x: m.x + column + gap, y: bodyY, w: column, list: true }),
      ];
    },
  },
  {
    id: 'imageText',
    build(ctx) {
      const m = margins(ctx);
      const imageW = Math.round(m.w * 0.46);
      const x = Math.round(imageW + m.x * 0.8);
      const w = m.w - x - m.x;
      const titleY = Math.round(m.h * 0.22);
      return [
        imageBox(ctx, 0, 0, imageW, m.h),
        textBox(ctx, { role: 'title', slot: 'title', x, y: titleY, w }),
        textBox(ctx, {
          role: 'body',
          slot: 'body',
          x,
          y: Math.round(titleY + lineHeightOf(ctx, 'title') + m.h * 0.05),
          w,
          list: true,
        }),
      ];
    },
  },
  {
    id: 'section',
    build(ctx) {
      const m = margins(ctx);
      const barY = Math.round(m.h * 0.3);
      const numberY = Math.round(barY + m.h * 0.05);
      return [
        accentBar(ctx, m.x, barY),
        textBox(ctx, { role: 'subtitle', slot: 'number', x: m.x, y: numberY, w: m.w - m.x * 2, color: 'accent' }),
        textBox(ctx, {
          role: 'title',
          slot: 'title',
          x: m.x,
          y: Math.round(numberY + lineHeightOf(ctx, 'subtitle') + m.h * 0.02),
          w: m.w - m.x * 2,
        }),
      ];
    },
  },
  {
    id: 'titleOnly',
    build(ctx) {
      const m = margins(ctx);
      return [textBox(ctx, { role: 'title', slot: 'title', x: m.x, y: m.top, w: m.w - m.x * 2 })];
    },
  },
  {
    id: 'quote',
    build(ctx) {
      const m = margins(ctx);
      const y = Math.round(m.h * 0.3);
      return [
        textBox(ctx, { role: 'title', slot: 'quote', x: m.x * 2, y, w: m.w - m.x * 4, align: 'center' }),
        textBox(ctx, {
          role: 'caption',
          slot: 'caption',
          x: m.x * 2,
          y: Math.round(y + lineHeightOf(ctx, 'title') * 2 + m.h * 0.05),
          w: m.w - m.x * 4,
          align: 'center',
          color: 'muted',
        }),
      ];
    },
  },
];

for (const layout of BUILTIN) registerLayout(layout);
