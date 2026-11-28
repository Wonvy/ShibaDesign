import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { DocStore, createNode, keyBetween, rgba, solid, translation, type NodeId } from '@shiba/core';
import { createEditor } from '@shiba/editor';
import { loadCanvasKit, type CanvasKit } from '@shiba/renderer';
import { prototypeLinks } from '../src/present/compile';

const require = createRequire(import.meta.url);
let ck: CanvasKit;
beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

/** 三页幻灯片排成一行，第二页隐藏；第一页上一个按钮在编组里 */
function setup() {
  const store = DocStore.create();
  const boards: NodeId[] = [];
  let order: string | null = null;
  store.transact('boards', (tx) => {
    for (let i = 0; i < 3; i++) {
      order = keyBetween(order, null);
      boards.push(
        tx.create(
          createNode('artboard', {
            parent: store.root.id,
            index: `a${i}`,
            seq: i + 1,
            transform: translation(i * 2000, 500),
            size: [1280, 720],
            fill: solid(rgba(1, 1, 1)),
            deck: { order, notes: '', ...(i === 1 ? { skip: true } : {}) },
          }),
        ).id,
      );
    }
  });
  const editor = createEditor({
    ck,
    store,
    theme: { background: rgba(0, 0, 0), accent: '#00f', label: '#888', handleFill: '#fff' },
    defaultFonts: { latin: 'Inter', cjk: 'Noto Sans SC' },
  });
  return { store, editor, boards };
}

describe('原型的热区', () => {
  it('每页的热区：编组里的也算，按页上的位置；目标页按实际播放的页数；目标页隐藏了跳过；返回是 -1', () => {
    const { store, editor, boards } = setup();
    const [first, hidden, last] = boards as [NodeId, NodeId, NodeId];
    store.transact('buttons', (tx) => {
      const group = tx.create(
        createNode('group', { parent: first, index: 'a0', seq: 1, transform: translation(100, 50) }),
      );
      tx.create(
        createNode('rect', {
          parent: group.id,
          index: 'a0',
          seq: 1,
          transform: translation(20, 30),
          size: [200, 60],
          cornerRadius: 0,
          fill: solid(rgba(0, 0, 1)),
          stroke: null,
          interactions: [
            {
              trigger: 'click',
              action: { type: 'navigate', target: last },
              transition: { effect: 'push', duration: 300 },
            },
          ],
        }),
      );
      tx.create(
        createNode('rect', {
          parent: first,
          index: 'a1',
          seq: 2,
          transform: translation(600, 600),
          size: [50, 50],
          cornerRadius: 0,
          fill: null,
          stroke: null,
          interactions: [{ trigger: 'click', action: { type: 'navigate', target: hidden } }],
        }),
      );
      tx.create(
        createNode('rect', {
          parent: last,
          index: 'a0',
          seq: 3,
          transform: translation(10, 10),
          size: [40, 40],
          cornerRadius: 0,
          fill: null,
          stroke: null,
          interactions: [{ trigger: 'click', action: { type: 'back' } }],
        }),
      );
    });
    // 隐藏的第二页不播：第一页是 0，第三页是 1
    const index = new Map([
      [first, 0],
      [last, 1],
    ]);
    expect(prototypeLinks(editor, first, index)).toEqual([
      { x: 120, y: 80, width: 200, height: 60, target: 1, transition: { effect: 'push', duration: 300 } },
    ]);
    expect(prototypeLinks(editor, last, index)).toEqual([{ x: 10, y: 10, width: 40, height: 40, target: -1 }]);
  });
});
