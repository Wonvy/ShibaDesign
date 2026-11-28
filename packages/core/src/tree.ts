import { multiply } from './matrix';
import {
  IDENTITY,
  createId,
  type ArtboardNode,
  type Matrix,
  type NodeId,
  type NodeType,
  type SceneNode,
} from './model';
import type { DocStore } from './store';

/** 节点本地坐标 → 世界坐标 */
export function worldTransform(store: DocStore, id: NodeId): Matrix {
  let m: Matrix = IDENTITY;
  let node = store.get(id);
  while (node) {
    m = multiply(node.transform, m);
    node = node.parent ? store.get(node.parent) : undefined;
  }
  return m;
}

/** 父节点坐标 → 世界坐标 */
export function parentWorldTransform(store: DocStore, node: SceneNode): Matrix {
  return node.parent ? worldTransform(store, node.parent) : IDENTITY;
}

/** 所有后代，先序遍历，不含自己 */
export function descendants(store: DocStore, id: NodeId): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (parentId: NodeId): void => {
    for (const child of store.children(parentId)) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** 从自己的父节点一直到根 */
export function ancestors(store: DocStore, id: NodeId): SceneNode[] {
  const out: SceneNode[] = [];
  let node = store.get(id);
  while (node?.parent) {
    node = store.get(node.parent);
    if (node) out.push(node);
  }
  return out;
}

export function isDescendantOf(store: DocStore, id: NodeId, ancestorId: NodeId): boolean {
  return ancestors(store, id).some((n) => n.id === ancestorId);
}

/** 节点所在的画板；节点自己是画板时返回自己 */
export function artboardOf(store: DocStore, id: NodeId): ArtboardNode | null {
  const node = store.get(id);
  if (!node) return null;
  if (node.type === 'artboard') return node;
  return (ancestors(store, id).find((n) => n.type === 'artboard') as ArtboardNode | undefined) ?? null;
}

/** 所有画板，按层叠顺序 */
export function artboards(store: DocStore): ArtboardNode[] {
  return store.children(store.root.id).filter((n): n is ArtboardNode => n.type === 'artboard');
}

/** 作为幻灯片的画板，按播放顺序 */
export function slides(store: DocStore): ArtboardNode[] {
  return artboards(store)
    .filter((a) => a.deck !== null)
    .sort((a, b) => (a.deck!.order < b.deck!.order ? -1 : a.deck!.order > b.deck!.order ? 1 : 0));
}

/** 某类型节点的下一个序号 */
export function nextSeq(store: DocStore, type: NodeType): number {
  let max = 0;
  for (const node of store.all()) {
    if (node.type === type && node.seq > max) max = node.seq;
  }
  return max + 1;
}

/** 把一组节点按层叠顺序从下到上排序（跨父节点时按树的先序） */
export function sortByZOrder(store: DocStore, ids: readonly NodeId[]): SceneNode[] {
  const wanted = new Set(ids);
  const out: SceneNode[] = [];
  const walk = (parentId: NodeId): void => {
    for (const child of store.children(parentId)) {
      if (wanted.has(child.id)) out.push(child);
      walk(child.id);
    }
  };
  walk(store.root.id);
  return out;
}

/** 去掉祖先也在集合里的节点，只留最上层的那些 */
export function topLevelOnly(store: DocStore, ids: readonly NodeId[]): NodeId[] {
  const set = new Set(ids);
  return ids.filter((id) => !ancestors(store, id).some((a) => set.has(a.id)));
}

export interface CloneOptions {
  /** 保留 lineageId：复制幻灯片时为 true，这样平滑切换能配对 */
  keepLineage: boolean;
}

/**
 * 深拷贝一棵子树，所有节点换新 id。
 * 返回的第一个节点是子树的根，它的 parent / index 由调用方决定。
 */
export function cloneSubtree(store: DocStore, id: NodeId, options: CloneOptions): SceneNode[] {
  const source = [store.require(id), ...descendants(store, id)];
  const idMap = new Map<NodeId, NodeId>(source.map((n) => [n.id, createId()]));
  return source.map((node, i) => ({
    ...node,
    id: idMap.get(node.id)!,
    lineageId: options.keepLineage ? node.lineageId : createId(),
    parent: i === 0 ? node.parent : idMap.get(node.parent!)!,
  }));
}

/**
 * 能"进去"选里面东西的容器：编组、布尔组、画框。点里面的东西先选中整个容器，双击进去选里面的；
 * 画板、页面不算（画板里的东西直接点就选得中）
 */
export function isEnterable(node: SceneNode | undefined | null): boolean {
  return node?.type === 'group' || node?.type === 'boolean' || node?.type === 'frame';
}

const NO_NODES: SceneNode[] = [];

/**
 * 蒙版组的两部分：蒙版（最上面那个子节点）和被遮住的内容（其余的子节点，从下到上）。
 * 不是蒙版组、或者组是空的时 mask 为 null（这时 contents 为空，调用方按普通容器处理）
 */
export function maskParts(store: DocStore, node: SceneNode): { mask: SceneNode | null; contents: SceneNode[] } {
  // 绝大多数节点不是蒙版组：先判断，免得每画一个节点都去取一遍子节点
  if (node.type !== 'group' || !node.mask) return { mask: null, contents: NO_NODES };
  const children = store.children(node.id);
  if (children.length === 0) return { mask: null, contents: NO_NODES };
  return { mask: children[children.length - 1]!, contents: children.slice(0, -1) };
}
