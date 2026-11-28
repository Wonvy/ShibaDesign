import { beforeAll, describe, expect, it } from 'vitest';
import { DocStore, validateDocument, type ArtboardNode, type Guide } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { canvasKit, pointer, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

const guidesOf = (s: ReturnType<typeof scene>, id: string): readonly Guide[] =>
  (s.store.get(id) as { guides?: readonly Guide[] }).guides ?? [];

describe('拖动时吸附', () => {
  it('挪到别的对象的边附近时对齐过去，拖动中有参考线，松手后去掉；按着 ⌘ 不吸', () => {
    const s = scene(ck, [
      [100, 100, 100, 100],
      [400, 300, 50, 50],
    ]);
    const select = s.editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 420, y: 320 }), s.editor);
    // 左边从 400 挪到 197：离第一个矩形的右边 200 差 3
    select.onPointerMove!(pointer({ x: 217, y: 320 }), s.editor);
    expect(s.store.get(s.rects[1]!)!.transform[4]).toBe(200);
    expect(s.editor.snapFeedback?.lines.length).toBeGreaterThan(0);
    select.onPointerMove!(pointer({ x: 217, y: 320 }, { mod: true }), s.editor);
    expect(s.store.get(s.rects[1]!)!.transform[4]).toBe(197);
    expect(s.editor.snapFeedback).toBeNull();
    select.onPointerUp!(pointer({ x: 217, y: 320 }, { mod: true, down: false }), s.editor);
    expect(s.editor.snapFeedback).toBeNull();
  });

  it('关掉吸附开关就不吸；吸附到像素时位置取整', () => {
    const s = scene(ck, [
      [100, 100, 100, 100],
      [400, 300, 50, 50],
    ]);
    s.editor.commands.run('view.toggle', 'snapObjects');
    s.editor.commands.run('view.toggle', 'snapGuides');
    expect(s.editor.snapping).toBe(false);
    const select = s.editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 420, y: 320 }), s.editor);
    select.onPointerMove!(pointer({ x: 217, y: 320 }), s.editor);
    expect(s.store.get(s.rects[1]!)!.transform[4]).toBe(197);
    select.onPointerUp!(pointer({ x: 217, y: 320 }, { down: false }), s.editor);

    s.editor.commands.run('view.toggle', 'snapPixels');
    select.onPointerDown!(pointer({ x: 220, y: 320 }), s.editor);
    select.onPointerMove!(pointer({ x: 240.4, y: 330.7 }), s.editor);
    const [x, y] = s.store.get(s.rects[1]!)!.transform.slice(4);
    expect([x, y]).toEqual([217, 311]);
  });

  it('画矩形时起点和终点都吸附', () => {
    const s = scene(ck, [[100, 100, 100, 100]]);
    const tool = s.editor.tools.get('rect')!;
    tool.onPointerDown!(pointer({ x: 202, y: 402 }), s.editor);
    tool.onPointerMove!(pointer({ x: 297, y: 498 }), s.editor);
    tool.onPointerUp!(pointer({ x: 297, y: 498 }, { down: false }), s.editor);
    const rect = s.store.children(s.board).at(-1)!;
    // 起点吸到第一个矩形的右边（x 200）；终点附近没有可以吸的线，保持原样
    expect(rect.transform.slice(4)).toEqual([200, 402]);
    expect(rect.size).toEqual([97, 96]);
  });
});

