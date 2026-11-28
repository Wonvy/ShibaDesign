import {
  DEFAULT_ANIMATION_DURATION,
  ancestors,
  artboards,
  createId,
  getEffect,
  reverseMotionPath,
  type ArtboardNode,
  type DocStore,
  type NodeId,
  type SceneNode,
  type SlideAnimation,
  type SlideTransition,
  type Subpath,
  type Transaction,
} from '@shiba/core';
import type { Editor } from '../editor';
import type { Command } from './command';

/**
 * 幻灯片动画的编辑命令。动画存在所属幻灯片（画板）的 deck 里，所以每次修改都是改那个画板节点，
 * 自然也就进了撤销历史。
 */

/** 一个节点所在的幻灯片，以及它在这一页上对应的"图层"：幻灯片的直接子节点 */
export function slideLayerOf(store: DocStore, id: NodeId): { slide: ArtboardNode; layer: SceneNode } | null {
  const node = store.get(id);
  if (!node || node.type === 'artboard' || node.type === 'page') return null;
  const chain = [node, ...ancestors(store, id)];
  const index = chain.findIndex((n) => n.type === 'artboard');
  const slide = chain[index];
  const layer = chain[index - 1];
  if (!slide || slide.type !== 'artboard' || !slide.deck || !layer) return null;
  return { slide, layer };
}

function setAnimations(tx: Transaction, slide: ArtboardNode, animations: readonly SlideAnimation[]): void {
  if (!slide.deck) return;
  const { animations: _previous, ...rest } = slide.deck;
  // 没有动画时把字段去掉，文档里不留空数组
  tx.update(slide.id, { deck: animations.length > 0 ? { ...rest, animations } : rest });
}

function slideById(store: DocStore, id: NodeId): ArtboardNode | null {
  const node = store.get(id);
  return node?.type === 'artboard' && node.deck ? node : null;
}

/**
 * 给选中的对象各加一条动画，排在所在幻灯片动画列表的末尾。
 * 动作路径效果带上路径：给了 path 就用它（自定义路径画完时），否则用效果的预设路径；两样都没有的（自定义路径）不加
 */
export const addAnimation: Command<{ effect: string; path?: Subpath }> = {
  id: 'animation.add',
  enabled: (editor, args) => {
    const def = getEffect(args.effect);
    if (!def || (def.kind === 'motion' && !args.path && !def.defaultPath)) return false;
    return editor.selection.some((id) => slideLayerOf(editor.store, id) !== null);
  },
  run(editor, { effect, path }) {
    const { store } = editor;
    const def = getEffect(effect);
    if (!def) return;
    if (def.kind === 'motion' && !path && !def.defaultPath) return;
    const targets = new Map<NodeId, NodeId[]>();
    for (const id of editor.selection) {
      const found = slideLayerOf(store, id);
      if (!found) continue;
      const list = targets.get(found.slide.id) ?? [];
      if (!list.includes(found.layer.id)) list.push(found.layer.id);
      targets.set(found.slide.id, list);
    }
    store.transact('add animation', (tx) => {
      for (const [slideId, layers] of targets) {
        const slide = slideById(store, slideId);
        if (!slide) continue;
        const added = layers.map((target, i): SlideAnimation => ({
          id: createId(),
          target,
          effect,
          // 一次给多个对象加动画时，它们一起播放
          start: i === 0 ? 'onClick' : 'withPrevious',
          duration: DEFAULT_ANIMATION_DURATION,
          delay: 0,
          // 进入默认从左边来，退出默认往右边去，连起来是一个从左到右的动线
          ...(def.directional ? { direction: def.kind === 'exit' ? ('right' as const) : ('left' as const) } : {}),
          ...(def.kind === 'motion'
            ? { path: path ?? def.defaultPath!({ width: slide.size[0], height: slide.size[1] }) }
            : {}),
        }));
        setAnimations(tx, slide, [...(slide.deck!.animations ?? []), ...added]);
      }
    });
    store.sealHistory();
  },
};

export const updateAnimation: Command<{ slideId: NodeId; id: string; patch: Partial<SlideAnimation> }> = {
  id: 'animation.update',
  run(editor, { slideId, id, patch }) {
    const slide = slideById(editor.store, slideId);
    if (!slide) return;
    const { id: _id, target: _target, ...safe } = patch;
    editor.store.transact('update animation', (tx) =>
      setAnimations(
        tx,
        slide,
        (slide.deck!.animations ?? []).map((a) => (a.id === id ? { ...a, ...safe } : a)),
      ),
    );
    editor.store.sealHistory();
  },
};

