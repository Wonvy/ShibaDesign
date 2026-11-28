/**
 * 写 SVG 用的小工具：一个极简的元素树、转义、数字和路径的写法。
 * 不依赖渲染引擎；遍历节点、决定写什么在渲染器的 svg.ts 里。
 */

/** 一个 SVG 元素。子项是字符串时是已经转义好的文字内容 */
export interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
  children: (SvgElement | string)[];
}

type AttrValue = string | number | null | undefined | false;

/** 建一个元素；值为 null、undefined、false 的属性不写 */
export function svgEl(
  tag: string,
  attrs: Record<string, AttrValue> = {},
  children: (SvgElement | string)[] = [],
): SvgElement {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    clean[key] = typeof value === 'number' ? svgNumber(value) : value;
  }
  return { tag, attrs: clean, children };
}

/** 文字内容和属性值里要转义的字符 */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** 文字内容的转义：引号不用转，CSS 里的字符串读起来清楚些 */
export function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * 去掉 XML 不允许出现的字符（大部分控制字符、落单的代理项）。
 * 文字来自用户输入或者打开的文件，里面可能有这些字符，写进去整个 SVG 就打不开了
 */
export function xmlSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '',
  );
}

/** 数字的写法：最多三位小数，去掉多余的零，不出现 -0 和科学计数法 */
export function svgNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  if (rounded === 0) return '0';
  let text = rounded.toFixed(3);
  text = text.replace(/\.?0+$/, '');
  return text;
}

/** 2×3 矩阵 [a, b, c, d, e, f] → transform 属性；单位矩阵返回 null */
export function svgMatrix(m: readonly number[]): string | null {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  if (a === 1 && b === 0 && c === 0 && d === 1) {
    if (e === 0 && f === 0) return null;
    return `translate(${svgNumber(e)} ${svgNumber(f)})`;
  }
  return `matrix(${[a, b, c, d, e, f].map(svgNumber).join(' ')})`;
}

/** 颜色分量 0–1 → #rrggbb */
export function svgColor(color: { r: number; g: number; b: number }): string {
  const c = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(color.r)}${c(color.g)}${c(color.b)}`;
}

/** 不透明度属性的值；完全不透明时返回 null（不用写） */
export function svgOpacity(alpha: number): string | null {
  const a = Math.min(1, Math.max(0, alpha));
  return a >= 1 ? null : svgNumber(a);
}

/**
 * 路径数据（0 移动、1 直线、2 三次曲线、3 二次曲线、4 闭合）→ SVG 的 d 属性。
 * @param map 写出之前对每个点做的变换，比如把字形从字体坐标放到页面上
 */
export function svgPath(data: ArrayLike<number>, map?: (x: number, y: number) => [number, number]): string {
  const ARITY = [2, 2, 6, 4, 0];
  const LETTERS = ['M', 'L', 'C', 'Q', 'Z'];
  const parts: string[] = [];
  for (let i = 0; i < data.length;) {
    const verb = data[i++]!;
    const count = ARITY[verb];
    if (count === undefined) break;
    let segment = LETTERS[verb]!;
    for (let k = 0; k < count; k += 2) {
      let x = data[i + k]!;
      let y = data[i + k + 1]!;
      if (map) [x, y] = map(x, y);
      segment += `${k === 0 ? '' : ' '}${svgNumber(x)} ${svgNumber(y)}`;
    }
    parts.push(segment);
    i += count;
  }
  return parts.join('');
}

/** 字节 → base64 */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64(bytes)}`;
}

/** 这些元素整个写在一行里：文字元素里不能插空白（xml:space="preserve" 下空白会显示出来） */
const INLINE = new Set(['text', 'tspan', 'style', 'title']);

/** 属性值的转义：用双引号括起来，单引号不用转 */
function escapeAttr(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

/**
 * 写成文本。容器元素一个子元素一行、按层级缩进，好读；
 * 文字元素和含文字内容的元素整个写在一行里，不能往文字里插空白
 */
export function serializeSvg(root: SvgElement): string {
  const out: string[] = [];
  const open = (el: SvgElement): string => {
    let tag = `<${el.tag}`;
    for (const [key, value] of Object.entries(el.attrs)) tag += ` ${key}="${escapeAttr(value)}"`;
    return tag;
  };
  const inline = (el: SvgElement): string =>
    el.children.length === 0
      ? `${open(el)}/>`
      : `${open(el)}>${el.children.map((child) => (typeof child === 'string' ? child : inline(child))).join('')}</${el.tag}>`;
  const write = (el: SvgElement, depth: number): void => {
    const indent = '  '.repeat(depth);
    if (el.children.length === 0 || INLINE.has(el.tag) || el.children.some((child) => typeof child === 'string')) {
      out.push(indent + inline(el));
      return;
    }
    out.push(`${indent}${open(el)}>`);
    for (const child of el.children) write(child as SvgElement, depth + 1);
    out.push(`${indent}</${el.tag}>`);
  };
  write(root, 0);
  return out.join('\n');
}
