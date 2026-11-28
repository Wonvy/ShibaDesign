import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { syncComponents } from './components';
import { DOCUMENT_VERSION, createNode, type DocumentData, type NodeId, type NodePatch, type SceneNode } from './model';
import { syncStyles } from './styles';
import { validateDocument } from './validate';

/** 一个节点在一次修改前后的样子；创建时 before 为空，删除时 after 为空 */
export interface Patch {
  id: NodeId;
  before: SceneNode | undefined;
  after: SceneNode | undefined;
}

export interface StoreChange {
  patches: readonly Patch[];
  source: 'transact' | 'undo' | 'redo' | 'load' | 'abandon';
}

export interface TransactOptions {
  /** 相同 mergeKey 的连续事务合并成一步撤销，用于拖动、滑块等连续操作 */
  mergeKey?: string;
}

interface HistoryEntry {
  label: string;
  mergeKey: string | null;
  patches: Map<NodeId, Patch>;
}

type Listener = (change: StoreChange) => void;

/**
 * 整理器：每次事务的 fn 执行完、记进撤销历史之前调用，在同一个事务里补上派生的修改，
 * 比如改了颜色样式之后把所有链接它的对象一起改掉、改了主组件之后同步所有实例。
 * 这样一次修改连同它带出来的修改是一步撤销；撤销、重做是整体换回快照，不再调用整理器。
 * @param userPatches fn 自己做的修改（不含整理器补的），用来分辨哪些是用户改的
 */
export type Normalizer = (tx: Transaction, store: DocStore, userPatches: readonly Patch[]) => void;

/** 内置的整理器，按顺序执行：先让样式落到对象上，再把主组件的变化同步给实例 */
const BUILTIN_NORMALIZERS: readonly Normalizer[] = [syncStyles, syncComponents];

const HISTORY_LIMIT = 200;

/** 事务内的写接口。所有写操作立即生效，并记下修改前的样子以便撤销 */
export class Transaction {
  readonly patches = new Map<NodeId, Patch>();

  constructor(
    private readonly nodes: Map<NodeId, SceneNode>,
    /** 每次写入后调用，让存储丢弃派生缓存，保证事务内读到的子节点列表是最新的 */
    private readonly invalidate: () => void,
  ) {}

  get(id: NodeId): SceneNode | undefined {
    return this.nodes.get(id);
  }

  create<T extends SceneNode>(node: T): T {
    if (this.nodes.has(node.id)) throw new Error(`节点 ${node.id} 已存在`);
    this.record(node.id, undefined, node);
    this.nodes.set(node.id, node);
    return node;
  }

  update(id: NodeId, patch: NodePatch): SceneNode {
    const before = this.nodes.get(id);
    if (!before) throw new Error(`节点 ${id} 不存在`);
    const after = { ...before, ...patch } as SceneNode;
    this.record(id, before, after);
    this.nodes.set(id, after);
    return after;
  }

  /** 整个换掉一个节点（可以去掉字段、换类型）。id 必须不变 */
  replace(node: SceneNode): SceneNode {
    const before = this.nodes.get(node.id);
    if (!before) throw new Error(`节点 ${node.id} 不存在`);
    this.record(node.id, before, node);
    this.nodes.set(node.id, node);
    return node;
  }

  /** 删除节点及其所有后代 */
  remove(id: NodeId): void {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const other of [...this.nodes.values()]) {
      if (other.parent === id) this.remove(other.id);
    }
    this.record(id, node, undefined);
    this.nodes.delete(id);
  }

  private record(id: NodeId, before: SceneNode | undefined, after: SceneNode | undefined): void {
    const existing = this.patches.get(id);
    if (existing) existing.after = after;
    else this.patches.set(id, { id, before, after });
    this.invalidate();
  }
}

/**
 * 文档存储：节点表 + 事务 + 撤销重做。
 * 现在是单机内存实现；以后接协同时保持这个接口，换掉内部实现。
 */
export class DocStore {
  private nodes = new Map<NodeId, SceneNode>();
  private rootId: NodeId;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<Listener>();
  private childrenCache: Map<NodeId, SceneNode[]> | null = null;
  private sealed = true;
  private _version = 0;
  private normalizers: Normalizer[] = [...BUILTIN_NORMALIZERS];

  private constructor(data: DocumentData) {
    this.rootId = data.rootId;
    for (const node of Object.values(data.nodes)) this.nodes.set(node.id, node);
  }

  /** 新建一个只有根页面的空文档 */
  static create(): DocStore {
    const root = createNode('page', { parent: null, index: 'a0', seq: 1 });
    return new DocStore({ version: DOCUMENT_VERSION, rootId: root.id, nodes: { [root.id]: root } });
  }

  static fromJSON(data: DocumentData): DocStore {
    validateDocument(data);
    return new DocStore(data);
  }

  toJSON(): DocumentData {
    return { version: DOCUMENT_VERSION, rootId: this.rootId, nodes: Object.fromEntries(this.nodes) };
  }

