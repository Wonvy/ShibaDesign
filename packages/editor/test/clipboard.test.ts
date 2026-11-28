import { beforeAll, describe, expect, it } from 'vitest';
import {
  createNode,
  isComponent,
  isInstance,
  rgba,
  slides,
  solid,
  translation,
  worldTransform,
  type ArtboardNode,
  type ColorStyleDef,
  type NodeId,
  type SceneNode,
} from '@shiba/core';
import type { CanvasKit } from '@shiba/renderer';
import {
  FragmentError,
  PASTE_OFFSET,
  copyFragment,
  fragmentFromHtml,
  fragmentToHtml,
  insertFragment,
  pasteFragment,
  pastePlainText,
  validateFragment,
  type ClipboardFragment,
} from '../src';
import { canvasKit, scene } from './helpers';

let ck: CanvasKit;
beforeAll(async () => {
  ck = await canvasKit();
});

/** 一张 1 × 1 的 PNG */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const offsetOf = (node: SceneNode | undefined): [number, number] => [node!.transform[4], node!.transform[5]];

function addBoard(s: ReturnType<typeof scene>, x: number, size: readonly [number, number]): NodeId {
  const deck = slides(s.store);
  return s.store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: s.store.root.id,
        index: s.store.indexOnTop(s.store.root.id),
        seq: 2,
        transform: translation(x, 0),
        size,
        fill: solid(rgba(1, 1, 1)),
        deck: { order: `${deck.at(-1)!.deck!.order}V`, notes: '' },
      }),
    ),
  ).id;
}

describe('复制粘贴：放在哪里', () => {
  it('粘回原来的画板：原件还在原处时往右下错开，连续粘贴越错越远，id 和血缘都是新的', () => {
    const s = scene(ck, [[100, 100, 50, 50]]);
    s.editor.select([s.rects[0]!]);
    const fragment = copyFragment(s.editor)!;
    const [first] = insertFragment(s.editor, fragment, { kind: 'auto' });
    const [second] = insertFragment(s.editor, fragment, { kind: 'auto' });
    expect(offsetOf(s.store.get(first!))).toEqual([100 + PASTE_OFFSET, 100 + PASTE_OFFSET]);
    expect(offsetOf(s.store.get(second!))).toEqual([100 + PASTE_OFFSET * 2, 100 + PASTE_OFFSET * 2]);
    expect(first).not.toBe(s.rects[0]);
    expect(s.store.get(first!)!.lineageId).not.toBe(s.store.get(s.rects[0]!)!.lineageId);
    expect(s.store.get(first!)!.parent).toBe(s.board);
    expect(s.editor.selection).toEqual([second]);
  });

  it('剪切后再粘贴：原件不在了，放回原处', () => {
    const s = scene(ck, [[100, 100, 50, 50]]);
    s.editor.select([s.rects[0]!]);
    const fragment = copyFragment(s.editor)!;
    s.editor.commands.run('edit.delete');
    const [pasted] = insertFragment(s.editor, fragment, { kind: 'auto' });
    expect(offsetOf(s.store.get(pasted!))).toEqual([100, 100]);
  });

  it('粘到一样大的另一页：保持在页面里的相对位置', () => {
    const s = scene(ck, [[300, 200, 50, 50]]);
    const other = addBoard(s, 1200, [1000, 600]);
    s.editor.select([s.rects[0]!]);
    const fragment = copyFragment(s.editor)!;
    s.editor.select([other]);
    const [pasted] = insertFragment(s.editor, fragment, { kind: 'auto' });
    expect(s.store.get(pasted!)!.parent).toBe(other);
    expect(offsetOf(s.store.get(pasted!))).toEqual([300, 200]);
  });

  it('粘到放不下的小画板：居中', () => {
    const s = scene(ck, [[800, 500, 100, 50]]);
    const small = addBoard(s, 1200, [400, 300]);
    s.editor.select([s.rects[0]!]);
    const fragment = copyFragment(s.editor)!;
    s.editor.select([small]);
    const [pasted] = insertFragment(s.editor, fragment, { kind: 'auto' });
    expect(offsetOf(s.store.get(pasted!))).toEqual([150, 125]);
  });

  it('原位粘贴保持世界坐标；粘贴到这里让中心落在那一点', () => {
    const s = scene(ck, [[100, 100, 50, 50]]);
    const other = addBoard(s, 1200, [400, 300]);
    s.editor.select([s.rects[0]!]);
    const fragment = copyFragment(s.editor)!;
    s.editor.select([other]);
    const [inPlace] = insertFragment(s.editor, fragment, { kind: 'inPlace' });
    expect(worldTransform(s.store, inPlace!).slice(4)).toEqual([100, 100]);
    const [here] = insertFragment(s.editor, fragment, { kind: 'at', point: { x: 500, y: 300 } });
    expect(worldTransform(s.store, here!).slice(4)).toEqual([475, 275]);
  });

  it('选中了对象时粘贴在它上面，层序紧挨着它', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
      [500, 100, 50, 50],
    ]);
    s.editor.select([s.rects[0]!]);
    const fragment = copyFragment(s.editor)!;
    const [pasted] = insertFragment(s.editor, fragment, { kind: 'auto' });
    const order = s.store.children(s.board).map((n) => n.id);
    expect(order.indexOf(pasted!)).toBe(1);
  });

  it('几个对象一起复制：保持彼此的位置和层序', () => {
    const s = scene(ck, [
      [100, 100, 50, 50],
      [300, 200, 50, 50],
    ]);
    s.editor.select([s.rects[1]!, s.rects[0]!]);
    const fragment = copyFragment(s.editor)!;
    expect(fragment.roots).toEqual([s.rects[0], s.rects[1]]);
    const pasted = insertFragment(s.editor, fragment, { kind: 'auto' });
    expect(pasted.map((id) => offsetOf(s.store.get(id)))).toEqual([
      [116, 116],
      [316, 216],
    ]);
  });
});

