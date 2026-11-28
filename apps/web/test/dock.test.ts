import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  activateTab,
  closeTab,
  findTab,
  isTabVisible,
  moveTab,
  normalize,
  openTab,
  setGroupWeights,
  setZoneSize,
  toggleTab,
  type DockLayout,
} from '../src/dock/layout';

const KNOWN = new Set(['slides', 'layers', 'assets', 'properties', 'inspect', 'notes', 'image']);
const VIEW = { width: 1400, height: 900 };

describe('面板布局', () => {
  it('在同一组里调整顺序', () => {
    const next = moveTab(DEFAULT_LAYOUT, 'slides', { kind: 'tabs', group: 'left-1', index: 3 });
    expect(next.zones.left.groups[0]!.tabs).toEqual(['layers', 'assets', 'slides']);
    expect(next.zones.left.groups[0]!.active).toBe('slides');
  });

  it('并进别的组；原来的组空了就去掉', () => {
    const moved = moveTab(DEFAULT_LAYOUT, 'properties', { kind: 'tabs', group: 'left-1', index: 1 });
    expect(moved.zones.left.groups[0]!.tabs).toEqual(['slides', 'properties', 'layers', 'assets']);
    // 右边还剩"检查"；把它也挪走，右边的组就空了，去掉
    expect(moved.zones.right.groups[0]!.tabs).toEqual(['inspect']);
    const next = moveTab(moved, 'inspect', { kind: 'tabs', group: 'left-1', index: 2 });
    expect(next.zones.right.groups).toEqual([]);
  });

  it('拆出新组、变成浮动窗、关掉', () => {
    const split = moveTab(DEFAULT_LAYOUT, 'assets', { kind: 'split', zone: 'left', index: 1 });
    expect(split.zones.left.groups.map((g) => g.tabs)).toEqual([['slides', 'layers'], ['assets']]);
    const floated = moveTab(split, 'layers', { kind: 'float', x: 300, y: 100, w: 260, h: 400 });
    expect(floated.floating).toHaveLength(1);
    expect(floated.floating[0]!.tabs).toEqual(['layers']);
    expect(findTab(floated, 'layers')?.kind).toBe('float');
    const closed = closeTab(floated, 'layers');
    expect(closed.floating).toEqual([]);
    expect(findTab(closed, 'layers')).toBeNull();
    // 原来的布局没被改
    expect(DEFAULT_LAYOUT.zones.left.groups[0]!.tabs).toEqual(['slides', 'layers', 'assets']);
  });

  it('打开、切换、来回开关；收起的停靠区打开时展开', () => {
    expect(isTabVisible(DEFAULT_LAYOUT, 'notes')).toBe(false);
    const shown = activateTab(DEFAULT_LAYOUT, 'notes');
    expect(shown.zones.bottom.collapsed).toBe(false);
    expect(isTabVisible(shown, 'notes')).toBe(true);
    const image = openTab(DEFAULT_LAYOUT, 'image', { float: { x: 100, y: 100, w: 300, h: 500 } });
    expect(image.floating[0]!.tabs).toEqual(['image']);
    expect(toggleTab(image, 'image', { zone: 'right' }).floating).toEqual([]);
    const layers = toggleTab(DEFAULT_LAYOUT, 'layers', { zone: 'left' });
    expect(findTab(layers, 'layers')).toBeNull();
  });

  it('停靠区大小和面板组比例有上下限', () => {
    expect(setZoneSize(DEFAULT_LAYOUT, 'left', 20).zones.left.size).toBe(180);
    expect(setZoneSize(DEFAULT_LAYOUT, 'right', 5000).zones.right.size).toBe(640);
    const split = moveTab(DEFAULT_LAYOUT, 'assets', { kind: 'split', zone: 'left', index: 1 });
    expect(setGroupWeights(split, 'left', [0.7, 0]).zones.left.groups.map((g) => g.weight)).toEqual([0.7, 0.1]);
  });

  it('整理读回来的布局：坏数据用默认的，不认识和重复的面板去掉，浮动窗挪回窗口里', () => {
    expect(normalize(null, KNOWN, VIEW)).toEqual(DEFAULT_LAYOUT);
    expect(normalize({ version: 2 }, KNOWN, VIEW)).toEqual(DEFAULT_LAYOUT);
    const raw = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)) as DockLayout;
    raw.zones.left.groups[0]!.tabs = ['slides', 'mystery', 'layers', 'slides'];
    raw.floating.push({
      id: 'f',
      tabs: ['layers', 'image'],
      active: 'layers',
      x: 5000,
      y: -50,
      w: 300,
      h: 300,
      collapsed: false,
    });
    const fixed = normalize(raw, KNOWN, VIEW);
    expect(fixed.zones.left.groups[0]!.tabs).toEqual(['slides', 'layers']);
    expect(fixed.floating[0]!.tabs).toEqual(['image']);
    expect(fixed.floating[0]!.active).toBe('image');
    expect(fixed.floating[0]!.x).toBeLessThanOrEqual(1400 - 48);
    expect(fixed.floating[0]!.y).toBe(0);
  });
});