  /** 整体替换文档内容并清空历史 */
  load(data: DocumentData): void {
    validateDocument(data);
    const patches: Patch[] = [];
    for (const node of this.nodes.values()) patches.push({ id: node.id, before: node, after: undefined });
    this.nodes = new Map(Object.values(data.nodes).map((n) => [n.id, n]));
    for (const node of this.nodes.values()) patches.push({ id: node.id, before: undefined, after: node });
    this.rootId = data.rootId;
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ patches, source: 'load' });
  }

  /** 每次文档变化加一，可用作缓存键 */
  get version(): number {
    return this._version;
  }

  get size(): number {
    return this.nodes.size;
  }

  get root(): SceneNode {
    return this.require(this.rootId);
  }

  get(id: NodeId): SceneNode | undefined {
    return this.nodes.get(id);
  }

  require(id: NodeId): SceneNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`节点 ${id} 不存在`);
    return node;
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  all(): IterableIterator<SceneNode> {
    return this.nodes.values();
  }

  /** 子节点，按层叠顺序从下到上 */
  children(id: NodeId): readonly SceneNode[] {
    if (!this.childrenCache) {
      const cache = new Map<NodeId, SceneNode[]>();
      for (const node of this.nodes.values()) {
        if (node.parent === null) continue;
        let list = cache.get(node.parent);
        if (!list) cache.set(node.parent, (list = []));
        list.push(node);
      }
      for (const list of cache.values()) list.sort(compareIndex);
      this.childrenCache = cache;
    }
    return this.childrenCache.get(id) ?? EMPTY;
  }

  /** 在某个父节点的最上层追加时应使用的索引 */
  indexOnTop(parentId: NodeId): string {
    const siblings = this.children(parentId);
    return generateKeyBetween(siblings.at(-1)?.index ?? null, null);
  }

  /** 执行一次事务。fn 抛错时全部回滚 */
  transact<R>(label: string, fn: (tx: Transaction) => R, options: TransactOptions = {}): R {
    const tx = new Transaction(this.nodes, () => {
      this.childrenCache = null;
    });
    let result: R;
    try {
      result = fn(tx);
      const userPatches = [...tx.patches.values()].filter((p) => p.before !== p.after).map((p) => ({ ...p }));
      if (userPatches.length > 0) for (const normalize of this.normalizers) normalize(tx, this, userPatches);
    } catch (error) {
      this.apply(tx.patches.values(), 'before');
      throw error;
    }
    const patches = [...tx.patches.values()].filter((p) => p.before !== p.after);
    if (patches.length === 0) return result;

    const mergeKey = options.mergeKey ?? null;
    const top = this.undoStack.at(-1);
    if (!this.sealed && mergeKey !== null && top?.mergeKey === mergeKey) {
      for (const patch of patches) {
        const existing = top.patches.get(patch.id);
        if (existing) existing.after = patch.after;
        else top.patches.set(patch.id, { ...patch });
      }
      // 合并后前后完全一样（比如新建了又删掉），这一步就没有存在的意义了
      if ([...top.patches.values()].every((p) => p.before === p.after)) this.undoStack.pop();
    } else {
      this.undoStack.push({ label, mergeKey, patches: new Map(patches.map((p) => [p.id, { ...p }])) });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this.sealed = false;
    this.redoStack = [];
    this.emit({ patches, source: 'transact' });
    return result;
  }

  /** 结束一段连续操作：之后的事务不再并入上一步撤销 */
  sealHistory(): void {
    this.sealed = true;
  }

  /**
   * 放弃一段还没结束的连续操作（比如拖动到一半按了 Esc）：把带这个合并键的那一步整个撤回，
   * 从撤销历史里拿掉，也不放进重做。最上面那一步不是它、或者已经封口了，什么都不做，返回 false
   */
  abandon(mergeKey: string): boolean {
    const top = this.undoStack.at(-1);
    if (this.sealed || !top || top.mergeKey !== mergeKey) return false;
    this.undoStack.pop();
    this.apply(top.patches.values(), 'before');
    this.sealed = true;
    this.emit({
      patches: [...top.patches.values()].map((p) => ({ id: p.id, before: p.after, after: p.before })),
      source: 'abandon',
    });
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.apply(entry.patches.values(), 'before');
    this.redoStack.push(entry);
    this.sealed = true;
    this.emit({
      patches: [...entry.patches.values()].map((p) => ({ id: p.id, before: p.after, after: p.before })),
      source: 'undo',
    });
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.apply(entry.patches.values(), 'after');
    this.undoStack.push(entry);
    this.sealed = true;
    this.emit({ patches: [...entry.patches.values()], source: 'redo' });
    return true;
  }

  /** 加一个整理器，排在已有的后面。返回取消的函数 */
  addNormalizer(normalizer: Normalizer): () => void {
    this.normalizers.push(normalizer);
    return () => {
      this.normalizers = this.normalizers.filter((n) => n !== normalizer);
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private apply(patches: Iterable<Patch>, side: 'before' | 'after'): void {
    for (const patch of patches) {
      const node = patch[side];
      if (node) this.nodes.set(patch.id, node);
      else this.nodes.delete(patch.id);
    }
    this.childrenCache = null;
  }

  private emit(change: StoreChange): void {
    this.childrenCache = null;
    this._version += 1;
    for (const listener of [...this.listeners]) listener(change);
  }
}

const EMPTY: readonly SceneNode[] = Object.freeze([]);

function compareIndex(a: SceneNode, b: SceneNode): number {
  if (a.index < b.index) return -1;
  if (a.index > b.index) return 1;
  return a.id < b.id ? -1 : 1;
}

/** 在 a 与 b 之间生成一个索引；null 表示开头或结尾 */
export function keyBetween(a: string | null, b: string | null): string {
  return generateKeyBetween(a, b);
}

/** 在 a 与 b 之间生成 n 个递增的索引 */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  return generateNKeysBetween(a, b, n);
}