describe('复制粘贴：组件、样式、资源', () => {
  it('同一份文档里粘贴主组件，得到它的实例', () => {
    const s = scene(ck, [[100, 100, 50, 50]]);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('component.create');
    const main = s.editor.selection[0]!;
    expect(isComponent(s.store.get(main))).toBe(true);
    const fragment = copyFragment(s.editor)!;
    const [pasted] = insertFragment(s.editor, fragment, { kind: 'auto' });
    const node = s.store.get(pasted!);
    expect(isInstance(node) && node.instanceOf).toBe(main);
    expect(s.store.children(pasted!)).toHaveLength(1);
  });

  it('粘贴到别的文档：实例的主组件不在时分离；主组件和实例一起复制时实例跟着新的主组件', () => {
    const a = scene(ck, [[100, 100, 50, 50]]);
    a.editor.select([a.rects[0]!]);
    a.editor.commands.run('component.create');
    const main = a.editor.selection[0]!;
    a.editor.commands.run('component.place', { componentId: main, at: { x: 500, y: 300 } });
    const instance = a.editor.selection[0]!;

    const b = scene(ck, []);
    a.editor.select([instance]);
    const [alone] = insertFragment(b.editor, copyFragment(a.editor)!, { kind: 'auto' });
    expect(isInstance(b.store.get(alone!))).toBe(false);
    expect(b.store.children(alone!).every((n) => n.source === undefined)).toBe(true);

    a.editor.select([main, instance]);
    const pasted = insertFragment(b.editor, copyFragment(a.editor)!, { kind: 'auto' });
    const [newMain, newInstance] = pasted.map((id) => b.store.get(id));
    expect(isComponent(newMain)).toBe(true);
    expect(isInstance(newInstance) && newInstance.instanceOf).toBe(newMain!.id);
    const copy = b.store.children(newInstance!.id)[0]!;
    expect(copy.source).toBe(b.store.children(newMain!.id)[0]!.id);
  });

  it('单独复制实例里的对象：粘出来是普通对象', () => {
    const s = scene(ck, [[100, 100, 50, 50]]);
    s.editor.select([s.rects[0]!]);
    s.editor.commands.run('component.create');
    const main = s.editor.selection[0]!;
    s.editor.commands.run('component.place', { componentId: main, at: { x: 500, y: 300 } });
    const copy = s.store.children(s.editor.selection[0]!)[0]!;
    s.editor.select([copy.id]);
    const [pasted] = insertFragment(s.editor, copyFragment(s.editor)!, { kind: 'auto' });
    expect(s.store.get(pasted!)!.source).toBeUndefined();
    // 实例里不能加东西：粘到实例外面
    expect(s.store.get(pasted!)!.parent).toBe(s.board);
  });

  it('别的文档里没有链接的颜色样式：断开链接，颜色留着', () => {
    const a = scene(ck, [[100, 100, 50, 50]]);
    const style: ColorStyleDef = { id: 'brand', name: 'Brand', color: rgba(0, 0.5, 1) };
    a.store.transact('style', (tx) => {
      tx.update(a.store.root.id, { colorStyles: [style] });
      tx.update(a.rects[0]!, { fill: { type: 'solid', color: style.color, colorStyle: 'brand' } });
    });
    a.editor.select([a.rects[0]!]);
    const fragment = copyFragment(a.editor)!;
    const [same] = insertFragment(a.editor, fragment, { kind: 'auto' });
    expect((s(a.store.get(same!)).fill as { colorStyle?: string }).colorStyle).toBe('brand');
    const b = scene(ck, []);
    const [other] = insertFragment(b.editor, fragment, { kind: 'auto' });
    const fill = s(b.store.get(other!)).fill as { colorStyle?: string; color: unknown };
    expect(fill.colorStyle).toBeUndefined();
    expect(fill.color).toEqual(style.color);
  });

  it('图片跟着带到别的文档；太大没带的计数', async () => {
    const a = scene(ck, [[100, 100, 50, 50]]);
    const meta = (await a.editor.importImage(PNG, { mime: 'image/png' }))!;
    a.store.transact('fill', (tx) =>
      tx.update(a.rects[0]!, { fill: { type: 'image', assetId: meta.id, fit: 'fill', adjustments: {} } as never }),
    );
    a.editor.select([a.rects[0]!]);
    const fragment = copyFragment(a.editor)!;
    expect(fragment.assets[0]!.data).toBeTypeOf('string');
    const b = scene(ck, []);
    const result = await pasteFragment(b.editor, fragment);
    expect(result.missingAssets).toBe(0);
    expect(b.editor.assets.has(meta.id)).toBe(true);

    const stripped: ClipboardFragment = { ...fragment, assets: [{ meta: fragment.assets[0]!.meta }] };
    const c = scene(ck, []);
    expect((await pasteFragment(c.editor, stripped)).missingAssets).toBe(1);
  });
});

