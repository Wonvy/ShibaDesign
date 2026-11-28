/**
 * 面板布局：左栏、右栏、画布下方三个停靠区，每个停靠区从上到下（下方是从左到右）放几个面板组，
 * 每个面板组是一排选项卡；另外有浮在画布上的浮动窗。
 *
 * 这里全是纯函数：输入布局，返回新的布局，不改原来的。界面层只负责显示和把拖动变成这些调用。
 * 布局记在浏览器里，读回来时用 normalize 整理（不认识的面板去掉、同一个面板只留一个、浮动窗挪回窗口里），
 * 坏数据就用默认布局。
 */

export type ZoneId = 'left' | 'right' | 'bottom';
export const ZONES: readonly ZoneId[] = ['left', 'right', 'bottom'];

export interface TabGroup {
  id: string;
  tabs: string[];
  active: string;
  /** 同一个停靠区里几个组按这个比例分高度（下方停靠区分宽度） */
  weight: number;
}

export interface Zone {
  /** 左右栏的宽度、下方停靠区的高度，CSS 像素 */
  size: number;
  /** 收起成一条细边 */
  collapsed: boolean;
  groups: TabGroup[];
}

export interface FloatingWindow {
  id: string;
  tabs: string[];
  active: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 折叠成只剩标题栏 */
  collapsed: boolean;
}

export interface DockLayout {
  version: 1;
  zones: Record<ZoneId, Zone>;
  /** 后面的在上层 */
  floating: FloatingWindow[];
  /** ⌘\ 隐藏全部面板 */
  hidden: boolean;
}

export type DropTarget =
  /** 并进一个面板组（停靠的或者浮动的）的第 index 个位置 */
  | { kind: 'tabs'; group: string; index: number }
  /** 在停靠区的第 index 个位置拆出一个新的面板组 */
  | { kind: 'split'; zone: ZoneId; index: number }
  /** 变成浮动窗 */
  | { kind: 'float'; x: number; y: number; w: number; h: number };

export const MIN_ZONE_SIZE = 180;
export const MAX_ZONE_SIZE = 640;
export const MIN_FLOAT = { w: 220, h: 120 };
/** 浮动窗至少露出这么多，免得拖到窗口外面找不回来 */
const KEEP_VISIBLE = 48;
const TITLE_HEIGHT = 32;

