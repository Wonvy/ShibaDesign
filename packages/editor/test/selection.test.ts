import { beforeAll, describe, expect, it } from 'vitest';
import { rgba, solid, type SceneNode } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { DEFAULT_BINDINGS, dragRect, resizeBounds, steppedFontSize } from '../src';
import { canvasKit, pointer, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

const offset = (node: SceneNode | undefined): number[] => node!.transform.slice(4);

describe('选择命令', () => {
  it('选择父级、子级、下一个和上一个同级', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
      [500, 100, 50, 50],
    ]);
    s.editor.select([s.rects[0]!, s.rects[1]!]);
    s.editor.commands.run('group.create');
    const group = s.editor.selection[0]!;
    s.editor.commands.run('select.children');
    expect(new Set(s.editor.selection)).toEqual(new Set([s.rects[0], s.rects[1]]));
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('select.parent');
    expect(s.editor.selection).toEqual([group]);
    // 画板里现在是 [rect3, group]（层序从下到上：rect3 在 group 下面还是上面取决于编组位置）
    const order = s.store.children(s.board).map((n) => n.id);
    s.editor.select([order[0]!]);
    s.editor.commands.run('select.next');
    expect(s.editor.selection).toEqual([order[1]]);
    s.editor.commands.run('select.next');
    expect(s.editor.selection).toEqual([order[0]]);
    s.editor.commands.run('select.previous');
    expect(s.editor.selection).toEqual([order[1]]);
  });

  it('反选、全选同样填充、同一类型', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
      [500, 100, 50, 50],
    ]);
    s.store.transact('fill', (tx) => tx.update(s.rects[2]!, { fill: solid(rgba(0, 0, 1)) }));
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('select.same', 'fill');
    expect(new Set(s.editor.selection)).toEqual(new Set([s.rects[0], s.rects[1]]));
    s.editor.commands.run('select.inverse');
    expect(s.editor.selection).toEqual([s.rects[2]]);
    s.editor.commands.run('select.same', 'type');
    expect(s.editor.selection).toHaveLength(3);
    expect(s.editor.commands.canRun('select.same', 'font')).toBe(false);
  });

  it('锁定、隐藏来回切换；全部解锁、全部显示', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
    ]);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('node.toggleLock');
    expect(s.store.get(s.rects[0]!)!.locked).toBe(true);
    s.editor.commands.run('node.toggleLock');
    expect(s.store.get(s.rects[0]!)!.locked).toBe(false);
    s.editor.select([s.rects[0]!, s.rects[1]!]);
    s.editor.commands.run('node.toggleLock');
    s.editor.commands.run('node.toggleVisible');
    expect(s.rects.map((id) => [s.store.get(id)!.locked, s.store.get(id)!.visible])).toEqual([
      [true, false],
      [true, false],
    ]);
    s.editor.select([]);
    s.editor.commands.run('node.unlockAll');
    s.editor.commands.run('node.showAll');
    expect(s.rects.map((id) => [s.store.get(id)!.locked, s.store.get(id)!.visible])).toEqual([
      [false, true],
      [false, true],
    ]);
  });
});

