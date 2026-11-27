import { DOCUMENT_VERSION, type DocumentData } from './model';

/**
 * 文档数据校验。文档可能来自用户打开的文件，是不可信输入：
 * 结构不对的数据进了内核会导致崩溃甚至死循环（比如父子关系成环），所以在入口处拦住。
 *
 * 这里只保证"结构安全"：字段类型正确、数值有限、树没有环。
 * 不认识的节点类型会被放行，渲染器会忽略它们，这样旧版本打开新文件时不至于整个打不开。
 */

export type DocumentErrorReason = 'notObject' | 'newerVersion' | 'noRoot' | 'badNode' | 'cycle';

export class DocumentError extends Error {
  constructor(
    readonly reason: DocumentErrorReason,
    detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

const MAX_NODES = 200_000;
const MAX_TEXT_LENGTH = 1_000_000;

export function validateDocument(data: unknown): DocumentData {
  if (!isObject(data) || !isObject(data.nodes)) throw new DocumentError('notObject');
  if (typeof data.version !== 'number' || !Number.isFinite(data.version)) throw new DocumentError('notObject');
  if (data.version > DOCUMENT_VERSION) throw new DocumentError('newerVersion', String(data.version));
  if (typeof data.rootId !== 'string') throw new DocumentError('noRoot');

  const nodes = data.nodes;
  const ids = Object.keys(nodes);
  if (ids.length > MAX_NODES) throw new DocumentError('badNode', 'too many nodes');
  const root = nodes[data.rootId];
  if (!isObject(root) || root.parent !== null) throw new DocumentError('noRoot');

  for (const id of ids) {
    const node = nodes[id];
    if (!isObject(node)) throw new DocumentError('badNode', id);
    checkNode(id, node, nodes);
  }

  // 每个节点顺着 parent 往上走，必须能走到根。走过的节点记下来，整体是线性时间
  const reachesRoot = new Set<string>([data.rootId]);
  for (const id of ids) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !reachesRoot.has(current)) {
      if (path.has(current)) throw new DocumentError('cycle', id);
      path.add(current);
      current = (nodes[current] as { parent: string | null }).parent;
    }
    if (current === null) throw new DocumentError('badNode', `${id} is detached`);
    for (const visited of path) reachesRoot.add(visited);
  }

  return data as unknown as DocumentData;
}

function checkNode(id: string, node: Record<string, unknown>, nodes: Record<string, unknown>): void {
  const fail = (what: string): never => {
    throw new DocumentError('badNode', `${id}: ${what}`);
  };
  if (node.id !== id) fail('id');
  if (typeof node.type !== 'string') fail('type');
  if (typeof node.lineageId !== 'string') fail('lineageId');
  if (typeof node.index !== 'string') fail('index');
  if (!isFiniteNumber(node.seq)) fail('seq');
  if (node.name !== undefined && typeof node.name !== 'string') fail('name');
  if (node.parent !== null && (typeof node.parent !== 'string' || !isObject(nodes[node.parent]))) fail('parent');
  if (!isNumberArray(node.transform, 6)) fail('transform');
  if (!isNumberArray(node.size, 2)) fail('size');
  if (!isFiniteNumber(node.opacity)) fail('opacity');
  if (typeof node.blendMode !== 'string') fail('blendMode');
  if (typeof node.visible !== 'boolean' || typeof node.locked !== 'boolean') fail('visible/locked');

  if ('fill' in node && node.fill !== null && !isFill(node.fill)) fail('fill');
  if ('stroke' in node && node.stroke !== null) {
    const stroke = node.stroke;
    if (!isObject(stroke) || !isColor(stroke.color) || !isFiniteNumber(stroke.width)) fail('stroke');
  }

  switch (node.type) {
    case 'rect':
      if (!isFiniteNumber(node.cornerRadius)) fail('cornerRadius');
      break;
    case 'path':
      if (!Array.isArray(node.subpaths) || !node.subpaths.every(isSubpath)) fail('subpaths');
      break;
    case 'boolean':
      if (typeof node.op !== 'string') fail('op');
      break;
    case 'artboard':
      if (node.deck !== null && (!isObject(node.deck) || typeof node.deck.order !== 'string')) fail('deck');
      break;
    case 'text': {
      if (typeof node.text !== 'string' || node.text.length > MAX_TEXT_LENGTH) fail('text');
      const style = node.style;
      if (
        !isObject(style) ||
        !isObject(style.fontFamily) ||
        typeof style.fontFamily.latin !== 'string' ||
        typeof style.fontFamily.cjk !== 'string' ||
        !isFiniteNumber(style.fontSize) ||
        !isFiniteNumber(style.fontWeight) ||
        !isFiniteNumber(style.lineHeight) ||
        !isFiniteNumber(style.letterSpacing)
      ) {
        fail('style');
      }
      if (typeof node.align !== 'string' || typeof node.sizing !== 'string') fail('align/sizing');
      break;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberArray(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

function isColor(value: unknown): boolean {
  return isObject(value) && [value.r, value.g, value.b, value.a].every(isFiniteNumber);
}

function isFill(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === 'solid') return isColor(value.color);
  if (value.type === 'image') return typeof value.assetId === 'string' && typeof value.fit === 'string';
  return false;
}

function isSubpath(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.closed === 'boolean' &&
    Array.isArray(value.anchors) &&
    value.anchors.every((a) => isObject(a) && [a.x, a.y, a.inX, a.inY, a.outX, a.outY].every(isFiniteNumber))
  );
}
