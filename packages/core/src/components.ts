import { createId, type GroupNode, type Matrix, type NodeId, type SceneNode } from './model';
import type { DocStore, Patch, Transaction } from './store';
import { descendants, isDescendantOf } from './tree';

/**
 * 组件与实例。
 *
 * 主组件是一个带 `component` 标记的编组，子节点就是组件的内容；实例是一个带 `instanceOf` 的编组，
 * 子节点是主组件内容的真实副本，每个副本用 `source` 记着它对应主组件里的哪个节点。
 * 因为副本是普通节点，渲染、导出 PDF / SVG / 网页、命中、选中、文字编辑都不用认识组件。
 *
 * 同步由整理器 `syncComponents` 维护（每次事务结束前执行，见 store.ts），和引起它的修改是同一步撤销：
 * - 主组件里有东西改了：它的每个实例照着改。实例里没有的副本补上，主组件里删掉的副本删掉，顺序跟主组件一样。
 * - 用户直接改了实例里的副本（换颜色、改文字、隐藏）：把改了的属性名记进副本的 `overrides`，
 *   以后同步时这些属性保留自己的值。改回和主组件一样时自动去掉。
 * - 实例自己（根节点）的位置、大小、不透明度、名字都是它自己的，不跟主组件走；只有蒙版的方式跟着主组件。
 *
 * 实例改大小时整体缩放：缩放写进实例根节点的变换矩阵，描边、圆角、字号跟着按比例变，
 * 副本的几何始终和主组件一样，所以缩放过的实例照样同步（见 editor 的 resize.ts）。
 *
 * 嵌套：主组件里可以放别的组件的实例。实例里的副本也可以是嵌套实例的副本，它的子节点对应
 * 主组件里那个嵌套实例的子节点。同步一层一层传下去：A 改了 → 主组件 M 里 A 的实例跟着改 → M 变了 → M 的实例跟着改。
 * 只有最外层的实例（没有 source 的）直接照它的主组件同步，嵌套在实例里的实例靠外层传下来。
 *
 * 规则：主组件不能放进主组件里，主组件里不能（直接或间接）出现它自己的实例；实例里的结构不能改
 * （不能往里加、删、编组、调层序），这些由编辑器的命令检查，打开文件时由 validate.ts 检查。
 */

/** 节点是主组件 */
export function isComponent(node: SceneNode | undefined | null): node is GroupNode & { component: true } {
  return node?.type === 'group' && node.component === true;
}

/** 节点是组件实例的根（包括嵌套在别的实例里的） */
export function isInstance(node: SceneNode | undefined | null): node is GroupNode & { instanceOf: NodeId } {
  return node?.type === 'group' && typeof node.instanceOf === 'string';
}

/** 节点是实例里的副本：内容由主组件决定，只能改属性，不能改结构 */
export function isInstanceCopy(node: SceneNode | undefined | null): boolean {
  return node?.source !== undefined;
}

type Reader = Pick<DocStore, 'get'>;

/** 节点所在的主组件；自己是主组件时返回自己 */
export function componentOf(store: Reader, id: NodeId | null): GroupNode | null {
  let node = id === null ? undefined : store.get(id);
  // 有环的数据走不完，设个上限
  for (let guard = 0; node && guard < 10_000; guard++) {
    if (isComponent(node)) return node;
    node = node.parent ? store.get(node.parent) : undefined;
  }
  return null;
}

/** 节点所在的最外层实例；自己是最外层实例时返回自己，不在实例里返回 null */
export function outerInstanceOf(store: Reader, id: NodeId): GroupNode | null {
  let node = store.get(id);
  for (let guard = 0; node && guard < 10_000; guard++) {
    if (isInstance(node) && node.source === undefined) return node;
    node = node.parent ? store.get(node.parent) : undefined;
  }
  return null;
}

/** 文档里的所有主组件，按树的先序 */
export function components(store: DocStore): GroupNode[] {
  return [store.root, ...descendants(store, store.root.id)].filter(isComponent);
}

