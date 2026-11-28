import type { Path } from 'canvaskit-wasm';
import {
  IDENTITY,
  STROKE_JOINS,
  createId,
  createNode,
  hasShapeStyle,
  isInstanceCopy,
  keyBetween,
  keysBetween,
  multiply,
  nextSeq,
  solid,
  translation,
  type Color,
  type NodeId,
  type PathNode,
  type SceneNode,
  type StrokeJoin,
  type TextNode,
  type Transaction,
} from '@shiba/core';
import { offsetOutline, pathGeometry, strokeOutline } from '@shiba/renderer';
import type { Editor } from '../editor';
import type { Command } from './command';

/**
 * 生成新路径的命令：轮廓化描边、偏移路径、文字转轮廓。结果都是普通的钢笔路径，之后可以随便改。
 *
 * 轮廓化描边和文字转轮廓是"换掉原来的对象"：新对象沿用原来的 id、lineageId、名字、位置、不透明度、混合模式，
 * 所以原来加在它上面的动画、和别的幻灯片之间的平滑切换都还接得上；整个替换是一步撤销。
 */

/**
 * 能做路径运算的形状：矩形、椭圆、钢笔路径、布尔组。布尔组里的运算对象不算，它们自己的描边本来就不画。
 * 实例里的也不算：这几个命令都会换掉对象或者新加对象，实例的结构由主组件决定
 */
function shapes(editor: Editor): Extract<SceneNode, { stroke: unknown }>[] {
  return editor.selectedNodes().filter((node): node is Extract<SceneNode, { stroke: unknown }> => {
    if (!hasShapeStyle(node) || node.locked || isInstanceCopy(node)) return false;
    const parent = node.parent ? editor.store.get(node.parent) : undefined;
    return parent?.type !== 'boolean';
  });
}

function strokedShapes(editor: Editor): Extract<SceneNode, { stroke: unknown }>[] {
  return shapes(editor).filter((node) => node.stroke !== null && node.stroke.width > 0);
}

function selectedTexts(editor: Editor): TextNode[] {
  return editor
    .selectedNodes()
    .filter((node): node is TextNode => node.type === 'text' && !node.locked && !isInstanceCopy(node));
}

/**
 * 把一条 Skia 路径（某个坐标系里的）做成钢笔路径节点：锚点以外框左上角为原点，transform 把它放回原处，
 * 再乘上 base（这个坐标系相对父节点的变换）。路径是空的时返回 null。不负责 delete 路径
 */
function pathNode(
  editor: Editor,
  path: Path,
  base: SceneNode['transform'],
  style: Pick<PathNode, 'fill' | 'stroke'>,
): PathNode | null {
  const geometry = pathGeometry(editor.ck, path);
  if (!geometry) return null;
  const { box } = geometry;
  return createNode('path', {
    parent: null,
    index: '',
    seq: 0,
    transform: multiply(base, translation(box.x, box.y)),
    size: [box.w, box.h],
    subpaths: geometry.subpaths,
    fillRule: geometry.fillRule,
    ...style,
  });
}

/**
 * 用新的内容换掉一个节点。id、lineageId、名字、父节点、层位、不透明度、混合模式、显示和锁定都沿用原来的。
 * 只有一样东西时直接换成它；好几样时换成一个编组，按顺序从下到上放在组里。
 * parts 的 transform 是相对原节点本地坐标的；它们的 parent、index、seq 在这里填。
 * 原节点的子节点要先挪走（删掉原节点时会连子节点一起删）
 */
function replaceNode(editor: Editor, tx: Transaction, node: SceneNode, parts: SceneNode[], name?: string): void {
  const { store } = editor;
  const keep = {
    id: node.id,
    lineageId: node.lineageId,
    name: name ?? node.name,
    parent: node.parent,
    index: node.index,
    opacity: node.opacity,
    blendMode: node.blendMode,
    visible: node.visible,
    locked: node.locked,
  };
  tx.remove(node.id);
  if (parts.length === 1) {
    const only = parts[0]!;
    tx.create({
      ...only,
      ...keep,
      seq: nextSeq(store, only.type),
      transform: multiply(node.transform, only.transform),
    });
    return;
  }
  tx.create(createNode('group', { ...keep, seq: nextSeq(store, 'group'), transform: node.transform }));
  const indices = keysBetween(null, null, parts.length);
  parts.forEach((part, i) => {
    tx.create({ ...part, parent: node.id, index: indices[i]!, seq: nextSeq(store, part.type) });
  });
}

/**
 * 轮廓化描边：把描边变成一块按描边颜色填充的路径（端点、拐角、虚线和画布上画的一样）。
 * 没有填充的形状直接换成这条路径；有填充的换成一个编组，下面是去掉描边的原形状，上面是描边变成的路径，
 * 和 Illustrator 的做法一样，看起来和原来完全相同
 */
export const outlineStroke: Command = {
  id: 'path.outlineStroke',
  enabled: (editor) => strokedShapes(editor).length > 0,
  run(editor) {
    const { ck, store } = editor;
    const nodes = strokedShapes(editor);
    const plans: { node: (typeof nodes)[number]; stroke: PathNode }[] = [];
    for (const node of nodes) {
      const outline = strokeOutline(ck, editor.geometry.outlineOf(node), node.stroke!);
      if (!outline) continue;
      const stroke = pathNode(editor, outline, IDENTITY, { fill: solid(node.stroke!.color), stroke: null });
      outline.delete();
      if (stroke) plans.push({ node, stroke });
    }
    if (plans.length === 0) return;

    store.transact('outline stroke', (tx) => {
      for (const { node, stroke } of plans) {
        if (!node.fill) {
          replaceNode(editor, tx, node, [stroke]);
          continue;
        }
        // 下面的填充部分是原形状的复制，换个 id；布尔组的运算对象跟着挪过去
        const fill = {
          ...node,
          id: createId(),
          lineageId: createId(),
          name: undefined,
          transform: IDENTITY,
          opacity: 1,
          blendMode: 'normal' as const,
          visible: true,
          locked: false,
          stroke: null,
        };
        for (const child of store.children(node.id)) tx.update(child.id, { parent: fill.id });
        replaceNode(editor, tx, node, [fill, stroke]);
      }
    });
    store.sealHistory();
    editor.select(plans.map((plan) => plan.node.id));
  },
};

