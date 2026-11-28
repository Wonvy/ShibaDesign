import { beforeAll, describe, expect, it } from 'vitest';
import {
  createNode,
  rgba,
  slides,
  solid,
  translation,
  validateDocument,
  type ArtboardNode,
  type NodeId,
} from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import { playableSlides } from '../src';
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

const world = (s: ReturnType<typeof scene>, id: NodeId) => s.editor.geometry.worldBounds(s.store.get(id)!);

describe('图层面板里拖动', () => {
  it('调整层序：放在某个同级的上面，在画布上不动', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [200, 100, 50, 50],
      [300, 100, 50, 50],
    ]);
    // 把最下面的挪到最上面
    s.editor.commands.run('node.moveTo', { ids: [s.rects[0]], parent: s.board, above: s.rects[2] });
    expect(s.store.children(s.board).map((n) => n.id)).toEqual([s.rects[1], s.rects[2], s.rects[0]]);
    // 放到最下面
    s.editor.commands.run('node.moveTo', { ids: [s.rects[0]], parent: s.board, above: null });
    expect(s.store.children(s.board).map((n) => n.id)).toEqual([s.rects[0], s.rects[1], s.rects[2]]);
  });

  it('拖进编组：在画布上的位置不变；不能拖进自己的子孙；Alt 是复制', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [200, 100, 50, 50],
      [400, 300, 50, 50],
    ]);
    s.editor.select([s.rects[0]!, s.rects[1]!]);
    s.editor.commands.run('group.create');
    const group = s.editor.selection[0]!;
    const before = world(s, s.rects[2]!);
    s.editor.commands.run('node.moveTo', { ids: [s.rects[2]], parent: group, above: null });
    expect(s.store.get(s.rects[2]!)!.parent).toBe(group);
    expect(world(s, s.rects[2]!)).toEqual(before);
    expect(s.editor.commands.canRun('node.moveTo', { ids: [group], parent: group, above: null })).toBe(false);
    expect(s.editor.commands.canRun('node.moveTo', { ids: [group], parent: s.rects[0], above: null })).toBe(false);

    s.editor.commands.run('node.moveTo', { ids: [s.rects[2]], parent: s.board, above: group, copy: true });
    const copy = s.editor.selection[0]!;
    expect(copy).not.toBe(s.rects[2]);
    expect(s.store.get(copy)!.parent).toBe(s.board);
    expect(s.store.get(s.rects[2]!)!.parent).toBe(group);
  });

  it('画板只能在页面上', () => {
    const s = scene(ck, [[100, 100, 50, 50]]);
    const other = addBoard(s, 1200);
    expect(s.editor.commands.canRun('node.moveTo', { ids: [other], parent: s.board, above: null })).toBe(false);
  });
});

describe('幻灯片条里拖动、隐藏', () => {
  it('挪到某个位置、多页一起挪、Alt 复制', () => {
    const s = scene(ck, []);
    const b = addBoard(s, 1200);
    const c = addBoard(s, 2400);
    const a = s.board;
    s.editor.commands.run('artboard.reorder', { ids: [c], index: 0 });
    expect(slides(s.store).map((n) => n.id)).toEqual([c, a, b]);
    s.editor.commands.run('artboard.reorder', { ids: [c, a], index: 1 });
    expect(slides(s.store).map((n) => n.id)).toEqual([b, c, a]);
    s.editor.commands.run('artboard.reorder', { ids: [b], index: 3, copy: true });
    const order = slides(s.store).map((n) => n.id);
    expect(order).toHaveLength(4);
    expect(order.slice(0, 3)).toEqual([b, c, a]);
  });

  it('隐藏幻灯片：演示时跳过，编辑时还在；文件校验', () => {
    const s = scene(ck, []);
    const b = addBoard(s, 1200);
    s.editor.commands.run('artboard.toggleSkip', [b]);
    expect((s.store.get(b) as ArtboardNode).deck!.skip).toBe(true);
    expect(playableSlides(s.editor).map((n) => n.id)).toEqual([s.board]);
    expect(slides(s.store)).toHaveLength(2);
    s.editor.commands.run('artboard.toggleSkip', [b]);
    expect((s.store.get(b) as ArtboardNode).deck!.skip).toBeUndefined();

    const data = s.store.toJSON() as unknown as { nodes: Record<string, { deck: Record<string, unknown> }> };
    data.nodes[b]!.deck.skip = 'yes';
    expect(() => validateDocument(data)).toThrow();
  });
});