/** 某个主组件的所有最外层实例 */
export function instancesOf(store: DocStore, componentId: NodeId): GroupNode[] {
  const out: GroupNode[] = [];
  for (const node of store.all()) {
    if (isInstance(node) && node.instanceOf === componentId && node.source === undefined) out.push(node);
  }
  return out;
}

// ───────────── 副本 ─────────────

/** 副本自己的字段：不跟主组件走（index 也是从主组件抄的，但单独处理） */
const LOCAL_KEYS: ReadonlySet<string> = new Set(['id', 'parent', 'lineageId', 'seq', 'source', 'overrides']);

/**
 * 要一起覆盖的属性：文字和它的字符样式、段落样式、保真外观都按字的位置记，
 * 改了文字却照搬主组件的区间会对不上，所以改了其中一项就当四项都改了
 */
const OVERRIDE_GROUPS: readonly (readonly string[])[] = [['text', 'spans', 'paragraphs', 'appearance']];

function expandOverrides(list: readonly string[] | undefined): Set<string> {
  const out = new Set(list ?? []);
  for (const group of OVERRIDE_GROUPS) {
    if (group.some((key) => out.has(key))) for (const key of group) out.add(key);
  }
  return out;
}

/** 两个字段值是否相同（深比较；undefined 等于没有） */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((v, i) => sameValue(v, other[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!sameValue(x[key], y[key])) return false;
  }
  return true;
}