describe('辅助线', () => {
  it('从标尺上拖出来放进画板，拖动改位置，拖回标尺上删除，一步撤销', () => {
    const s = scene(ck, [[100, 100, 50, 50]]);
    s.editor.setView({ rulers: true });
    const guides = s.editor.guides;
    const ruler = guides.hit(500, 10);
    expect(ruler).toEqual({ kind: 'ruler', axis: 'y' });
    guides.begin(ruler!, pointer({ x: 500, y: 10 }));
    guides.move(pointer({ x: 500, y: 251 }, { mod: true }));
    expect(guides.pending).toEqual({ axis: 'y', value: 251 });
    guides.end(pointer({ x: 500, y: 251 }, { down: false }));
    expect(guidesOf(s, s.board)).toEqual([{ id: expect.any(String), axis: 'y', offset: 251 }]);

    const hit = guides.hit(600, 252);
    expect(hit?.kind).toBe('guide');
    guides.begin(hit!, pointer({ x: 600, y: 252 }));
    guides.move(pointer({ x: 600, y: 270 }, { mod: true }));
    guides.end(pointer({ x: 600, y: 270 }, { down: false }));
    expect(guidesOf(s, s.board)[0]!.offset).toBe(270);

    guides.begin(guides.hit(600, 270)!, pointer({ x: 600, y: 270 }));
    guides.move(pointer({ x: 600, y: 8 }, { mod: true }));
    guides.end(pointer({ x: 600, y: 8 }, { down: false }));
    expect(guidesOf(s, s.board)).toEqual([]);
    s.store.undo();
    expect(guidesOf(s, s.board)[0]!.offset).toBe(270);
  });

  it('画板外的辅助线属于页面；按着 Alt 换方向；按着 Shift 吸附到刻度', () => {
    const s = scene(ck, []);
    s.editor.setView({ rulers: true });
    const guides = s.editor.guides;
    guides.begin({ kind: 'ruler', axis: 'y' }, pointer({ x: 500, y: 10 }));
    guides.move(pointer({ x: 1203, y: 700 }, { alt: true, shift: true }));
    guides.end(pointer({ x: 1203, y: 700 }, { alt: true, shift: true, down: false }));
    const page = s.store.root as { guides?: readonly Guide[] };
    expect(page.guides).toEqual([{ id: expect.any(String), axis: 'x', offset: 1200 }]);
  });

  it('移动对象时吸附到辅助线；锁定后点不中；选中按删除', () => {
    const s = scene(ck, [[100, 100, 50, 50]]);
    s.store.transact('guide', (tx) => tx.update(s.board, { guides: [{ id: 'g', axis: 'x', offset: 300 }] }));
    const select = s.editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 120, y: 120 }), s.editor);
    select.onPointerMove!(pointer({ x: 318, y: 120 }), s.editor);
    expect(s.store.get(s.rects[0]!)!.transform[4]).toBe(300);
    select.onPointerUp!(pointer({ x: 318, y: 120 }, { down: false }), s.editor);

    s.editor.commands.run('view.toggle', 'guidesLocked');
    expect(s.editor.guides.hit(300, 400)).toBeNull();
    s.editor.commands.run('view.toggle', 'guidesLocked');
    const hit = s.editor.guides.hit(300, 400)!;
    s.editor.guides.begin(hit, pointer({ x: 300, y: 400 }));
    s.editor.guides.end(pointer({ x: 300, y: 400 }, { down: false }));
    expect(s.editor.guides.selection).toEqual({ container: s.board, id: 'g' });
    expect(s.editor.guides.removeSelected()).toBe(true);
    expect(guidesOf(s, s.board)).toEqual([]);
  });

  it('命令：改位置、清除；右键点到辅助线；复制这一页时辅助线跟着走；文件校验', () => {
    const s = scene(ck, []);
    s.store.transact('guide', (tx) =>
      tx.update(s.board, {
        guides: [
          { id: 'a', axis: 'x', offset: 100 },
          { id: 'b', axis: 'y', offset: 50 },
        ],
      }),
    );
    s.editor.commands.run('guides.set', { container: s.board, id: 'a', offset: 120 });
    expect(guidesOf(s, s.board)[0]!.offset).toBe(120);
    expect(s.editor.contextAt(120, 300).target).toEqual({ kind: 'guide', container: s.board, id: 'a' });
    s.editor.commands.run('artboard.duplicate', s.board);
    const copy = s.store.children(s.store.root.id).find((n) => n.id !== s.board) as ArtboardNode;
    expect(copy.guides).toHaveLength(2);
    s.editor.commands.run('guides.clear', s.board);
    expect(guidesOf(s, s.board)).toEqual([]);

    const data = s.store.toJSON();
    const bad = structuredClone(data) as unknown as { nodes: Record<string, Record<string, unknown>> };
    bad.nodes[s.board]!.guides = [{ id: 'x', axis: 'z', offset: 1 }];
    expect(() => validateDocument(bad)).toThrow();
    expect(() => DocStore.fromJSON(data)).not.toThrow();
  });
});