export const removeAnimation: Command<{ slideId: NodeId; id: string }> = {
  id: 'animation.remove',
  run(editor, { slideId, id }) {
    const slide = slideById(editor.store, slideId);
    if (!slide) return;
    editor.store.transact('remove animation', (tx) =>
      setAnimations(
        tx,
        slide,
        (slide.deck!.animations ?? []).filter((a) => a.id !== id),
      ),
    );
    editor.store.sealHistory();
  },
};

/**
 * 在动画列表里挪一条动画：delta 是上移（-1）或下移（1）一格；to 是直接挪到第几个（动画面板里拖动排序），
 * 两个都给时按 to
 */
export const moveAnimation: Command<{ slideId: NodeId; id: string; delta?: -1 | 1; to?: number }> = {
  id: 'animation.move',
  run(editor, { slideId, id, delta, to }) {
    const slide = slideById(editor.store, slideId);
    if (!slide) return;
    const list = [...(slide.deck!.animations ?? [])];
    const from = list.findIndex((a) => a.id === id);
    const target = to ?? from + (delta ?? 0);
    if (from < 0 || target < 0 || target >= list.length || target === from) return;
    const [moved] = list.splice(from, 1);
    list.splice(target, 0, moved!);
    editor.store.transact('move animation', (tx) => setAnimations(tx, slide, list));
    editor.store.sealHistory();
  },
};

/**
 * 改一条动画的动作路径。在画布上拖路径的手柄时连续调用，同一次拖动传同一个 mergeKey，松手时调用方 sealHistory
 */
export function setAnimationPath(editor: Editor, slideId: NodeId, id: string, path: Subpath, mergeKey?: string): void {
  const slide = slideById(editor.store, slideId);
  if (!slide) return;
  editor.store.transact(
    'motion path',
    (tx) =>
      setAnimations(
        tx,
        slide,
        (slide.deck!.animations ?? []).map((a) => (a.id === id ? { ...a, path } : a)),
      ),
    { mergeKey },
  );
}

/** 让动作路径反过来走 */
export const reverseAnimationPath: Command<{ slideId: NodeId; id: string }> = {
  id: 'animation.reversePath',
  run(editor, { slideId, id }) {
    const animation = slideById(editor.store, slideId)?.deck?.animations?.find((a) => a.id === id);
    if (!animation?.path) return;
    setAnimationPath(editor, slideId, id, reverseMotionPath(animation.path));
    editor.store.sealHistory();
  },
};

/** 开始在画布上画自定义的动作路径：只选了一个幻灯片上的对象时可用，换成画路径的工具（见 tools/motion-path.ts） */
export const drawAnimationPath: Command = {
  id: 'animation.drawPath',
  enabled: (editor) =>
    editor.selection.length === 1 &&
    slideLayerOf(editor.store, editor.selection[0]!) !== null &&
    editor.tools.has('motion-path'),
  run(editor) {
    editor.setTool('motion-path');
  },
};

/**
 * 改一页的演讲者备注。打字时每次输入调用一次，同一次编辑传同一个 mergeKey，合成一步撤销；编辑结束时调用方 sealHistory
 */
export function setSlideNotes(editor: Editor, slideId: NodeId, notes: string, mergeKey?: string): void {
  const slide = slideById(editor.store, slideId);
  if (!slide || slide.deck!.notes === notes) return;
  editor.store.transact('slide notes', (tx) => tx.update(slide.id, { deck: { ...slide.deck!, notes } }), {
    mergeKey,
  });
}

/** 设置进入某一页时的切换效果；effect 为 none 时去掉这个字段 */
export const setTransition: Command<{ slideId: NodeId; transition: SlideTransition }> = {
  id: 'slide.setTransition',
  run(editor, { slideId, transition }) {
    const slide = slideById(editor.store, slideId);
    if (!slide) return;
    const { transition: _previous, ...rest } = slide.deck!;
    editor.store.transact('set transition', (tx) =>
      tx.update(slide.id, { deck: transition.effect === 'none' ? rest : { ...rest, transition } }),
    );
    editor.store.sealHistory();
  },
};

/**
 * 清掉已经没有意义的动画：对象被删了，或者被挪到了别的幻灯片上。
 * 删除对象、跨画板拖动之后调用，和那次操作放在同一个事务里，所以撤销时动画会一起回来。
 */
export function pruneAnimations(tx: Transaction, store: DocStore): void {
  for (const slide of artboards(store)) {
    const list = slide.deck?.animations;
    if (!list || list.length === 0) continue;
    const kept = list.filter((a) => slideLayerOf(store, a.target)?.slide.id === slide.id);
    if (kept.length !== list.length) setAnimations(tx, slide, kept);
  }
}