describe('对象命令', () => {
  it('拼合：矩形换成同一个 id 的钢笔路径，填充不变', () => {
    const s = scene(ck, [[100, 100, 80, 40]]);
    s.store.transact('radius', (tx) => tx.update(s.rects[0]!, { cornerRadius: 10 }));
    const before = s.store.get(s.rects[0]!)!;
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('path.flatten');
    const after = s.store.get(s.rects[0]!)!;
    expect(after.type).toBe('path');
    expect(after.lineageId).toBe(before.lineageId);
    expect('fill' in after && after.fill).toEqual('fill' in before && before.fill);
    expect(s.editor.geometry.worldBounds(after)).toEqual(s.editor.geometry.worldBounds(before));
  });

  it('⌘ 方向键改大小、⌥ 方向键复制一份挪一下、创建或释放蒙版', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [120, 120, 50, 50],
    ]);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('edit.resize', { dw: 10, dh: 0 });
    s.editor.commands.run('edit.resize', { dw: 10, dh: -5 });
    expect(s.store.get(s.rects[0]!)!.size).toEqual([70, 45]);
    s.store.undo();
    expect(s.store.get(s.rects[0]!)!.size).toEqual([50, 50]);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('edit.duplicateNudge', { dx: 0, dy: 10 });
    const copy = s.editor.selection[0]!;
    expect(copy).not.toBe(s.rects[0]);
    expect(offset(s.store.get(copy))).toEqual([100, 110]);

    s.editor.select([s.rects[0]!, s.rects[1]!]);
    s.editor.commands.run('mask.toggle');
    const group = s.store.get(s.editor.selection[0]!)!;
    expect(group.type === 'group' && group.mask).toBe('shape');
    s.editor.commands.run('mask.toggle');
    const released = s.store.get(group.id)!;
    expect(released.type === 'group' && released.mask).toBeUndefined();
  });

  it('字号按档位跳', () => {
    expect(steppedFontSize(12, 1)).toBe(14);
    expect(steppedFontSize(13, -1)).toBe(12);
    expect(steppedFontSize(288, 1)).toBe(360);
    expect(steppedFontSize(6, -1)).toBe(5);
  });
});

