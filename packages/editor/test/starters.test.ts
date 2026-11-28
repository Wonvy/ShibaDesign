import { beforeAll, describe, expect, it } from 'vitest';
import { slides, type PathNode } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import type { IconNode } from '../src';
import { canvasKit, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

/** 图标库里的格式：一个圆、一条折线、一个圆角矩形、一条直线、一段 path */
const ICON: IconNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['polyline', { points: '8 12 11 15 16 9' }],
  ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }],
  ['line', { x1: '2', y1: '22', x2: '22', y2: '22' }],
  ['path', { d: 'M12 2v4' }],
];

describe('插入图标', () => {
  it('图标的几段合成一条路径：放大一倍，描边圆头圆角、线宽跟着放大，没有填充；放在指定的位置', () => {
    const s = scene(ck, []);
    s.editor.setViewMode('slides');
    s.editor.commands.run('icon.insert', { name: 'check-circle', node: ICON, at: { x: 500, y: 300 } });
    const path = s.store.get(s.editor.selection[0]!) as PathNode;
    expect(path).toMatchObject({ type: 'path', name: 'check-circle', parent: s.board, size: [48, 48], fill: null });
    expect(path.stroke).toMatchObject({ width: 4, cap: 'round', join: 'round' });
    expect(path.transform).toEqual([1, 0, 0, 1, 476, 276]);
    // 圆、折线、圆角矩形、直线、path 各一段
    expect(path.subpaths).toHaveLength(5);
    expect(path.subpaths[0]!.closed).toBe(true);
    expect(path.subpaths[1]!.closed).toBe(false);
    // 直线从 (2,22) 到 (22,22)，放大一倍
    const line = path.subpaths[3]!.anchors;
    expect([line[0]!.x, line[0]!.y, line[1]!.x, line[1]!.y]).toEqual([4, 44, 44, 44]);
    s.store.undo();
    expect(s.store.get(path.id)).toBeUndefined();
  });
});

describe('画框的预设尺寸', () => {
  it('幻灯片视图里放在这一页中间（画框）；画布视图里放在最右边（新的一页）', () => {
    const s = scene(ck, []);
    s.editor.setViewMode('slides');
    s.editor.setTool('frame');
    s.editor.commands.run('frame.place', { size: [393, 852], name: '手机' });
    const frame = s.store.get(s.editor.selection[0]!)!;
    expect(frame).toMatchObject({ type: 'frame', name: '手机', parent: s.board, size: [393, 852] });
    expect(frame.transform[4]).toBeCloseTo((1000 - 393) / 2, 9);
    expect(s.editor.tool.id).toBe('select');

    s.editor.setViewMode('canvas');
    s.editor.commands.run('frame.place', { size: [1440, 1024], name: '桌面' });
    const board = s.store.get(s.editor.selection[0]!)!;
    expect(board).toMatchObject({ type: 'artboard', name: '桌面', size: [1440, 1024] });
    expect(board.transform[4]).toBeGreaterThan(1000);
    expect(slides(s.store).at(-1)?.id).toBe(board.id);
  });
});
