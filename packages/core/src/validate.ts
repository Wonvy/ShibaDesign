import { isAutoLayout, isItemSizing } from './auto-layout';
import { isConstraints } from './constraints';
import { isEffectList } from './effects';
import { isExportList } from './export-settings';
import { isInteractionList } from './interactions';
import { isLayoutGridList } from './layout-grid';
import { CORNER_STYLES } from './corners';
import { CURVE_CHANNELS, MAX_CURVE_POINTS } from './curves';
import { MAX_GRADIENT_STOPS } from './gradient';
import { DOCUMENT_VERSION, TEXT_ALIGNS, type DocumentData } from './model';
import { LIST_KINDS, MAX_LIST_LEVEL } from './paragraphs';
import { ARROW_HEADS, MAX_DASH_SEGMENTS, STROKE_CAPS, STROKE_JOINS } from './stroke';
import { MAX_STYLE_NAME, MAX_STYLES } from './styles';

/**
 * 文档数据校验。文档可能来自用户打开的文件，是不可信输入：
 * 结构不对的数据进了内核会导致崩溃甚至死循环（比如父子关系成环），所以在入口处拦住。
 *
 * 这里只保证"结构安全"：字段类型正确、数值有限、树没有环。
 * 不认识的节点类型会被放行，渲染器会忽略它们，这样旧版本打开新文件时不至于整个打不开。
 */

export type DocumentErrorReason = 'notObject' | 'newerVersion' | 'noRoot' | 'badNode' | 'cycle';

export class DocumentError extends Error {
  constructor(
    readonly reason: DocumentErrorReason,
    detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

const MAX_NODES = 200_000;
const MAX_TEXT_LENGTH = 1_000_000;
/** 一条动作路径最多几个锚点 */
const MAX_MOTION_ANCHORS = 1000;

/** 一个画板（或页面）上最多几条辅助线 */
const MAX_GUIDES = 1000;

function isGuideList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_GUIDES &&
    value.every(
      (g) =>
        isObject(g) &&
        typeof g.id === 'string' &&
        (g.axis === 'x' || g.axis === 'y') &&
        typeof g.offset === 'number' &&
        Number.isFinite(g.offset),
    )
  );
}

export function validateDocument(data: unknown): DocumentData {
  if (!isObject(data) || !isObject(data.nodes)) throw new DocumentError('notObject');
  if (typeof data.version !== 'number' || !Number.isFinite(data.version)) throw new DocumentError('notObject');
  if (data.version > DOCUMENT_VERSION) throw new DocumentError('newerVersion', String(data.version));
  if (typeof data.rootId !== 'string') throw new DocumentError('noRoot');

  const nodes = data.nodes;
  const ids = Object.keys(nodes);
  if (ids.length > MAX_NODES) throw new DocumentError('badNode', 'too many nodes');
  const root = nodes[data.rootId];
  if (!isObject(root) || root.parent !== null) throw new DocumentError('noRoot');

  for (const id of ids) {
    const node = nodes[id];
    if (!isObject(node)) throw new DocumentError('badNode', id);
    checkNode(id, node, nodes);
  }

  // 每个节点顺着 parent 往上走，必须能走到根。走过的节点记下来，整体是线性时间
  const reachesRoot = new Set<string>([data.rootId]);
  for (const id of ids) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !reachesRoot.has(current)) {
      if (path.has(current)) throw new DocumentError('cycle', id);
      path.add(current);
      current = (nodes[current] as { parent: string | null }).parent;
    }
    if (current === null) throw new DocumentError('badNode', `${id} is detached`);
    for (const visited of path) reachesRoot.add(visited);
  }

  checkComponents(nodes as Record<string, Record<string, unknown>>);
  return data as unknown as DocumentData;
}

/**
 * 组件的规则（见 components.ts）：主组件不能放在主组件里；主组件里不能直接或间接出现自己的实例，
 * 否则同步时会无限长下去
 */