/** 由父节点的血缘和主组件节点的 id 算出副本的血缘：同一个实例复制出来的几份里，后来补上的副本血缘也相同，平滑切换配得上 */
function deriveLineage(parentLineage: string, sourceId: NodeId): string {
  const key = `${parentLineage}/${sourceId}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).padStart(12, '0').slice(-12);
}

/** 照主组件的一个节点（连同后代）做副本，挂到 parentId 下面。返回新节点，第一个是副本的根 */
function copySubtree(store: DocStore, main: SceneNode, parentId: NodeId, parentLineage: string): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (node: SceneNode, parent: NodeId, lineage: string): void => {
    const copy = { ...node } as Record<string, unknown>;
    delete copy.overrides;
    copy.id = createId();
    copy.parent = parent;
    copy.source = node.id;
    copy.lineageId = deriveLineage(lineage, node.id);
    const created = copy as unknown as SceneNode;
    out.push(created);
    for (const child of store.children(node.id)) visit(child, created.id, created.lineageId);
  };
  visit(main, parentId, parentLineage);
  return out;
}

/**
 * 按主组件的节点更新一个副本：除了副本自己的字段和覆盖了的属性，其余照抄主组件。
 * 类型变了（比如主组件里的矩形轮廓化成了路径）就不保留覆盖。返回是否改了
 */
function syncCopy(tx: Transaction, copy: SceneNode, main: SceneNode): boolean {
  const sameType = copy.type === main.type;
  const overridden = sameType ? expandOverrides(copy.overrides) : new Set<string>();
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(main)) {
    if (!LOCAL_KEYS.has(key) && value !== undefined) next[key] = value;
  }
  next.id = copy.id;
  next.parent = copy.parent;
  next.lineageId = copy.lineageId;
  next.seq = copy.seq;
  next.source = main.id;
  next.index = main.index;
  if (sameType && copy.overrides?.length) next.overrides = copy.overrides;
  const own = copy as unknown as Record<string, unknown>;
  for (const key of overridden) {
    if (own[key] !== undefined) next[key] = own[key];
    else delete next[key];
  }
  if (sameValue(own, next)) return false;
  tx.replace(next as unknown as SceneNode);
  return true;
}

/** 让 copyParent 的子节点和 mainParent 的子节点一一对应。返回是否改了 */
function syncChildren(tx: Transaction, store: DocStore, copyParentId: NodeId, mainParentId: NodeId): boolean {
  const copyParent = tx.get(copyParentId);
  if (!copyParent) return false;
  let changed = false;
  const mains = store.children(mainParentId);
  const mainIds = new Set(mains.map((m) => m.id));
  const bySource = new Map<NodeId, SceneNode>();
  for (const copy of [...store.children(copyParentId)]) {
    if (copy.source === undefined) continue; // 不是从主组件来的（按规则不该有），留着不动，免得丢东西
    if (!mainIds.has(copy.source) || bySource.has(copy.source)) {
      // 主组件里已经删掉了；或者同一个节点有两份副本，只留一份
      tx.remove(copy.id);
      changed = true;
    } else {
      bySource.set(copy.source, copy);
    }
  }
  for (const main of mains) {
    const copy = bySource.get(main.id);
    if (!copy) {
      for (const node of copySubtree(store, main, copyParentId, copyParent.lineageId)) tx.create(node);
      changed = true;
      continue;
    }
    if (syncCopy(tx, copy, main)) changed = true;
    if (syncChildren(tx, store, copy.id, main.id)) changed = true;
  }
  return changed;
}

/** 把一个最外层实例照它的主组件同步一遍。返回是否改了 */
function syncInstance(tx: Transaction, store: DocStore, instance: GroupNode, main: GroupNode): boolean {
  let changed = false;
  if (instance.mask !== main.mask) {
    const next = { ...instance } as Record<string, unknown>;
    if (main.mask) next.mask = main.mask;
    else delete next.mask;
    tx.replace(next as unknown as SceneNode);
    changed = true;
  }
  return syncChildren(tx, store, instance.id, main.id) || changed;
}

/** 用户直接改了副本：哪些属性改得和主组件不一样了，记进 overrides；改回一样的去掉 */
function updatedOverrides(before: SceneNode, after: SceneNode, main: SceneNode): readonly string[] | undefined {
  const set = new Set(after.overrides ?? []);
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  const m = main as unknown as Record<string, unknown>;
  let changed = false;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (LOCAL_KEYS.has(key) || key === 'index' || key === 'type' || sameValue(b[key], a[key])) continue;
    if (sameValue(a[key], m[key])) changed = set.delete(key) || changed;
    else if (!set.has(key)) {
      set.add(key);
      changed = true;
    }
  }
  if (!changed) return after.overrides;
  return set.size > 0 ? [...set].sort() : undefined;
}

function setOverrides(tx: Transaction, node: SceneNode, overrides: readonly string[] | undefined): void {
  const next = { ...node } as Record<string, unknown>;
  if (overrides) next.overrides = overrides;
  else delete next.overrides;
  tx.replace(next as unknown as SceneNode);
}

/** 整理器：见文件开头的说明 */
export function syncComponents(tx: Transaction, store: DocStore, userPatches: readonly Patch[]): void {
  // 用户直接改了实例里的副本：记下覆盖
  for (const patch of userPatches) {
    const after = tx.get(patch.id);
    if (!after?.source || !patch.before || patch.before.source !== after.source) continue;
    const main = tx.get(after.source);
    if (!main) continue;
    const overrides = updatedOverrides(patch.before, after, main);
    if (overrides !== after.overrides) setOverrides(tx, after, overrides);
  }

  // 哪些主组件里有东西变了；哪些实例刚换了主组件
  const dirty: NodeId[] = [];
  const queued = new Set<NodeId>();
  const enqueue = (id: NodeId): void => {
    if (queued.has(id)) return;
    queued.add(id);
    dirty.push(id);
  };
  const retarget: GroupNode[] = [];
  for (const patch of [...tx.patches.values()]) {
    if (patch.before === patch.after) continue;
    const start = patch.after ? patch.id : (patch.before?.parent ?? null);
    const main = componentOf(tx, start);
    if (main) enqueue(main.id);
    const after = patch.after;
    if (isInstance(after) && after.source === undefined && patch.before && !sameRef(patch.before, after)) {
      retarget.push(after);
    }
  }
  if (dirty.length === 0 && retarget.length === 0) return;

  // 每个主组件的最外层实例。同步只会在实例里面加副本，加出来的都带 source，所以这张表在整个过程中都有效
  const instances = new Map<NodeId, NodeId[]>();
  for (const node of store.all()) {
    if (!isInstance(node) || node.source !== undefined) continue;
    let list = instances.get(node.instanceOf);
    if (!list) instances.set(node.instanceOf, (list = []));
    list.push(node.id);
  }

  const afterSync = (instanceId: NodeId): void => {
    // 实例本身在另一个主组件里：那个主组件也变了，它的实例也要同步
    const outer = componentOf(tx, instanceId);
    if (outer) enqueue(outer.id);
  };

  for (const instance of retarget) {
    const current = tx.get(instance.id);
    const main = isInstance(current) ? tx.get(current.instanceOf) : undefined;
    if (isInstance(current) && isComponent(main) && syncInstance(tx, store, current, main)) afterSync(current.id);
  }

  // 有环的数据（打开文件时会拦住，这里再兜个底）不会无限同步下去
  let budget = 100_000;
  for (let i = 0; i < dirty.length && budget > 0; i++) {
    const main = tx.get(dirty[i]!);
    if (!isComponent(main)) continue;
    for (const id of instances.get(main.id) ?? []) {
      budget -= 1;
      const instance = tx.get(id);
      if (!isInstance(instance) || instance.instanceOf !== main.id || instance.source !== undefined) continue;
      // 主组件里放着自己的实例（按规则不会有）：跳过，免得越长越大
      if (isDescendantOf(store, id, main.id)) continue;
      if (syncInstance(tx, store, instance, main)) afterSync(id);
    }
  }
}

/** 实例根节点的 instanceOf 或 mask 有没有变：变了要重新同步 */
function sameRef(before: SceneNode, after: GroupNode): boolean {
  return before.type === 'group' && before.instanceOf === after.instanceOf;
}

// ───────────── 新建、分离、重置 ─────────────

export interface InstancePlacement {
  parent: NodeId;
  index: string;
  transform: Matrix;
  seq: number;
}

/**
 * 做一个组件实例：根节点照抄主组件的外观（不透明度、混合模式、蒙版），子节点是主组件内容的副本。
 * 返回要创建的节点，第一个是实例的根。名字不抄：界面上没起名的实例显示主组件的名字
 */
export function instanceNodes(store: DocStore, componentId: NodeId, place: InstancePlacement): SceneNode[] {
  const main = store.require(componentId);
  if (!isComponent(main)) throw new Error(`${componentId} 不是主组件`);
  const root = { ...main } as Record<string, unknown>;
  delete root.component;
  delete root.name;
  delete root.source;
  delete root.overrides;
  Object.assign(root, {
    id: createId(),
    lineageId: createId(),
    parent: place.parent,
    index: place.index,
    transform: place.transform,
    seq: place.seq,
    instanceOf: main.id,
  });
  const instance = root as unknown as GroupNode;
  const out: SceneNode[] = [instance];
  for (const child of store.children(main.id)) out.push(...copySubtree(store, child, instance.id, instance.lineageId));
  return out;
}

/**
 * 沿着 source 往上找，直到找到组件 componentId 里面的那个节点。一路上每一层的覆盖合在一起
 * （主组件 M 里嵌套的实例改过的文字，分离 M 的实例以后要继续保留）。找不到时返回 null
 */
function resolveSource(
  store: DocStore,
  node: SceneNode,
  componentId: NodeId,
): { source: NodeId; overrides: readonly string[] | undefined } | null {
  const overrides = new Set(node.overrides ?? []);
  let source = node.source;
  for (let guard = 0; source !== undefined && guard < 1000; guard++) {
    if (isDescendantOf(store, source, componentId)) {
      return { source, overrides: overrides.size > 0 ? [...overrides].sort() : undefined };
    }
    const next = store.get(source);
    if (!next) return null;
    for (const key of next.overrides ?? []) overrides.add(key);
    source = next.source;
  }
  return null;
}

/**
 * 分离实例：变成普通编组，里面的东西变成普通对象，样子不变，以后不再跟着主组件改。
 * 里面嵌套的实例变成最外层的实例，继续跟着它们自己的主组件；对应不上的嵌套实例一起分离
 */
export function detachInstance(tx: Transaction, store: DocStore, id: NodeId): void {
  const root = tx.get(id);
  if (!isInstance(root)) return;
  const writes = new Map<NodeId, Record<string, unknown>>();
  const plain = (node: SceneNode): Record<string, unknown> => {
    const next = { ...node } as Record<string, unknown>;
    delete next.source;
    delete next.overrides;
    return next;
  };
  const rootNext = plain(root);
  delete rootNext.instanceOf;
  writes.set(root.id, rootNext);

  /** 在 nearest 这个嵌套实例里面（nearest 为 null 表示直接在被分离的实例里） */
  const visit = (parentId: NodeId, nearest: (GroupNode & { instanceOf: NodeId }) | null): void => {
    for (const child of store.children(parentId)) {
      if (!nearest) {
        // 直接在被分离的实例里：变成普通对象；嵌套的实例变成最外层的实例
        const next = plain(child);
        if (isInstance(child)) {
          const resolvable = descendants(store, child.id).every((d) => resolveSource(store, d, child.instanceOf));
          if (!resolvable) delete next.instanceOf;
          writes.set(child.id, next);
          visit(child.id, resolvable ? child : null);
        } else {
          writes.set(child.id, next);
          visit(child.id, null);
        }
        continue;
      }
      // 在嵌套实例里：改成直接对应那个实例的主组件
      const resolved = resolveSource(store, child, nearest.instanceOf);
      if (resolved) {
        const next = { ...child } as Record<string, unknown>;
        next.source = resolved.source;
        if (resolved.overrides) next.overrides = resolved.overrides;
        else delete next.overrides;
        writes.set(child.id, next);
      }
      visit(child.id, nearest);
    }
  };
  visit(root.id, null);
  for (const next of writes.values()) tx.replace(next as unknown as SceneNode);
}

/** 重置实例：去掉实例（或实例里某个副本，连同它里面的）所有的覆盖，恢复成主组件的样子 */
export function resetOverrides(tx: Transaction, store: DocStore, id: NodeId): void {
  const node = tx.get(id);
  if (!node) return;
  for (const item of [node, ...descendants(store, id)]) {
    if (item.overrides) setOverrides(tx, item, undefined);
  }
  const current = tx.get(id)!;
  if (isInstance(current) && current.source === undefined) {
    const main = tx.get(current.instanceOf);
    if (isComponent(main)) syncInstance(tx, store, current, main);
    return;
  }
  if (current.source === undefined) return;
  const main = tx.get(current.source);
  if (!main) return;
  syncCopy(tx, current, main);
  syncChildren(tx, store, current.id, main.id);
}

// ───────────── 规则 ─────────────

/** 这些节点（连同后代）用到的所有组件，包括这些组件里面又用到的 */
function componentsUsedBy(store: DocStore, ids: readonly NodeId[]): Set<NodeId> {
  const used = new Set<NodeId>();
  const queue = [...ids];
  while (queue.length > 0) {
    const id = queue.pop()!;
    const node = store.get(id);
    if (!node) continue;
    for (const item of [node, ...descendants(store, id)]) {
      if (isInstance(item) && !used.has(item.instanceOf)) {
        used.add(item.instanceOf);
        queue.push(item.instanceOf);
      }
    }
  }
  return used;
}

/**
 * 把这些节点放进 containerId 里是否违反组件的规则：
 * 放进主组件里的东西不能含有主组件，也不能（直接或间接）用到这个主组件自己；不能往实例里加东西
 */
export function breaksComponentRules(store: DocStore, ids: readonly NodeId[], containerId: NodeId): boolean {
  const container = store.get(containerId);
  if (!container) return false;
  if (isInstance(container) || isInstanceCopy(container)) return true;
  const host = componentOf(store, containerId);
  if (!host) return false;
  for (const id of ids) {
    const node = store.get(id);
    if (node && [node, ...descendants(store, id)].some(isComponent)) return true;
  }
  return componentsUsedBy(store, ids).has(host.id);
}

/** 能不能把 componentId 的实例放进 containerId */
export function canPlaceInstance(store: DocStore, componentId: NodeId, containerId: NodeId): boolean {
  const container = store.get(containerId);
  if (!container || isInstance(container) || isInstanceCopy(container)) return false;
  const host = componentOf(store, containerId);
  if (!host) return true;
  return host.id !== componentId && !componentsUsedBy(store, [componentId]).has(host.id);
}
