import { blurSigma } from './effects';
import { toCssColor, toHex } from './color';
import { rectCornerRadii } from './corners';
import { gradientCss } from './gradient';
import { rotationOf } from './matrix';
import type { Color, Fill, SceneNode } from './model';

/**
 * 把一个对象的外观写成 CSS（"检查"面板、复制为 CSS 用）。只是交付给开发的参考：
 * 大小、圆角、背景、边框、阴影、模糊、不透明度、混合模式、旋转，文字的字体和排版，自动布局写成 flex。
 * 描边在设计里是居中画的，CSS 的 border 画在里面，宽高按设计里的写，差半个描边宽度，这里不换算
 */

export interface CssDeclaration {
  property: string;
  value: string;
}

/** 数字去掉多余的小数（最多两位） */
function px(value: number): string {
  const rounded = Math.round(value * 100) / 100 || 0;
  return `${rounded}px`;
}

function num(value: number): string {
  return String(Math.round(value * 100) / 100 || 0);
}

/** 不透明的颜色写成 #rrggbb，半透明的写成 rgba */
export function cssColor(color: Color): string {
  return color.a >= 1 ? toHex(color) : toCssColor(color);
}

function background(fill: Fill, w: number, h: number): string | null {
  if (fill.type === 'solid') return cssColor(fill.color);
  if (fill.type === 'gradient') return gradientCss(fill, w, h);
  return null;
}

export interface CssContext {
  /** 节点画出来的宽高（自动宽度的文字用排版出来的宽度） */
  width: number;
  height: number;
  /** 节点所在的画框是不是自动布局的（子对象的填满写成 flex） */
  parentLayout?: 'horizontal' | 'vertical' | null;
}

export function nodeCss(node: SceneNode, context: CssContext): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  const add = (property: string, value: string | null | undefined): void => {
    if (value !== null && value !== undefined && value !== '') out.push({ property, value });
  };
  const { width: w, height: h } = context;
  if (node.type !== 'group' && node.type !== 'page') {
    add('width', px(w));
    add('height', px(h));
  }

  // 自动布局里的子对象
  if (context.parentLayout && !node.layoutIgnore && node.layoutSizing) {
    const mainFill = context.parentLayout === 'horizontal' ? node.layoutSizing.h : node.layoutSizing.v;
    const crossFill = context.parentLayout === 'horizontal' ? node.layoutSizing.v : node.layoutSizing.h;
    if (mainFill === 'fill') add('flex', '1 0 0');
    if (crossFill === 'fill') add('align-self', 'stretch');
  }

  const degrees = (rotationOf(node.transform) * 180) / Math.PI;
  if (Math.abs(degrees) > 0.01) add('transform', `rotate(${num(degrees)}deg)`);

  if (node.type === 'frame' && node.layout) {
    const l = node.layout;
    add('display', 'flex');
    add('flex-direction', l.direction === 'horizontal' ? 'row' : 'column');
    const justify = { start: 'flex-start', center: 'center', end: 'flex-end', spaceBetween: 'space-between' };
    const align = { start: 'flex-start', center: 'center', end: 'flex-end' };
    add('justify-content', justify[l.justify]);
    add('align-items', align[l.align]);
    if (l.justify !== 'spaceBetween') add('gap', px(l.gap));
    const [top, right, bottom, left] = l.padding;
    if (top || right || bottom || left) {
      add(
        'padding',
        top === bottom && left === right
          ? top === left
            ? px(top)
            : `${px(top)} ${px(right)}`
          : `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`,
      );
    }
  }

  if (node.type === 'text') {
    const s = node.style;
    add('font-family', `"${s.fontFamily.latin}", "${s.fontFamily.cjk}"`);
    add('font-size', px(s.fontSize));
    if (s.fontWeight !== 400) add('font-weight', String(s.fontWeight));
    if (s.italic) add('font-style', 'italic');
    add('line-height', num(s.lineHeight));
    if (s.letterSpacing) add('letter-spacing', px(s.letterSpacing));
    const decorations = [s.underline ? 'underline' : '', s.strikethrough ? 'line-through' : ''].filter(Boolean);
    if (decorations.length > 0) add('text-decoration', decorations.join(' '));
    if (node.align !== 'left') add('text-align', node.align);
    if (node.fill?.type === 'solid') add('color', cssColor(node.fill.color));
  } else if ('fill' in node && node.fill) {
    add('background', background(node.fill, w, h));
  }

  if ('stroke' in node && node.stroke && node.stroke.width > 0 && node.type !== 'path') {
    const dashed = node.stroke.dash && node.stroke.dash.length > 0;
    add('border', `${px(node.stroke.width)} ${dashed ? 'dashed' : 'solid'} ${cssColor(node.stroke.color)}`);
  }

  if (node.type === 'rect' || node.type === 'frame') {
    const radii = rectCornerRadii(node).map((r) => Math.max(0, Math.min(r, w / 2, h / 2)));
    if (radii.some((r) => r > 0)) {
      add('border-radius', radii.every((r) => r === radii[0]) ? px(radii[0]!) : radii.map(px).join(' '));
    }
  }
  if (node.type === 'ellipse') add('border-radius', '50%');
  if (node.type === 'frame' && node.clip) add('overflow', 'hidden');

  const effects = (node.effects ?? []).filter((e) => !e.hidden);
  const shadows = effects.flatMap((e) =>
    e.type === 'dropShadow' || e.type === 'innerShadow'
      ? [
          `${e.type === 'innerShadow' ? 'inset ' : ''}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread)} ${cssColor(e.color)}`,
        ]
      : [],
  );
  if (shadows.length > 0) add('box-shadow', shadows.join(', '));
  for (const e of effects) {
    if (e.type === 'layerBlur' && e.radius > 0) add('filter', `blur(${px(blurSigma(e.radius))})`);
    if (e.type === 'backgroundBlur' && e.radius > 0) add('backdrop-filter', `blur(${px(blurSigma(e.radius))})`);
  }

  if (node.opacity < 1) add('opacity', num(node.opacity));
  if (node.blendMode !== 'normal') add('mix-blend-mode', node.blendMode);
  return out;
}

/** 写成一段 CSS 文本：一行一条，每行两个空格缩进 */
export function cssText(declarations: readonly CssDeclaration[]): string {
  return declarations.map((d) => `${d.property}: ${d.value};`).join('\n');
}