function checkComponents(nodes: Record<string, Record<string, unknown>>): void {
  const enclosing = (id: string | null): string | null => {
    for (let current = id; current !== null;) {
      const node = nodes[current]!;
      if (node.component === true) return current;
      current = node.parent as string | null;
    }
    return null;
  };
  /** 主组件 → 它里面的实例用到的组件 */
  const uses = new Map<string, Set<string>>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.component === true && enclosing(node.parent as string | null) !== null) {
      throw new DocumentError('badNode', `${id}: component inside component`);
    }
    if (typeof node.instanceOf !== 'string') continue;
    const host = enclosing(node.parent as string | null);
    if (host === null) continue;
    let set = uses.get(host);
    if (!set) uses.set(host, (set = new Set()));
    set.add(node.instanceOf);
  }
  // 深度优先找环：0 没访问过，1 在当前路径上，2 查完了
  const state = new Map<string, number>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const next of uses.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) throw new DocumentError('cycle', `component ${next}`);
      if (s === 0) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of uses.keys()) if (!state.has(id)) visit(id);
}

/** 样式的用途：省略，或者是一个短字符串。不认识的用途（更新的版本加的）不拒绝，版式取样式时用不上它而已 */
function isRole(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 32);
}

function isStringList(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length <= max && value.every((v) => typeof v === 'string' && v.length <= 64);
}

function isStyleList(value: unknown, check: (style: Record<string, unknown>) => boolean): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_STYLES &&
    value.every(
      (s) =>
        isObject(s) &&
        typeof s.id === 'string' &&
        s.id.length <= 64 &&
        typeof s.name === 'string' &&
        s.name.length <= MAX_STYLE_NAME &&
        check(s),
    )
  );
}