export interface OffsetPathArgs {
  /** 偏移的距离，文档单位：正数往外扩，负数往里缩 */
  distance: number;
  /** 拐角 */
  join: StrokeJoin;
}

/**
 * 偏移路径：按形状现在的轮廓往外扩或往里缩，生成一条新路径，填充和描边照搬原来的。原来的形状保留：
 * 外扩的放在它下面（像一圈底边），内缩的放在它上面，都看得见。新路径被选中
 */
export const offsetPath: Command<OffsetPathArgs> = {
  id: 'path.offset',
  enabled: (editor, args) =>
    shapes(editor).length > 0 &&
    (!args || (Number.isFinite(args.distance) && args.distance !== 0 && STROKE_JOINS.includes(args.join))),
  run(editor, { distance, join }) {
    const { ck, store } = editor;
    const created: NodeId[] = [];
    const plans: { node: SceneNode; path: PathNode }[] = [];
    for (const node of shapes(editor)) {
      const outline = offsetOutline(ck, editor.geometry.outlineOf(node), distance, join);
      if (!outline) continue;
      const path = pathNode(editor, outline, node.transform, { fill: node.fill, stroke: node.stroke });
      outline.delete();
      if (path) plans.push({ node, path });
    }
    if (plans.length === 0) return;

    store.transact('offset path', (tx) => {
      for (const { node, path } of plans) {
        if (!node.parent) continue;
        const siblings = store.children(node.parent);
        const at = siblings.findIndex((s) => s.id === node.id);
        const index =
          distance > 0
            ? keyBetween(siblings[at - 1]?.index ?? null, node.index)
            : keyBetween(node.index, siblings[at + 1]?.index ?? null);
        tx.create({
          ...path,
          parent: node.parent,
          index,
          seq: nextSeq(store, 'path'),
          opacity: node.opacity,
          blendMode: node.blendMode,
        });
        created.push(path.id);
      }
    });
    store.sealHistory();
    editor.select(created);
  },
};

/** 文字转轮廓：要取字体文件，是异步的，见 Editor.outlineText */
export const outlineText: Command = {
  id: 'text.outline',
  enabled: (editor) => selectedTexts(editor).length > 0,
  run(editor) {
    void editor.outlineText(selectedTexts(editor).map((node) => node.id));
  },
};

/** 文字转出来的路径默认用文字内容当名字，图层列表里还认得出是哪段字 */
function textName(node: TextNode): string | undefined {
  if (node.name) return node.name;
  const line = node.text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim();
  if (!line) return undefined;
  return [...line].length > 40 ? `${[...line].slice(0, 40).join('')}…` : line;
}

/**
 * 把文本节点换成它转出来的路径（文字转轮廓的最后一步，在 Editor.outlineText 里调用）。
 * 一种颜色的字是一条路径；好几种颜色时每种颜色一条，放在一个编组里。
 * outlines 是按节点算好的结果（节点本地坐标），节点在算的过程中被改过、删掉的跳过。返回换掉了的节点
 */
export function replaceTextWithOutlines(
  editor: Editor,
  outlines: ReadonlyMap<TextNode, readonly { color: Color; path: Path }[]>,
): NodeId[] {
  const { store } = editor;
  const plans: { node: TextNode; parts: PathNode[] }[] = [];
  for (const [node, list] of outlines) {
    if (store.get(node.id) !== node) continue;
    const parts = list
      .map(({ color, path }) => pathNode(editor, path, IDENTITY, { fill: solid(color), stroke: null }))
      .filter((part): part is PathNode => part !== null);
    if (parts.length > 0) plans.push({ node, parts });
  }
  if (plans.length === 0) return [];
  store.transact('outline text', (tx) => {
    for (const { node, parts } of plans) replaceNode(editor, tx, node, parts, textName(node));
  });
  store.sealHistory();
  return plans.map((plan) => plan.node.id);
}

/**
 * 拼合（⌘E）：把矩形、椭圆、布尔组换成普通的钢笔路径（布尔组换成运算的结果，运算对象去掉），
 * 填充、描边不变，id 和血缘沿用（动画、平滑切换接得上）。之后可以改锚点
 */
export const flattenShapes: Command = {
  id: 'path.flatten',
  enabled: (editor) => shapes(editor).some((node) => node.type !== 'path'),
  run(editor) {
    const { store } = editor;
    const plans = shapes(editor)
      .filter((node) => node.type !== 'path')
      .flatMap((node) => {
        const path = pathNode(editor, editor.geometry.outlineOf(node), IDENTITY, {
          fill: node.fill,
          stroke: node.stroke,
        });
        return path ? [{ node, path }] : [];
      });
    if (plans.length === 0) return;
    store.transact('flatten', (tx) => plans.forEach(({ node, path }) => replaceNode(editor, tx, node, [path])));
    store.sealHistory();
    editor.select(plans.map((p) => p.node.id));
  },
};