let nextId = 1;
/** 新的面板组、浮动窗的 id */
export function newGroupId(prefix = 'g'): string {
  return `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

export const DEFAULT_LAYOUT: DockLayout = {
  version: 1,
  zones: {
    left: {
      size: 236,
      collapsed: false,
      groups: [{ id: 'left-1', tabs: ['slides', 'layers', 'assets'], active: 'layers', weight: 1 }],
    },
    right: {
      size: 284,
      collapsed: false,
      groups: [{ id: 'right-1', tabs: ['properties'], active: 'properties', weight: 1 }],
    },
    bottom: { size: 160, collapsed: true, groups: [{ id: 'bottom-1', tabs: ['notes'], active: 'notes', weight: 1 }] },
  },
  floating: [],
  hidden: false,
};

/** 某个面板现在在哪里 */
export type TabLocation =
  | { kind: 'zone'; zone: ZoneId; group: TabGroup; groupIndex: number; tabIndex: number }
  | { kind: 'float'; window: FloatingWindow; tabIndex: number };

export function findTab(layout: DockLayout, tab: string): TabLocation | null {
  for (const zone of ZONES) {
    const groups = layout.zones[zone].groups;
    for (let i = 0; i < groups.length; i++) {
      const at = groups[i]!.tabs.indexOf(tab);
      if (at >= 0) return { kind: 'zone', zone, group: groups[i]!, groupIndex: i, tabIndex: at };
    }
  }
  for (const window of layout.floating) {
    const at = window.tabs.indexOf(tab);
    if (at >= 0) return { kind: 'float', window, tabIndex: at };
  }
  return null;
}

/** 某个面板正在显示吗（在某一组里而且是那一组正在看的那个，所在的停靠区没收起） */
export function isTabVisible(layout: DockLayout, tab: string): boolean {
  if (layout.hidden) return false;
  const at = findTab(layout, tab);
  if (!at) return false;
  if (at.kind === 'float') return at.window.active === tab && !at.window.collapsed;
  return at.group.active === tab && !layout.zones[at.zone].collapsed;
}

/** 深拷贝（布局很小，直接用 JSON） */
function clone(layout: DockLayout): DockLayout {
  return JSON.parse(JSON.stringify(layout)) as DockLayout;
}

/** 从所在的地方拿掉一个面板（不整理） */
function detach(layout: DockLayout, tab: string): void {
  for (const zone of ZONES) {
    for (const group of layout.zones[zone].groups) group.tabs = group.tabs.filter((t) => t !== tab);
  }
  for (const window of layout.floating) window.tabs = window.tabs.filter((t) => t !== tab);
}

function groupById(layout: DockLayout, id: string): { tabs: string[]; active: string } | null {
  for (const zone of ZONES) {
    const group = layout.zones[zone].groups.find((g) => g.id === id);
    if (group) return group;
  }
  return layout.floating.find((w) => w.id === id) ?? null;
}

/** 把面板挪到目标位置：并进别的组、拆出新组、变成浮动窗。挪过去的面板成为那一组正在看的 */
export function moveTab(layout: DockLayout, tab: string, target: DropTarget): DockLayout {
  const next = clone(layout);
  // 并进自己所在的组：只是调顺序，先记下原来的位置，换算插入点
  if (target.kind === 'tabs') {
    const group = groupById(next, target.group);
    if (!group) return layout;
    const from = group.tabs.indexOf(tab);
    detach(next, tab);
    const index = from >= 0 && from < target.index ? target.index - 1 : target.index;
    group.tabs.splice(Math.max(0, Math.min(index, group.tabs.length)), 0, tab);
    group.active = tab;
  } else if (target.kind === 'split') {
    detach(next, tab);
    const groups = next.zones[target.zone].groups;
    const weight = groups.length > 0 ? groups.reduce((sum, g) => sum + g.weight, 0) / groups.length : 1;
    groups.splice(Math.max(0, Math.min(target.index, groups.length)), 0, {
      id: newGroupId(),
      tabs: [tab],
      active: tab,
      weight,
    });
    next.zones[target.zone].collapsed = false;
  } else {
    detach(next, tab);
    next.floating.push({
      id: newGroupId('f'),
      tabs: [tab],
      active: tab,
      x: target.x,
      y: target.y,
      w: Math.max(MIN_FLOAT.w, target.w),
      h: Math.max(MIN_FLOAT.h, target.h),
      collapsed: false,
    });
  }
  return tidy(next);
}

/** 关掉一个面板（从窗口菜单还能打开） */
export function closeTab(layout: DockLayout, tab: string): DockLayout {
  const next = clone(layout);
  detach(next, tab);
  return tidy(next);
}

/** 切到某一组里的某个面板 */
export function activateTab(layout: DockLayout, tab: string): DockLayout {
  const at = findTab(layout, tab);
  if (!at) return layout;
  const next = clone(layout);
  const located = findTab(next, tab)!;
  if (located.kind === 'zone') {
    located.group.active = tab;
    next.zones[located.zone].collapsed = false;
  } else {
    located.window.active = tab;
    located.window.collapsed = false;
    // 浮动窗切过去时放到最上层
    next.floating = [...next.floating.filter((w) => w !== located.window), located.window];
  }
  next.hidden = false;
  return next;
}

/**
 * 打开一个面板：已经在了就切过去；不在的话放到它默认的地方（某个停靠区的第一组，或者浮动）
 */
export function openTab(
  layout: DockLayout,
  tab: string,
  place: { zone: ZoneId } | { float: { x: number; y: number; w: number; h: number } },
): DockLayout {
  if (findTab(layout, tab)) return activateTab(layout, tab);
  if ('float' in place) return moveTab(layout, tab, { kind: 'float', ...place.float });
  const groups = layout.zones[place.zone].groups;
  const first = groups[0];
  const target: DropTarget = first
    ? { kind: 'tabs', group: first.id, index: first.tabs.length }
    : { kind: 'split', zone: place.zone, index: 0 };
  return { ...moveTab(layout, tab, target), hidden: false };
}

/** 打开或收起一个面板（窗口菜单、⌥ 加数字）：正在显示就关掉，否则打开并切过去 */
export function toggleTab(
  layout: DockLayout,
  tab: string,
  place: { zone: ZoneId } | { float: { x: number; y: number; w: number; h: number } },
): DockLayout {
  return isTabVisible(layout, tab) ? closeTab(layout, tab) : openTab(layout, tab, place);
}

export function setZoneSize(layout: DockLayout, zone: ZoneId, size: number): DockLayout {
  const next = clone(layout);
  next.zones[zone].size = Math.round(
    Math.max(MIN_ZONE_SIZE * (zone === 'bottom' ? 0.5 : 1), Math.min(MAX_ZONE_SIZE, size)),
  );
  return next;
}

export function setZoneCollapsed(layout: DockLayout, zone: ZoneId, collapsed: boolean): DockLayout {
  const next = clone(layout);
  next.zones[zone].collapsed = collapsed;
  return next;
}

/** 拖两个相邻面板组之间的分隔条：按新的比例分 */
export function setGroupWeights(layout: DockLayout, zone: ZoneId, weights: readonly number[]): DockLayout {
  const next = clone(layout);
  next.zones[zone].groups.forEach((g, i) => {
    const w = weights[i];
    if (w !== undefined && Number.isFinite(w)) g.weight = Math.max(0.1, w);
  });
  return next;
}

export function updateFloating(
  layout: DockLayout,
  id: string,
  patch: Partial<Omit<FloatingWindow, 'id' | 'tabs'>>,
): DockLayout {
  const next = clone(layout);
  const window = next.floating.find((w) => w.id === id);
  if (!window) return layout;
  Object.assign(window, patch);
  window.w = Math.max(MIN_FLOAT.w, window.w);
  window.h = Math.max(MIN_FLOAT.h, window.h);
  return next;
}

export function bringToFront(layout: DockLayout, id: string): DockLayout {
  const window = layout.floating.find((w) => w.id === id);
  if (!window || layout.floating.at(-1) === window) return layout;
  return { ...layout, floating: [...layout.floating.filter((w) => w.id !== id), window] };
}

export function setHidden(layout: DockLayout, hidden: boolean): DockLayout {
  return { ...layout, hidden };
}

/** 去掉空的组和浮动窗、修正正在看的面板（不检查面板认不认识） */
function tidy(layout: DockLayout): DockLayout {
  for (const zone of ZONES) {
    layout.zones[zone].groups = layout.zones[zone].groups.filter((g) => g.tabs.length > 0);
    for (const group of layout.zones[zone].groups)
      if (!group.tabs.includes(group.active)) group.active = group.tabs[0]!;
  }
  layout.floating = layout.floating.filter((w) => w.tabs.length > 0);
  for (const window of layout.floating) if (!window.tabs.includes(window.active)) window.active = window.tabs[0]!;
  return layout;
}

/**
 * 整理读回来的布局：结构不对就用默认的；不认识的面板去掉，同一个面板只留第一次出现的；
 * 浮动窗挪回窗口里（至少露出标题栏）
 */
export function normalize(
  raw: unknown,
  known: { has(id: string): boolean },
  viewport: { width: number; height: number },
): DockLayout {
  if (!isLayout(raw)) return clone(DEFAULT_LAYOUT);
  const next = clone(raw);
  const seen = new Set<string>();
  const keep = (tabs: string[]): string[] =>
    tabs.filter((tab) => {
      if (!known.has(tab) || seen.has(tab)) return false;
      seen.add(tab);
      return true;
    });
  for (const zone of ZONES) {
    const z = next.zones[zone];
    z.size = Math.max(MIN_ZONE_SIZE * (zone === 'bottom' ? 0.5 : 1), Math.min(MAX_ZONE_SIZE, z.size));
    for (const group of z.groups) group.tabs = keep(group.tabs);
  }
  for (const window of next.floating) {
    window.tabs = keep(window.tabs);
    window.w = Math.max(MIN_FLOAT.w, Math.min(window.w, Math.max(MIN_FLOAT.w, viewport.width)));
    window.h = Math.max(MIN_FLOAT.h, Math.min(window.h, Math.max(MIN_FLOAT.h, viewport.height)));
    window.x = Math.min(Math.max(window.x, KEEP_VISIBLE - window.w), Math.max(0, viewport.width - KEEP_VISIBLE));
    window.y = Math.min(Math.max(window.y, 0), Math.max(0, viewport.height - TITLE_HEIGHT));
  }
  return tidy(next);
}

/** 把浮动窗挪回窗口里（浏览器窗口变小时） */
export function clampFloating(layout: DockLayout, viewport: { width: number; height: number }): DockLayout {
  let changed = false;
  const floating = layout.floating.map((w) => {
    const x = Math.min(Math.max(w.x, KEEP_VISIBLE - w.w), Math.max(0, viewport.width - KEEP_VISIBLE));
    const y = Math.min(Math.max(w.y, 0), Math.max(0, viewport.height - TITLE_HEIGHT));
    if (x === w.x && y === w.y) return w;
    changed = true;
    return { ...w, x, y };
  });
  return changed ? { ...layout, floating } : layout;
}

function isLayout(value: unknown): value is DockLayout {
  if (!isObject(value) || value.version !== 1 || !isObject(value.zones) || !Array.isArray(value.floating)) return false;
  const zones = value.zones as Record<string, unknown>;
  const isTabs = (tabs: unknown): boolean => Array.isArray(tabs) && tabs.every((t) => typeof t === 'string');
  for (const zone of ZONES) {
    const z = zones[zone];
    if (!isObject(z) || !isFinite(z.size) || typeof z.collapsed !== 'boolean' || !Array.isArray(z.groups)) return false;
    for (const g of z.groups as unknown[]) {
      if (
        !isObject(g) ||
        typeof g.id !== 'string' ||
        !isTabs(g.tabs) ||
        typeof g.active !== 'string' ||
        !isFinite(g.weight)
      ) {
        return false;
      }
    }
  }
  for (const w of value.floating as unknown[]) {
    if (!isObject(w) || typeof w.id !== 'string' || !isTabs(w.tabs) || typeof w.active !== 'string') return false;
    if (![w.x, w.y, w.w, w.h].every(isFinite) || typeof w.collapsed !== 'boolean') return false;
  }
  return typeof value.hidden === 'boolean';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

export const WORKSPACE_PRESETS = ['design', 'present', 'photo'] as const;
export type WorkspacePreset = (typeof WORKSPACE_PRESETS)[number];

/**
 * 工作区预设：设计（默认的布局）、演示（左边幻灯片，下方备注展开，右边属性和动画）、
 * 修图（右边属性，图片调整浮在画布右边）
 */
export function presetLayout(preset: WorkspacePreset, viewport: { width: number; height: number }): DockLayout {
  const base = clone(DEFAULT_LAYOUT);
  if (preset === 'present') {
    base.zones.left.groups = [
      { id: 'left-1', tabs: ['slides'], active: 'slides', weight: 1 },
      { id: 'left-2', tabs: ['layers', 'assets'], active: 'layers', weight: 0.6 },
    ];
    base.zones.right.groups = [
      { id: 'right-1', tabs: ['properties'], active: 'properties', weight: 1 },
      { id: 'right-2', tabs: ['inspector:animation'], active: 'inspector:animation', weight: 0.8 },
    ];
    base.zones.bottom.collapsed = false;
  } else if (preset === 'photo') {
    base.floating = [
      {
        id: 'photo-image',
        tabs: ['image'],
        active: 'image',
        x: Math.max(16, viewport.width - 320 - 300),
        y: 70,
        w: 320,
        h: Math.min(620, viewport.height - 100),
        collapsed: false,
      },
    ];
  }
  return base;
}