function checkNode(id: string, node: Record<string, unknown>, nodes: Record<string, unknown>): void {
  const fail = (what: string): never => {
    throw new DocumentError('badNode', `${id}: ${what}`);
  };
  if (node.id !== id) fail('id');
  if (typeof node.type !== 'string') fail('type');
  if (typeof node.lineageId !== 'string') fail('lineageId');
  if (typeof node.index !== 'string') fail('index');
  if (!isFiniteNumber(node.seq)) fail('seq');
  if (node.name !== undefined && typeof node.name !== 'string') fail('name');
  if (node.parent !== null && (typeof node.parent !== 'string' || !isObject(nodes[node.parent]))) fail('parent');
  if (!isNumberArray(node.transform, 6)) fail('transform');
  if (!isNumberArray(node.size, 2)) fail('size');
  if (!isFiniteNumber(node.opacity)) fail('opacity');
  if (typeof node.blendMode !== 'string') fail('blendMode');
  if (typeof node.visible !== 'boolean' || typeof node.locked !== 'boolean') fail('visible/locked');
  if (node.source !== undefined && typeof node.source !== 'string') fail('source');
  if (node.overrides !== undefined && !isStringList(node.overrides, 100)) fail('overrides');
  if (node.constraints !== undefined && !isConstraints(node.constraints)) fail('constraints');
  if (node.effects !== undefined && !isEffectList(node.effects)) fail('effects');
  if (node.layoutSizing !== undefined && !isItemSizing(node.layoutSizing)) fail('layoutSizing');
  if (node.layoutIgnore !== undefined && typeof node.layoutIgnore !== 'boolean') fail('layoutIgnore');
  if (node.exports !== undefined && !isExportList(node.exports)) fail('exports');
  if (node.interactions !== undefined && !isInteractionList(node.interactions)) fail('interactions');

  if ('fill' in node && node.fill !== null && !isFill(node.fill)) fail('fill');
  if ('stroke' in node && node.stroke !== null) {
    const stroke = node.stroke;
    if (!isObject(stroke) || !isColor(stroke.color) || !isFiniteNumber(stroke.width)) fail('stroke');
    const { dash, dashOffset, cap, join, colorStyle, arrowStart, arrowEnd } = stroke as Record<string, unknown>;
    const isArrow = (v: unknown): boolean => v === undefined || (ARROW_HEADS as readonly unknown[]).includes(v);
    if (!isArrow(arrowStart) || !isArrow(arrowEnd)) fail('stroke');
    if (
      (dash !== undefined &&
        !(
          Array.isArray(dash) &&
          dash.length <= MAX_DASH_SEGMENTS &&
          dash.every((v) => isFiniteNumber(v) && (v as number) >= 0 && (v as number) <= 100_000)
        )) ||
      (dashOffset !== undefined && !isFiniteNumber(dashOffset)) ||
      (cap !== undefined && !(STROKE_CAPS as readonly unknown[]).includes(cap)) ||
      (join !== undefined && !(STROKE_JOINS as readonly unknown[]).includes(join)) ||
      (colorStyle !== undefined && typeof colorStyle !== 'string')
    ) {
      fail('stroke');
    }
  }

  switch (node.type) {
    case 'rect':
      if (!isFiniteNumber(node.cornerRadius)) fail('cornerRadius');
      if (
        node.cornerRadii !== undefined &&
        !(Array.isArray(node.cornerRadii) && node.cornerRadii.length === 4 && node.cornerRadii.every(isNonNegative))
      ) {
        fail('cornerRadii');
      }
      if (!isCornerLook(node)) fail('cornerStyle');
      break;
    case 'frame':
      if (!isFiniteNumber(node.cornerRadius) || node.cornerRadius < 0) fail('cornerRadius');
      if (
        node.cornerRadii !== undefined &&
        !(Array.isArray(node.cornerRadii) && node.cornerRadii.length === 4 && node.cornerRadii.every(isNonNegative))
      ) {
        fail('cornerRadii');
      }
      if (!isCornerLook(node)) fail('cornerStyle');
      if (typeof node.clip !== 'boolean') fail('clip');
      if (node.layout !== undefined && !isAutoLayout(node.layout)) fail('layout');
      if (node.layoutGrids !== undefined && !isLayoutGridList(node.layoutGrids)) fail('layoutGrids');
      break;
    case 'polygon':
      if (!isFiniteNumber(node.sides) || node.sides < 3 || node.sides > 60) fail('sides');
      if (
        node.innerRatio !== undefined &&
        !(isFiniteNumber(node.innerRatio) && node.innerRatio > 0 && node.innerRatio <= 1)
      ) {
        fail('innerRatio');
      }
      if (!isFiniteNumber(node.cornerRadius) || node.cornerRadius < 0) fail('cornerRadius');
      if (!isCornerLook(node)) fail('cornerStyle');
      break;
    case 'path':
      if (!Array.isArray(node.subpaths) || !node.subpaths.every(isSubpath)) fail('subpaths');
      if (!isCornerLook(node)) fail('cornerStyle');
      break;
    case 'boolean':
      if (typeof node.op !== 'string') fail('op');
      break;
    case 'artboard':
      if (node.deck !== null && !isDeck(node.deck)) fail('deck');
      if (node.guides !== undefined && !isGuideList(node.guides)) fail('guides');
      if (node.layoutGrids !== undefined && !isLayoutGridList(node.layoutGrids)) fail('layoutGrids');
      break;
    case 'group':
      if (node.mask !== undefined && typeof node.mask !== 'string') fail('mask');
      if (node.component !== undefined && typeof node.component !== 'boolean') fail('component');
      if (node.instanceOf !== undefined && typeof node.instanceOf !== 'string') fail('instanceOf');
      if (node.component === true && node.instanceOf !== undefined) fail('component/instanceOf');
      break;
    case 'page':
      if (node.colorStyles !== undefined && !isStyleList(node.colorStyles, (s) => isColor(s.color) && isRole(s.role))) {
        fail('colorStyles');
      }
      if (
        node.textStyles !== undefined &&
        !isStyleList(node.textStyles, (s) => isTextStyle(s.style) && isRole(s.role))
      ) {
        fail('textStyles');
      }
      if (node.guides !== undefined && !isGuideList(node.guides)) fail('guides');
      break;
    case 'text': {
      if (typeof node.text !== 'string' || node.text.length > MAX_TEXT_LENGTH) fail('text');
      if (!isTextStyle(node.style)) fail('style');
      if (node.textStyle !== undefined && typeof node.textStyle !== 'string') fail('textStyle');
      if (typeof node.align !== 'string' || typeof node.sizing !== 'string') fail('align/sizing');
      if (node.spans !== undefined && !isSpans(node.spans, (node.text as string).length)) fail('spans');
      if (node.paragraphs !== undefined && !isParagraphs(node.paragraphs, node.text as string)) fail('paragraphs');
      if (node.appearance !== undefined && !isAppearance(node.appearance)) fail('appearance');
      break;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberArray(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

/** 曲线：每个通道（可省略）是 2 到 MAX_CURVE_POINTS 个坐标为数的点。超出 0–1、顺序乱的渲染时会整理，这里不拒绝 */
function isCurves(value: unknown): boolean {
  if (!isObject(value)) return false;
  return CURVE_CHANNELS.every((channel) => {
    const points = value[channel];
    if (points === undefined) return true;
    return (
      Array.isArray(points) &&
      points.length >= 2 &&
      points.length <= MAX_CURVE_POINTS &&
      points.every((point) => isObject(point) && isFiniteNumber(point.x) && isFiniteNumber(point.y))
    );
  });
}

function isTextStyle(style: unknown): boolean {
  return (
    isObject(style) &&
    isObject(style.fontFamily) &&
    typeof style.fontFamily.latin === 'string' &&
    typeof style.fontFamily.cjk === 'string' &&
    isFiniteNumber(style.fontSize) &&
    isFiniteNumber(style.fontWeight) &&
    isFiniteNumber(style.lineHeight) &&
    isFiniteNumber(style.letterSpacing) &&
    ['italic', 'underline', 'strikethrough'].every((k) => style[k] === undefined || typeof style[k] === 'boolean')
  );
}

function isColor(value: unknown): boolean {
  return isObject(value) && [value.r, value.g, value.b, value.a].every(isFiniteNumber);
}

function isFill(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === 'solid') {
    return isColor(value.color) && (value.colorStyle === undefined || typeof value.colorStyle === 'string');
  }
  if (value.type === 'image') {
    if (typeof value.assetId !== 'string' || typeof value.fit !== 'string') return false;
    for (const key of ['zoom', 'panX', 'panY']) {
      if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
    }
    if (value.adjust !== undefined && !(isObject(value.adjust) && Object.values(value.adjust).every(isFiniteNumber))) {
      return false;
    }
    if (value.curves !== undefined && !isCurves(value.curves)) return false;
    if (value.filter !== undefined) {
      const filter = value.filter;
      if (!isObject(filter) || typeof filter.preset !== 'string' || filter.preset.length > 64) return false;
      if (!isFiniteNumber(filter.amount)) return false;
    }
    return true;
  }
  if (value.type === 'gradient') {
    if (typeof value.kind !== 'string' || !isPoint(value.start) || !isPoint(value.end)) return false;
    if (value.aspect !== undefined && !(isFiniteNumber(value.aspect) && value.aspect > 0)) return false;
    const stops = value.stops;
    return (
      Array.isArray(stops) &&
      stops.length >= 2 &&
      stops.length <= MAX_GRADIENT_STOPS &&
      stops.every((s) => isObject(s) && isFiniteNumber(s.offset) && s.offset >= 0 && s.offset <= 1 && isColor(s.color))
    );
  }
  return false;
}

function isPoint(value: unknown): boolean {
  return isObject(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isDeck(value: unknown): boolean {
  if (!isObject(value) || typeof value.order !== 'string') return false;
  const { transition, animations, notes, skip } = value;
  if (skip !== undefined && typeof skip !== 'boolean') return false;
  // 备注会显示在演讲者视图里：只能是文字，长度有上限
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_TEXT_LENGTH)) return false;
  if (transition !== undefined) {
    if (!isObject(transition) || typeof transition.effect !== 'string' || !isFiniteNumber(transition.duration)) {
      return false;
    }
  }
  if (animations === undefined) return true;
  return (
    Array.isArray(animations) &&
    animations.length <= 2000 &&
    animations.every(
      (a) =>
        isObject(a) &&
        typeof a.id === 'string' &&
        typeof a.target === 'string' &&
        typeof a.effect === 'string' &&
        typeof a.start === 'string' &&
        isFiniteNumber(a.duration) &&
        isFiniteNumber(a.delay) &&
        (a.path === undefined ||
          (isSubpath(a.path) && (a.path as { anchors: unknown[] }).anchors.length <= MAX_MOTION_ANCHORS)),
    )
  );
}

/** 字符级样式的区间：按位置排好、互不重叠、在文字范围内，样式项的类型正确 */
function isSpans(value: unknown, length: number): boolean {
  if (!Array.isArray(value) || value.length > length) return false;
  let at = 0;
  for (const span of value) {
    if (!isObject(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end)) return false;
    const start = span.start as number;
    const end = span.end as number;
    if (start < at || end <= start || end > length || !isObject(span.style)) return false;
    at = end;
    const style = span.style;
    const family = style.fontFamily;
    if (
      family !== undefined &&
      !(isObject(family) && typeof family.latin === 'string' && typeof family.cjk === 'string')
    ) {
      return false;
    }
    for (const key of ['fontSize', 'fontWeight', 'letterSpacing']) {
      if (style[key] !== undefined && !isFiniteNumber(style[key])) return false;
    }
    for (const key of ['italic', 'underline', 'strikethrough']) {
      if (style[key] !== undefined && typeof style[key] !== 'boolean') return false;
    }
    if (style.color !== undefined && style.color !== null && !isColor(style.color)) return false;
  }
  return true;
}

/** 段落样式：每段一项（可以是 null），不比段落多，值的类型和范围都对 */
function isParagraphs(value: unknown, text: string): boolean {
  if (!Array.isArray(value) || value.length > text.split('\n').length) return false;
  for (const entry of value) {
    if (entry === null) continue;
    if (!isObject(entry)) return false;
    for (const [key, v] of Object.entries(entry)) {
      if (key === 'align') {
        if (!(TEXT_ALIGNS as readonly unknown[]).includes(v)) return false;
      } else if (key === 'list') {
        if (v !== null && !(LIST_KINDS as readonly unknown[]).includes(v)) return false;
      } else if (key === 'level') {
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > MAX_LIST_LEVEL) return false;
      } else if (['spaceBefore', 'spaceAfter', 'indent', 'firstLine'].includes(key)) {
        if (!isFiniteNumber(v) || (v as number) < 0 || (v as number) > 10_000) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}

/** 一段文字的字形个数上限，远超一页能放下的字 */
const MAX_APPEARANCE_GLYPHS = 200_000;

function isAppearance(value: unknown): boolean {
  if (!isObject(value) || typeof value.basis !== 'string' || !isFiniteNumber(value.baseline)) return false;
  if (!Array.isArray(value.runs)) return false;
  let count = 0;
  for (const run of value.runs) {
    if (!isObject(run) || typeof run.library !== 'string' || !isNumberArray(run.matrix, 4)) return false;
    if (run.color !== undefined && !isColor(run.color)) return false;
    const glyphs = run.glyphs;
    if (!Array.isArray(glyphs) || glyphs.length % 3 !== 0) return false;
    count += glyphs.length / 3;
    if (count > MAX_APPEARANCE_GLYPHS) return false;
    for (let i = 0; i < glyphs.length; i += 3) {
      const index = glyphs[i];
      if (!Number.isInteger(index) || index < 0 || !isFiniteNumber(glyphs[i + 1]) || !isFiniteNumber(glyphs[i + 2])) {
        return false;
      }
    }
  }
  return true;
}

function isSubpath(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.closed === 'boolean' &&
    Array.isArray(value.anchors) &&
    value.anchors.every(
      (a) =>
        isObject(a) &&
        [a.x, a.y, a.inX, a.inY, a.outX, a.outY].every(isFiniteNumber) &&
        (a.radius === undefined || isNonNegative(a.radius)),
    )
  );
}

function isNonNegative(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0;
}

/** 圆角样式只能是认识的那几种，平滑度在 0 到 1 之间 */
function isCornerLook(node: Record<string, unknown>): boolean {
  const style = node.cornerStyle;
  const smoothing = node.cornerSmoothing;
  if (style !== undefined && !(CORNER_STYLES as readonly unknown[]).includes(style)) return false;
  return smoothing === undefined || (isFiniteNumber(smoothing) && smoothing >= 0 && smoothing <= 1);
}
