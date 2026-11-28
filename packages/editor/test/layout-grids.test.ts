import { beforeAll, describe, expect, it } from 'vitest';
import { defaultLayoutGrid } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { snapPoint } from '../src';
import { canvasKit, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

describe('版面网格的吸附', () => {
  it('显示着的列网格：列的两条边是吸附的候选；关掉显示、关掉这个网格时不吸', () => {
    const s = scene(ck, []);
    // 1000 宽的画板，4 列、间隔 20、边距 40：列从 40、275、510、745 开始，宽 215
    s.store.transact('grid', (tx) =>
      tx.update(s.board, { layoutGrids: [{ ...defaultLayoutGrid('columns'), count: 4, gutter: 20, margin: 40 }] }),
    );
    expect(s.editor.layoutGridContainers().map((c) => c.node.id)).toEqual([s.board]);
    const hit = snapPoint(s.editor.snapTargets([]), { x: 272, y: 333 }, { threshold: 5 });
    expect(hit.point.x).toBe(275);

    s.editor.setView({ layoutGrids: false });
    expect(snapPoint(s.editor.snapTargets([]), { x: 272, y: 333 }, { threshold: 5 }).point.x).toBe(272);
    s.editor.setView({ layoutGrids: true });
    s.store.transact('hide', (tx) =>
      tx.update(s.board, { layoutGrids: [{ ...defaultLayoutGrid('columns'), count: 4, hidden: true }] }),
    );
    expect(s.editor.layoutGridContainers()).toEqual([]);
  });

  it('画框上的行网格也吸，按画框在画布上的位置换算', () => {
    const s = scene(ck, []);
    s.editor.setTool('frame');
    const tool = s.editor.tool;
    const p = (x: number, y: number, down = true) => ({
      x,
      y,
      world: { x, y },
      shift: false,
      alt: false,
      mod: true,
      button: 0,
      down,
      space: false,
    });
    tool.onPointerDown!(p(100, 100), s.editor);
    tool.onPointerMove!(p(300, 300), s.editor);
    tool.onPointerUp!(p(300, 300, false), s.editor);
    const frame = s.editor.selection[0]!;
    s.store.transact('rows', (tx) =>
      tx.update(frame, { layoutGrids: [{ ...defaultLayoutGrid('rows'), count: 2, gutter: 0, margin: 0 }] }),
    );
    // 两行各 100 高，中线在画框里的 100，画布上的 200
    expect(snapPoint(s.editor.snapTargets([]), { x: 500, y: 203 }, { threshold: 5 }).point.y).toBe(200);
  });
});