function s(node: SceneNode | undefined): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

describe('复制粘贴：幻灯片', () => {
  it('复制画板：新的一页排在当前页后面，放在已有画板右边，动画指向新的对象', () => {
    const st = scene(ck, [[100, 100, 50, 50]]);
    addBoard(st, 1200, [1000, 600]);
    st.editor.setActiveArtboard(st.board);
    st.editor.select([st.rects[0]!]);
    st.editor.commands.run('animation.add', { effect: 'entrance.fade' });
    st.editor.select([st.board]);
    const fragment = copyFragment(st.editor)!;
    const [board] = insertFragment(st.editor, fragment, { kind: 'auto' });
    const pasted = st.store.get(board!) as ArtboardNode;
    expect(slides(st.store).map((n) => n.id)).toEqual([st.board, board, expect.any(String)]);
    expect(pasted.transform[4]).toBe(1200 + 1000 + 80);
    const child = st.store.children(board!)[0]!;
    expect(pasted.deck!.animations!.map((a) => a.target)).toEqual([child.id]);
  });
});

describe('剪贴板数据', () => {
  it('写成 HTML 再读回来是一样的', () => {
    const st = scene(ck, [[100, 100, 50, 50]]);
    st.editor.select([st.rects[0]!]);
    const fragment = copyFragment(st.editor)!;
    const html = fragmentToHtml(fragment, '矩形 <1>');
    expect(html).toContain('矩形 &lt;1&gt;');
    expect(fragmentFromHtml(html)).toEqual(fragment);
    expect(fragmentFromHtml('<b>别的软件</b>')).toBeNull();
  });

  it('坏数据被拒绝：成环、画板不在最外层、不认识的资源类型', () => {
    const st = scene(ck, [[100, 100, 50, 50]]);
    st.editor.select([st.rects[0]!]);
    const good = copyFragment(st.editor)!;
    const rect = good.nodes[0]!;
    const cyclic = { ...good, nodes: [{ ...rect, parent: rect.id }] };
    expect(() => validateFragment(cyclic)).toThrow(FragmentError);
    const board = createNode('artboard', { parent: rect.id, index: 'a0', seq: 1, fill: null, deck: null });
    expect(() => validateFragment({ ...good, nodes: [rect, board] })).toThrow(FragmentError);
    const asset = { meta: { id: 'a'.repeat(40), mime: 'text/html', width: 1, height: 1, size: 1 } };
    expect(() => validateFragment({ ...good, assets: [asset] })).toThrow(FragmentError);
    expect(() => fragmentFromHtml('<span data-shibadesign-fragment="bm90IGpzb24="></span>')).toThrow(FragmentError);
  });
});

