import { beforeAll, describe, expect, it } from 'vitest';
import { translation } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { canvasKit, pointer, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

describe('拖动到一半取消', () => {
  it('移动：对象回到原处，撤销历史里没有这一步', () => {
    const { editor, store, rects } = scene(ck);
    const select = editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 150, y: 150 }), editor);
    select.onPointerMove!(pointer({ x: 200, y: 180 }), editor);
    expect(store.require(rects[0]!).transform).toEqual(translation(150, 130));
    select.onCancel!(editor);
    expect(store.require(rects[0]!).transform).toEqual(translation(100, 100));
    // 剩下的撤销是创建矩形那一步
    store.undo();
    expect(store.has(rects[0]!)).toBe(false);
  });

  it('框选：换回按下鼠标之前的选区', () => {
    const { editor, rects } = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
    ]);
    editor.select([rects[0]!]);
    const select = editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 250, y: 50 }), editor);
    select.onPointerMove!(pointer({ x: 400, y: 200 }), editor);
    expect(editor.selection).toEqual([rects[1]]);
    select.onCancel!(editor);
    expect(editor.selection).toEqual([rects[0]]);
  });

  it('画矩形：已经画出来的形状撤掉', () => {
    const { editor, store, board } = scene(ck, []);
    const tool = editor.tools.get('rect')!;
    tool.onPointerDown!(pointer({ x: 100, y: 100 }), editor);
    tool.onPointerMove!(pointer({ x: 200, y: 200 }), editor);
    expect(store.children(board)).toHaveLength(1);
    tool.onCancel!(editor);
    expect(store.children(board)).toHaveLength(0);
    expect(store.canUndo).toBe(true); // 只剩创建画板那一步
    store.undo();
    expect(store.canUndo).toBe(false);
  });
});
