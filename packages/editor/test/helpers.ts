import { createRequire } from 'node:module';
import { DocStore, createNode, rgba, solid, translation, type NodeId, type Point } from '@shiba/core';
import { loadCanvasKit, type CanvasKit } from '@shiba/renderer';
import { createEditor, type Editor } from '../src';
import type { PointerInfo } from '../src/types';

const require = createRequire(import.meta.url);
let ck: CanvasKit | null = null;

/** 测试里共用的 CanvasKit，第一次用时加载 */
export async function canvasKit(): Promise<CanvasKit> {
  ck ??= await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
  return ck;
}

export interface Scene {
  editor: Editor;
  store: DocStore;
  board: NodeId;
  /** 画板里的矩形，按传入的顺序 */
  rects: NodeId[];
}

/**
 * 一个 1000 × 600 的画板放在世界坐标 (0, 0)（是一页幻灯片），里面按 boxes 放几个矩形（x、y、宽、高，相对画板）。
 * 相机没动，屏幕坐标就是世界坐标
 */
export function scene(
  kit: CanvasKit,
  boxes: readonly (readonly [number, number, number, number])[] = [[100, 100, 100, 100]],
): Scene {
  const store = DocStore.create();
  const board = store.transact('board', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size: [1000, 600],
        fill: solid(rgba(1, 1, 1)),
        deck: { order: 'a0', notes: '' },
      }),
    ),
  );
  const rects = boxes.map(([x, y, w, h], i) =>
    store.transact(
      'rect',
      (tx) =>
        tx.create(
          createNode('rect', {
            parent: board.id,
            index: store.indexOnTop(board.id),
            seq: i + 1,
            transform: translation(x, y),
            size: [w, h],
            cornerRadius: 0,
            fill: solid(rgba(1, 0, 0)),
            stroke: null,
          }),
        ).id,
    ),
  );
  store.sealHistory();
  const editor = createEditor({
    ck: kit,
    store,
    theme: { background: rgba(0, 0, 0), accent: '#00f', label: '#888', handleFill: '#fff' },
    defaultFonts: { latin: 'Inter', cjk: 'Noto Sans SC' },
  });
  return { editor, store, board: board.id, rects };
}

/** 一次指针事件。相机没动时屏幕坐标就是世界坐标 */
export function pointer(
  world: Point,
  options: { down?: boolean; shift?: boolean; alt?: boolean; mod?: boolean } = {},
): PointerInfo {
  return {
    x: world.x,
    y: world.y,
    world,
    shift: options.shift ?? false,
    alt: options.alt ?? false,
    mod: options.mod ?? false,
    button: 0,
    down: options.down ?? true,
  };
}