describe('复制属性、纯文字、创建副本', () => {
  it('复制属性再粘贴：填充、描边、不透明度、圆角套过去，文本只收纯色', () => {
    const st = scene(ck, [
      [100, 100, 50, 50],
      [300, 100, 50, 50],
    ]);
    st.store.transact('style', (tx) =>
      tx.update(st.rects[0]!, {
        fill: solid(rgba(0, 1, 0)),
        stroke: { color: rgba(0, 0, 1), width: 3 },
        opacity: 0.5,
        cornerRadius: 8,
      }),
    );
    st.editor.select([st.rects[0]!]);
    st.editor.commands.run('edit.copyProperties');
    st.editor.select([st.rects[1]!]);
    st.editor.commands.run('edit.pasteProperties');
    const target = s(st.store.get(st.rects[1]!));
    expect(target.fill).toEqual(solid(rgba(0, 1, 0)));
    expect(target.stroke).toEqual({ color: rgba(0, 0, 1), width: 3 });
    expect(target.opacity).toBe(0.5);
    expect(target.cornerRadius).toBe(8);
  });

  it('粘贴纯文字：建一个文本，长段落改成自动折行', () => {
    const st = scene(ck, []);
    st.editor.setActiveArtboard(st.board);
    const id = pastePlainText(st.editor, '第一行\r\n第二行')!;
    const node = st.store.get(id)!;
    expect(node.type === 'text' && node.text).toBe('第一行\n第二行');
    expect(node.type === 'text' && node.sizing).toBe('auto');
    expect(node.parent).toBe(st.board);
    const long = st.store.get(pastePlainText(st.editor, 'x'.repeat(200))!)!;
    expect(long.type === 'text' && long.sizing).toBe('fixed');
    expect(pastePlainText(st.editor, '   ')).toBeNull();
  });

  it('创建副本后挪一段再创建副本：按同样的偏移继续', () => {
    const st = scene(ck, [[100, 100, 50, 50]]);
    st.editor.select([st.rects[0]!]);
    st.editor.commands.run('edit.duplicate');
    const first = st.editor.selection[0]!;
    expect(offsetOf(st.store.get(first))).toEqual([116, 116]);
    st.store.transact('move', (tx) => tx.update(first, { transform: translation(200, 100) }));
    st.editor.commands.run('edit.duplicate');
    expect(offsetOf(st.store.get(st.editor.selection[0]!))).toEqual([300, 100]);
    st.editor.commands.run('edit.duplicate');
    expect(offsetOf(st.store.get(st.editor.selection[0]!))).toEqual([400, 100]);
    // 选区换了就恢复默认的错开
    st.editor.select([st.rects[0]!]);
    st.editor.commands.run('edit.duplicate');
    expect(offsetOf(st.store.get(st.editor.selection[0]!))).toEqual([116, 116]);
  });
});
