import { beforeAll, describe, expect, it } from 'vitest';
import { createNode, rgba, slides, solid, translation, type ArtboardNode, type NodeId } from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { canvasKit, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

function addBoard(s: ReturnType<typeof scene>, x: number): NodeId {
  const deck = slides(s.store);
  return s.store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: s.store.root.id,
        index: s.store.indexOnTop(s.store.root.id),
        seq: 2,
        transform: translation(x, 0),
        size: [1000, 600],
        fill: solid(rgba(1, 1, 1)),
        deck: { order: `${deck.at(-1)!.deck!.order}V`, notes: '' },
      }),
    ),
  ).id;
}

describe('右键点到了什么', () => {
  it('没选中的对象：先选中它；已经选中的多个：保持；画板空白处、画布空白处：取消选区', () => {
    const s = scene(ck, [
      [100, 100, 100, 100],
      [150, 150, 100, 100],
      [500, 100, 50, 50],
    ]);
    const hit = s.editor.contextAt(120, 120);
    expect(hit.target).toEqual({ kind: 'object', ids: [s.rects[0]] });
    s.editor.select([s.rects[0]!, s.rects[2]!]);
    expect(s.editor.contextAt(520, 120).target).toEqual({ kind: 'object', ids: [s.rects[0], s.rects[2]] });
    // 选区框里的空白处也算点在选区上
    expect(s.editor.contextAt(400, 120).target.kind).toBe('object');
    expect(s.editor.contextAt(800, 500).target).toEqual({ kind: 'artboard', id: s.board });
    expect(s.editor.selection).toEqual([]);
    expect(s.editor.contextAt(1500, 900).target).toEqual({ kind: 'canvas' });
  });

  it('鼠标下所有重叠的对象，从上到下', () => {
    const s = scene(ck, [
      [100, 100, 100, 100],
      [150, 150, 100, 100],
    ]);
    expect(s.editor.contextAt(170, 170).stack).toEqual([s.rects[1], s.rects[0]]);
  });
});

describe('整理类命令', () => {
  it('移到幻灯片：保持相对位置，去掉原来那一页的动画', () => {
    const s = scene(ck, [[100, 120, 50, 50]]);
    const other = addBoard(s, 1200);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('animation.add', { effect: 'entrance.fade' });
    s.editor.commands.run('arrange.moveToSlide', other);
    const node = s.store.get(s.rects[0]!)!;
    expect(node.parent).toBe(other);
    expect(node.transform.slice(4)).toEqual([100, 120]);
    expect((s.store.get(s.board) as ArtboardNode).deck!.animations ?? []).toEqual([]);
  });

  it('调幻灯片顺序、设为或取消幻灯片', () => {
    const s = scene(ck, []);
    const second = addBoard(s, 1200);
    const third = addBoard(s, 2400);
    s.editor.commands.run('artboard.move', { id: third, to: 'start' });
    expect(slides(s.store).map((n) => n.id)).toEqual([third, s.board, second]);
    expect(s.editor.commands.canRun('artboard.move', { id: third, to: 'up' })).toBe(false);
    s.editor.commands.run('artboard.move', { id: s.board, to: 'down' });
    expect(slides(s.store).map((n) => n.id)).toEqual([third, second, s.board]);
    s.editor.commands.run('artboard.toggleSlide', second);
    expect(slides(s.store).map((n) => n.id)).toEqual([third, s.board]);
    s.editor.commands.run('artboard.toggleSlide', second);
    expect(slides(s.store).at(-1)!.id).toBe(second);
  });

  it('画板适应内容：大小正好框住对象，对象在画布上不动', () => {
    const s = scene(ck, [
      [100, 50, 100, 100],
      [400, 300, 50, 50],
    ]);
    const before = s.rects.map((id) => s.editor.geometry.worldBounds(s.store.get(id)!));
    s.editor.commands.run('artboard.fitContent', s.board);
    const board = s.store.get(s.board)!;
    expect(board.size).toEqual([350, 300]);
    expect(board.transform.slice(4)).toEqual([100, 50]);
    expect(s.rects.map((id) => s.editor.geometry.worldBounds(s.store.get(id)!))).toEqual(before);
  });

  it('只显示这个：再点一次全部显示回来', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
      [500, 100, 50, 50],
    ]);
    s.editor.commands.run('node.solo', s.rects[1]);
    expect(s.rects.map((id) => s.store.get(id)!.visible)).toEqual([false, true, false]);
    s.editor.commands.run('node.solo', s.rects[1]);
    expect(s.rects.map((id) => s.store.get(id)!.visible)).toEqual([true, true, true]);
  });

  it('按样式选择', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
    ]);
    s.store.transact('link', (tx) => {
      tx.update(s.store.root.id, { colorStyles: [{ id: 'ink', name: 'Ink', color: rgba(0, 0, 0) }] });
      tx.update(s.rects[1]!, { stroke: { color: rgba(0, 0, 0), width: 1, colorStyle: 'ink' } });
    });
    s.editor.commands.run('select.byStyle', 'ink');
    expect(s.editor.selection).toEqual([s.rects[1]]);
  });
});