describe('拖动的修饰键', () => {
  it('按住 Alt 拖动：原件不动，拖的是副本；中途松开 Alt 变回移动；一步撤销', () => {
    const s = scene(ck, [[100, 100, 100, 100]]);
    const select = s.editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 150, y: 150 }), s.editor);
    select.onPointerMove!(pointer({ x: 250, y: 150 }, { alt: true }), s.editor);
    const copy = s.editor.selection[0]!;
    expect(copy).not.toBe(s.rects[0]);
    expect(offset(s.store.get(copy))).toEqual([200, 100]);
    expect(offset(s.store.get(s.rects[0]!))).toEqual([100, 100]);

    select.onPointerMove!(pointer({ x: 260, y: 150 }), s.editor);
    expect(s.store.has(copy)).toBe(false);
    expect(s.editor.selection).toEqual([s.rects[0]]);
    expect(offset(s.store.get(s.rects[0]!))).toEqual([210, 100]);

    select.onPointerMove!(pointer({ x: 300, y: 150 }, { alt: true }), s.editor);
    select.onPointerUp!(pointer({ x: 300, y: 150 }, { alt: true, down: false }), s.editor);
    const final = s.editor.selection[0]!;
    expect(offset(s.store.get(final))).toEqual([250, 100]);
    expect(s.store.children(s.board)).toHaveLength(2);
    s.store.undo();
    expect(s.store.children(s.board)).toHaveLength(1);
    expect(offset(s.store.get(s.rects[0]!))).toEqual([100, 100]);
  });

  it('Alt 拖动中按 Esc：副本消失，选区回到原件', () => {
    const s = scene(ck, [[100, 100, 100, 100]]);
    const select = s.editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 150, y: 150 }), s.editor);
    select.onPointerMove!(pointer({ x: 250, y: 150 }, { alt: true }), s.editor);
    select.onCancel!(s.editor);
    expect(s.store.children(s.board)).toHaveLength(1);
    expect(s.editor.selection).toEqual([s.rects[0]]);
  });

  it('按住 Shift 移动锁定在 45° 的倍数上', () => {
    const s = scene(ck, [[100, 100, 100, 100]]);
    const select = s.editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 150, y: 150 }), s.editor);
    select.onPointerMove!(pointer({ x: 250, y: 240 }, { shift: true }), s.editor);
    const [x, y] = offset(s.store.get(s.rects[0]!));
    expect(x! - 100).toBeCloseTo(95);
    expect(y! - 100).toBeCloseTo(95);
    select.onPointerMove!(pointer({ x: 250, y: 160 }, { shift: true }), s.editor);
    expect(offset(s.store.get(s.rects[0]!))).toEqual([200, 100]);
  });

  it('⌘ 单击深选编组里的对象；⌘ 框选选成员；Alt 框选减选', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
      [500, 100, 50, 50],
    ]);
    s.editor.select([s.rects[0]!, s.rects[1]!]);
    s.editor.commands.run('group.create');
    const group = s.editor.selection[0]!;
    s.editor.select([]);
    const select = s.editor.tools.get('select')!;
    select.onPointerDown!(pointer({ x: 120, y: 120 }), s.editor);
    select.onPointerUp!(pointer({ x: 120, y: 120 }, { down: false }), s.editor);
    expect(s.editor.selection).toEqual([group]);
    s.editor.select([]);
    select.onPointerDown!(pointer({ x: 120, y: 120 }, { mod: true }), s.editor);
    select.onPointerUp!(pointer({ x: 120, y: 120 }, { mod: true, down: false }), s.editor);
    expect(s.editor.selection).toEqual([s.rects[0]]);

    s.editor.select([]);
    select.onPointerDown!(pointer({ x: 50, y: 50 }, { mod: true }), s.editor);
    select.onPointerMove!(pointer({ x: 600, y: 200 }, { mod: true }), s.editor);
    select.onPointerUp!(pointer({ x: 600, y: 200 }, { mod: true, down: false }), s.editor);
    expect(new Set(s.editor.selection)).toEqual(new Set(s.rects));

    select.onPointerDown!(pointer({ x: 450, y: 50 }, { alt: true }), s.editor);
    select.onPointerMove!(pointer({ x: 600, y: 200 }, { alt: true }), s.editor);
    select.onPointerUp!(pointer({ x: 600, y: 200 }, { alt: true, down: false }), s.editor);
    expect(new Set(s.editor.selection)).toEqual(new Set([s.rects[0], s.rects[1]]));
  });

  it('画矩形：Alt 从中心画，拖动中按住空格挪动正在画的形状', () => {
    expect(dragRect({ x: 100, y: 100 }, { x: 150, y: 120 }, false, true)).toEqual({ x: 50, y: 80, w: 100, h: 40 });
    expect(dragRect({ x: 100, y: 100 }, { x: 150, y: 120 }, true, true)).toEqual({ x: 50, y: 50, w: 100, h: 100 });
    const s = scene(ck, []);
    const tool = s.editor.tools.get('rect')!;
    tool.onPointerDown!(pointer({ x: 100, y: 100 }), s.editor);
    tool.onPointerMove!(pointer({ x: 200, y: 150 }), s.editor);
    tool.onPointerMove!(pointer({ x: 260, y: 170 }, { space: true }), s.editor);
    tool.onPointerUp!(pointer({ x: 260, y: 170 }, { down: false }), s.editor);
    const rect = s.store.children(s.board)[0]!;
    expect(offset(rect)).toEqual([160, 120]);
    expect(rect.size).toEqual([100, 50]);
  });

  it('缩放时按住 Alt 中心不动', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(resizeBounds(box, 'e', { x: 120, y: 0 }, false, true)).toEqual({ x: -20, y: 0, w: 140, h: 50 });
    expect(resizeBounds(box, 'se', { x: 100, y: 100 }, true, true)).toEqual({ x: -100, y: -50, w: 300, h: 150 });
  });
});

describe('快捷键表', () => {
  it('每条绑定都指向已经注册的命令（界面层注册的几个除外）', () => {
    const s = scene(ck, []);
    const fromWeb = new Set([
      'edit.copyAsPng',
      'present.play',
      'present.playFromStart',
      'node.rename',
      'help.commandPalette',
      'help.shortcuts',
    ]);
    const missing = DEFAULT_BINDINGS.filter((b) => !fromWeb.has(b.command) && !s.editor.commands.has(b.command));
    expect(missing).toEqual([]);
  });

  it('没有重复的按键', () => {
    const keys = DEFAULT_BINDINGS.map((b) => b.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});
