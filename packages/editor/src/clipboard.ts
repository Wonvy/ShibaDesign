import {
  DOCUMENT_VERSION,
  GLYPH_LIBRARY_MIME,
  IDENTITY,
  ancestors,
  applyToPoint,
  assetIdsOf,
  canPlaceInstance,
  colorStyles,
  componentOf,
  createId,
  createNode,
  descendants,
  instanceNodes,
  invert,
  isComponent,
  isInstance,
  isInstanceCopy,
  keysBetween,
  multiply,
  nextSeq,
  rectCenter,
  rectsIntersect,
  slides,
  solid,
  rgba,
  sortByZOrder,
  textStyles,
  topLevelOnly,
  transformRect,
  translation,
  unionRects,
  validateDocument,
  worldTransform,
  type AssetMeta,
  type Matrix,
  type NodeId,
  type NodeType,
  type Point,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from './editor';

/**
 * 剪贴板：把选中的对象（连同用到的图片）变成一段可以放进系统剪贴板的数据，再从这段数据粘贴回来。
 *
 * 这里只管数据和放置规则，不碰浏览器的剪贴板接口：界面层在 copy / paste 事件里调这里的函数，
 * 把结果写进 text/html（所有浏览器、跨标签页都能用，Figma 也是这么做的）。
 * 粘贴的数据是不可信输入：用文档校验（validate.ts）检查节点结构，资源按内容重新算 id。
 */

export const FRAGMENT_FORMAT = 'shibadesign/fragment';
export const FRAGMENT_VERSION = 1;

/** 一次最多粘贴多少个节点 */
const MAX_FRAGMENT_NODES = 20_000;
/** 内嵌进剪贴板的资源合计不超过这么多字节，超过的只记 id（同一份文档里照样能粘贴） */
const MAX_INLINE_ASSET_BYTES = 20 * 1024 * 1024;
/** 粘贴到原来的位置、原件还在那里时，往右下错开多少（和创建副本一样） */
export const PASTE_OFFSET = 16;
/** 粘贴进来的画板放在已有画板右边，隔这么远（和新建画板一样） */
const ARTBOARD_GAP = 80;
const ASSET_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', GLYPH_LIBRARY_MIME]);
/** 和文本工具新建的文字同一个颜色 */
const DEFAULT_TEXT_COLOR = rgba(0.1, 0.1, 0.1);
/** 粘贴纯文字时最长的一行超过这么多字就改成固定宽度、自动折行 */
const WRAP_AFTER_CHARS = 80;
const WRAP_WIDTH = 480;
const MAX_PLAIN_TEXT = 100_000;

export interface FragmentAsset {
  meta: AssetMeta;
  /** 资源内容的 base64；太大时省略，只能粘贴进已经有这份资源的文档 */
  data?: string;
}

export interface ClipboardFragment {
  format: typeof FRAGMENT_FORMAT;
  version: number;
  /** 每复制一次一个新 id：连续粘贴同一份内容时，靠它决定每次再往右下错开一点 */
  id: string;
  /** 来源文档根页面的 id。粘贴进同一份文档时，组件、样式的链接保持 */
  document: NodeId;
  /** 来源容器（这些对象最近的公共父节点）：id、它自己坐标里的范围（页面为 null）、本地到世界的变换 */
  container: { id: NodeId; box: Rect | null; world: Matrix };
  /** 内容在来源容器坐标里的外框 */
  bounds: Rect;
  /** 最外层的节点，按层叠顺序从下到上 */
  roots: NodeId[];
  /** 全部节点，父节点在前。roots 的 parent 是 container.id，transform 已经换算到容器坐标里 */
  nodes: SceneNode[];
  assets: FragmentAsset[];
}

export type PasteMode =
  /** 按规则找位置：容器一样大时保持相对位置，原件还在原处时错开 */
  | { kind: 'auto' }
  /** 原位粘贴：世界坐标不变，不错开 */
  | { kind: 'inPlace' }
  /** 粘贴到这里：内容的中心放在这个世界坐标上 */
  | { kind: 'at'; point: Point };

export interface PasteResult {
  /** 新建的最外层节点 */
  ids: NodeId[];
  /** 没带过来、这份文档里也没有的资源有几个（图片会显示不出来） */
  missingAssets: number;
}

export class FragmentError extends Error {}

// ───────────── 复制 ─────────────

/** 把一组节点变成剪贴板数据。没有可复制的东西时返回 null */
export function copyFragment(editor: Editor, ids: readonly NodeId[] = editor.selection): ClipboardFragment | null {
  const { store } = editor;
  const wanted = topLevelOnly(
    store,
    ids.filter((id) => {
      const node = store.get(id);
      return node !== undefined && node.type !== 'page';
    }),
  );
  const roots = sortByZOrder(store, wanted);
  if (roots.length === 0) return null;

  const container = commonContainer(editor, roots);
  const world = worldTransform(store, container.id);
  const toContainer = invert(world) ?? IDENTITY;
  const nodes: SceneNode[] = [];
  const rects: Rect[] = [];
  for (const root of roots) {
    const local = multiply(toContainer, worldTransform(store, root.id));
    nodes.push({ ...root, parent: container.id, transform: local } as SceneNode);
    nodes.push(...descendants(store, root.id));
    rects.push(transformRect(toContainer, editor.geometry.worldBounds(root)));
  }

  const assets: FragmentAsset[] = [];
  let budget = MAX_INLINE_ASSET_BYTES;
  for (const id of new Set(nodes.flatMap(assetIdsOf))) {
    const meta = editor.assets.meta(id);
    const bytes = editor.assets.get(id);
    if (!meta || !bytes) continue;
    const inline = bytes.byteLength <= budget;
    if (inline) budget -= bytes.byteLength;
    assets.push(inline ? { meta, data: toBase64(bytes) } : { meta });
  }

  return {
    format: FRAGMENT_FORMAT,
    version: FRAGMENT_VERSION,
    id: createId(),
    document: store.root.id,
    container: { id: container.id, box: containerBox(editor, container), world },
    bounds: unionRects(rects) ?? { x: 0, y: 0, w: 0, h: 0 },
    roots: roots.map((r) => r.id),
    nodes,
    assets,
  };
}

/** 几个节点最近的公共父节点；里面有画板时就是页面 */
function commonContainer(editor: Editor, roots: readonly SceneNode[]): SceneNode {
  const { store } = editor;
  if (roots.some((r) => r.type === 'artboard')) return store.root;
  const chains = roots.map((r) => ancestors(store, r.id));
  const others = chains.slice(1).map((chain) => new Set(chain.map((n) => n.id)));
  return chains[0]!.find((candidate) => others.every((set) => set.has(candidate.id))) ?? store.root;
}

/** 容器在它自己坐标里的范围：画板是它的大小，编组是内容的范围，页面没有范围 */
function containerBox(editor: Editor, container: SceneNode): Rect | null {
  if (container.type === 'page') return null;
  if (container.type === 'artboard') return { x: 0, y: 0, w: container.size[0], h: container.size[1] };
  return editor.geometry.localBounds(container);
}

// ───────────── 写进、读出剪贴板的文字 ─────────────

const MARKER = 'data-shibadesign-fragment';

/**
 * 写进剪贴板 text/html 的内容。数据转成 base64 放在一个属性里，浏览器读剪贴板时的过滤会保留它；
 * 里面的文字是给粘贴到别的软件里看的
 */
export function fragmentToHtml(fragment: ClipboardFragment, plain: string): string {
  const data = toBase64(new TextEncoder().encode(JSON.stringify(fragment)));
  return `<meta charset="utf-8"><span ${MARKER}="${data}">${escapeHtml(plain)}</span>`;
}

/** 从剪贴板的 text/html 里取出数据。不是我们的数据时返回 null；是我们的但坏了时抛 FragmentError */
export function fragmentFromHtml(html: string): ClipboardFragment | null {
  const match = new RegExp(`${MARKER}="([A-Za-z0-9+/=]+)"`).exec(html);
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(fromBase64(match[1]!)));
  } catch {
    throw new FragmentError('unreadable');
  }
  return validateFragment(data);
}

/** 检查剪贴板数据的结构：节点照打开文件的规则校验，资源只收认识的类型 */
export function validateFragment(data: unknown): ClipboardFragment {
  const fail = (why: string): never => {
    throw new FragmentError(why);
  };
  if (!isObject(data) || data.format !== FRAGMENT_FORMAT) fail('format');
  const d = data as Record<string, unknown>;
  if (typeof d.version !== 'number' || d.version > FRAGMENT_VERSION) fail('version');
  if (typeof d.id !== 'string' || typeof d.document !== 'string') fail('ids');
  const container = d.container;
  if (!isObject(container) || typeof container.id !== 'string' || !isMatrix(container.world)) fail('container');
  const box = (container as Record<string, unknown>).box;
  if (box !== null && !isRect(box)) fail('container');
  if (!isRect(d.bounds)) fail('bounds');
  if (!Array.isArray(d.nodes) || d.nodes.length === 0 || d.nodes.length > MAX_FRAGMENT_NODES) fail('nodes');
  if (!Array.isArray(d.roots) || d.roots.length === 0) fail('roots');
  if (!Array.isArray(d.assets)) fail('assets');

  const containerId = (container as { id: string }).id;
  const nodes: Record<string, unknown> = {};
  for (const node of d.nodes as unknown[]) {
    if (!isObject(node) || typeof node.id !== 'string' || node.id === containerId || node.id in nodes) fail('nodes');
    nodes[(node as { id: string }).id] = node;
  }
  const roots = new Set(d.roots as unknown[]);
  for (const id of roots) {
    const node = typeof id === 'string' ? nodes[id] : undefined;
    if (!isObject(node) || node.parent !== containerId) fail('roots');
  }
  for (const node of Object.values(nodes) as Record<string, unknown>[]) {
    if (node.parent === containerId && !roots.has(node.id)) fail('roots');
    // 画板只能是最外层
    if (node.type === 'artboard' && !roots.has(node.id)) fail('nodes');
  }
  // 借文档校验检查节点：容器当成根页面
  const page = {
    id: containerId,
    type: 'page',
    lineageId: containerId,
    seq: 1,
    parent: null,
    index: 'a0',
    transform: IDENTITY,
    size: [0, 0],
    opacity: 1,
    blendMode: 'normal',
    visible: true,
    locked: false,
  };
  try {
    validateDocument({ version: DOCUMENT_VERSION, rootId: containerId, nodes: { ...nodes, [containerId]: page } });
  } catch {
    fail('nodes');
  }

  for (const asset of d.assets as unknown[]) {
    if (!isObject(asset) || !isObject(asset.meta)) fail('assets');
    const meta = (asset as { meta: Record<string, unknown> }).meta;
    if (typeof meta.id !== 'string' || !/^[0-9a-f]{40}$/.test(meta.id)) fail('assets');
    if (typeof meta.mime !== 'string' || !ASSET_MIMES.has(meta.mime)) fail('assets');
    if (!isFiniteNumber(meta.width) || !isFiniteNumber(meta.height)) fail('assets');
    const content = (asset as { data?: unknown }).data;
    if (content !== undefined && (typeof content !== 'string' || content.length > MAX_INLINE_ASSET_BYTES * 2)) {
      fail('assets');
    }
  }
  return data as ClipboardFragment;
}

// ───────────── 粘贴 ─────────────

/** 连续粘贴同一份内容时记着粘了几次，每次多错开一点 */
const lastPaste = new WeakMap<Editor, { fragment: string; container: NodeId; count: number }>();

/** 粘贴剪贴板数据。资源要按内容重新算 id，所以是异步的 */
export async function pasteFragment(
  editor: Editor,
  fragment: ClipboardFragment,
  mode: PasteMode = { kind: 'auto' },
): Promise<PasteResult> {
  const { map, missing } = await importAssets(editor, fragment.assets);
  const neededMissing = new Set(fragment.nodes.flatMap(assetIdsOf).filter((id) => missing.has(id)));
  const ids = insertFragment(editor, fragment, mode, map);
  return { ids, missingAssets: neededMissing.size };
}

/**
 * 把资源放进资源库：带了内容的按内容重新算 id（不信任剪贴板里写的 id），没带内容的看资源库里有没有。
 * 返回旧 id 到新 id 的对照，以及缺了的资源
 */
async function importAssets(
  editor: Editor,
  assets: readonly FragmentAsset[],
): Promise<{ map: Map<string, string>; missing: Set<string> }> {
  const map = new Map<string, string>();
  const missing = new Set<string>();
  for (const { meta, data } of assets) {
    if (editor.assets.has(meta.id)) continue;
    if (data === undefined) {
      missing.add(meta.id);
      continue;
    }
    try {
      const bytes = fromBase64(data);
      const info = { mime: meta.mime, width: meta.width, height: meta.height, name: meta.name };
      const added =
        meta.mime === GLYPH_LIBRARY_MIME
          ? await editor.assets.add(bytes, info)
          : await editor.importImage(bytes, { mime: meta.mime, name: meta.name });
      if (!added) missing.add(meta.id);
      else if (added.id !== meta.id) map.set(meta.id, added.id);
    } catch {
      missing.add(meta.id);
    }
  }
  return { map, missing };
}

/** 粘贴的同步部分：选容器、算位置、换 id、整理组件和样式的链接，一步撤销。返回新建的最外层节点 */
export function insertFragment(
  editor: Editor,
  fragment: ClipboardFragment,
  mode: PasteMode,
  assetMap: ReadonlyMap<string, string> = new Map(),
): NodeId[] {
  const { store } = editor;
  const byId = new Map(fragment.nodes.map((n) => [n.id, n]));
  const kids = new Map<NodeId, SceneNode[]>();
  for (const node of fragment.nodes) {
    if (node.parent === null) continue;
    const list = kids.get(node.parent) ?? [];
    list.push(node);
    kids.set(node.parent, list);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  const roots = fragment.roots.map((id) => byId.get(id)!);
  const hasBoards = roots.some((r) => r.type === 'artboard');

  let container = hasBoards ? store.root : pasteContainer(editor, mode);
  // 主组件里不能出现它自己的实例：这种时候放到页面上（和放实例的规则一样）
  if (fragment.nodes.some((n) => isInstance(n) && isComponent(store.get(n.instanceOf)))) {
    const blocked = fragment.nodes.some(
      (n) =>
        isInstance(n) && isComponent(store.get(n.instanceOf)) && !canPlaceInstance(store, n.instanceOf, container.id),
    );
    if (blocked) container = store.root;
  }

  const shift = hasBoards ? boardShift(editor, fragment) : placementShift(editor, fragment, container, mode);
  const indices = rootIndices(editor, container, roots.length);

  const sameDoc = fragment.document === store.root.id;
  const idMap = new Map(fragment.nodes.map((n) => [n.id, createId()]));
  const seqs = new Map<string, number>();
  const seqFor = (type: string): number => {
    const next = seqs.get(type) ?? nextSeq(store, type as NodeType);
    seqs.set(type, next + 1);
    return next;
  };
  const styleIds = new Set([...colorStyles(store), ...textStyles(store)].map((s) => s.id));
  const insideMain = componentOf(store, container.id) !== null;
  const deckOrders = slideOrders(editor, roots.filter((r) => r.type === 'artboard' && r.deck).length);

  const out: SceneNode[] = [];
  const created: NodeId[] = [];

  const visit = (
    node: SceneNode,
    parent: NodeId,
    index: string,
    transform: Matrix,
    inInstance: boolean,
    isRoot: boolean,
  ): void => {
    // 同一份文档里复制主组件再粘贴，得到它的一个实例，免得一不小心多出一个主组件（和 Figma 一样）
    const existingMain = isComponent(node) && sameDoc && isComponent(store.get(node.id)) ? node.id : null;
    // 单独复制了实例里嵌套的实例：重新做一个这个组件的实例（里面副本的对应关系是相对外层实例的，搬不过来）
    const nestedMain =
      isRoot && isInstanceCopy(node) && isInstance(node) && isComponent(store.get(node.instanceOf))
        ? node.instanceOf
        : null;
    const asInstance = existingMain ?? nestedMain;
    if (asInstance && !inInstance && canPlaceInstance(store, asInstance, container.id)) {
      const nodes = instanceNodes(store, asInstance, { parent, index, transform, seq: seqFor('group') });
      out.push(...nodes);
      if (isRoot) created.push(nodes[0]!.id);
      return;
    }

    const next = {
      ...node,
      id: idMap.get(node.id)!,
      lineageId: createId(),
      parent,
      index,
      transform,
      seq: seqFor(node.type),
    } as Record<string, unknown>;

    let keepsInstance = false;
    if (isInstance(node)) {
      const mapped = idMap.get(node.instanceOf);
      if (mapped) {
        next.instanceOf = mapped;
        keepsInstance = true;
      } else if (isComponent(store.get(node.instanceOf))) {
        keepsInstance = true;
      } else {
        // 主组件不在这份文档里：分离成普通编组
        delete next.instanceOf;
      }
    }
    // 主组件不能放进主组件或实例里
    if (next.component === true && (insideMain || inInstance)) delete next.component;
    if (node.source !== undefined) {
      const mapped = idMap.get(node.source);
      if (inInstance && (mapped || store.has(node.source))) {
        if (mapped) next.source = mapped;
      } else {
        delete next.source;
        delete next.overrides;
      }
    }
    unlinkMissingStyles(next, styleIds);
    remapAssets(next, assetMap);
    if (node.type === 'artboard' && node.deck) {
      const animations = node.deck.animations?.flatMap((a) => {
        const target = idMap.get(a.target);
        return target ? [{ ...a, id: createId(), target }] : [];
      });
      const { animations: _old, ...deck } = node.deck;
      next.deck = {
        ...deck,
        order: deckOrders.shift() ?? node.deck.order,
        ...(animations && animations.length > 0 ? { animations } : {}),
      };
    }

    out.push(next as unknown as SceneNode);
    if (isRoot) created.push(next.id as NodeId);
    for (const child of kids.get(node.id) ?? []) {
      visit(child, next.id as NodeId, child.index, child.transform, inInstance || keepsInstance, false);
    }
  };

  roots.forEach((root, i) => visit(root, container.id, indices[i]!, multiply(shift, root.transform), false, true));

  store.transact('paste', (tx) => out.forEach((node) => tx.create(node)));
  store.sealHistory();
  editor.select(created);
  if (hasBoards && editor.viewMode === 'slides') {
    const board = created.map((id) => store.get(id)).find((n) => n?.type === 'artboard' && n.deck);
    if (board) editor.setActiveArtboard(board.id);
  }
  return created;
}

/**
 * 粘贴进哪个容器：选中的是画板就粘进它里面；选中了别的东西就粘进它们所在的容器（放在它们上面）；
 * 都没有时是当前画板（幻灯片视图）或视口中间的画板。实例里不能加东西，碰到实例往外退
 */
function pasteContainer(editor: Editor, mode: PasteMode): SceneNode {
  const { store } = editor;
  const usable = (node: SceneNode | undefined): SceneNode => {
    let current = node;
    for (let guard = 0; current && guard < 10_000; guard++) {
      if (!isInstance(current) && !isInstanceCopy(current)) return current;
      current = current.parent ? store.get(current.parent) : undefined;
    }
    return store.root;
  };
  if (mode.kind === 'at') return usable(editor.containerAt(mode.point));
  const selected = editor.selectedNodes();
  if (selected.length === 1 && selected[0]!.type === 'artboard') return selected[0]!;
  const top = topLevelOnly(store, editor.selection)[0];
  const parent = top ? store.get(store.get(top)?.parent ?? '') : undefined;
  if (parent) return usable(parent);
  if (editor.viewMode === 'slides') return editor.activeArtboard ?? store.root;
  const view = visibleWorld(editor);
  return view ? usable(editor.containerAt(rectCenter(view))) : (editor.activeArtboard ?? store.root);
}

/** 视口在世界坐标里的范围；还没挂载（测试里）时为 null */
function visibleWorld(editor: Editor): Rect | null {
  const { width, height } = editor.viewport;
  if (width <= 0 || height <= 0) return null;
  const a = editor.screenToWorld(0, 0);
  const b = editor.screenToWorld(width, height);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/**
 * 内容放到目标容器里要整体挪多少：返回一个矩阵，乘在每个最外层节点（来源容器坐标里的）变换前面，
 * 得到它在目标容器坐标里的变换
 */
function placementShift(editor: Editor, fragment: ClipboardFragment, container: SceneNode, mode: PasteMode): Matrix {
  const { store } = editor;
  const targetWorld = worldTransform(store, container.id);
  const toTarget = invert(targetWorld) ?? IDENTITY;
  const bounds = fragment.bounds;

  if (mode.kind === 'inPlace') return multiply(toTarget, fragment.container.world);
  if (mode.kind === 'at') {
    const [px, py] = applyToPoint(toTarget, mode.point.x, mode.point.y);
    const center = rectCenter(bounds);
    return translation(px - center.x, py - center.y);
  }

  let base: Matrix;
  const box = containerBox(editor, container);
  if (!box) {
    // 粘到页面上：世界坐标不变；看不见的话挪到视口中间
    base = multiply(toTarget, fragment.container.world);
    const world = transformRect(fragment.container.world, bounds);
    const view = visibleWorld(editor);
    if (view && !rectsIntersect(world, view)) {
      const from = rectCenter(world);
      const to = rectCenter(view);
      base = multiply(toTarget, multiply(translation(to.x - from.x, to.y - from.y), fragment.container.world));
    }
  } else {
    const source = fragment.container.box;
    const sameSize = source !== null && Math.abs(source.w - box.w) < 0.5 && Math.abs(source.h - box.h) < 0.5;
    const fits =
      bounds.x >= box.x &&
      bounds.y >= box.y &&
      bounds.x + bounds.w <= box.x + box.w &&
      bounds.y + bounds.h <= box.y + box.h;
    if (sameSize || fits) {
      // 一样大的画板之间（比如从第 3 页粘到第 5 页）保持相对位置
      base = IDENTITY;
    } else {
      const from = rectCenter(bounds);
      const to = rectCenter(box);
      base = translation(to.x - from.x, to.y - from.y);
    }
  }

  // 粘到原来的位置、原件还在那里，或者接着上一次粘贴同一份内容：往右下错开
  const previous = lastPaste.get(editor);
  const repeat = previous?.fragment === fragment.id && previous.container === container.id;
  const count = repeat ? previous.count + 1 : originalsInPlace(editor, fragment, container, base) ? 1 : 0;
  lastPaste.set(editor, { fragment: fragment.id, container: container.id, count });
  return count > 0 ? multiply(translation(PASTE_OFFSET * count, PASTE_OFFSET * count), base) : base;
}

/** 原件是不是还在粘贴后会落到的地方（同一份文档、同一个容器、位置没变） */
function originalsInPlace(editor: Editor, fragment: ClipboardFragment, container: SceneNode, base: Matrix): boolean {
  const { store } = editor;
  if (fragment.document !== store.root.id) return false;
  const containerWorld = worldTransform(store, container.id);
  return fragment.roots.every((id) => {
    const original = store.get(id);
    const copy = fragment.nodes.find((n) => n.id === id);
    if (!original || !copy) return false;
    const now = multiply(invert(containerWorld) ?? IDENTITY, worldTransform(store, id));
    const placed = multiply(base, copy.transform);
    return Math.abs(now[4] - placed[4]) < 0.5 && Math.abs(now[5] - placed[5]) < 0.5;
  });
}

/** 粘贴画板：放在已有画板的右边，顶边对齐原来的位置 */
function boardShift(editor: Editor, fragment: ClipboardFragment): Matrix {
  const { store } = editor;
  const boards = store.children(store.root.id).filter((n) => n.type === 'artboard');
  const base = fragment.container.world;
  if (boards.length === 0) return base;
  const right = Math.max(...boards.map((b) => editor.geometry.worldBounds(b)).map((r) => r.x + r.w));
  const world = transformRect(base, fragment.bounds);
  return multiply(translation(right + ARTBOARD_GAP - world.x, 0), base);
}

/** 新的最外层节点的分数索引：放在选中的同级对象上面，没有时放在最上面 */
function rootIndices(editor: Editor, container: SceneNode, count: number): string[] {
  const { store } = editor;
  const siblings = store.children(container.id);
  const selected = siblings.filter((s) => editor.selection.includes(s.id));
  const top = selected.at(-1);
  if (top) {
    const above = siblings[siblings.indexOf(top) + 1];
    return keysBetween(top.index, above?.index ?? null, count);
  }
  return keysBetween(siblings.at(-1)?.index ?? null, null, count);
}

/** 粘贴进来的幻灯片排在当前这一页后面 */
function slideOrders(editor: Editor, count: number): string[] {
  if (count === 0) return [];
  const deck = slides(editor.store);
  const active = editor.activeArtboard;
  const at = active?.deck ? deck.findIndex((s) => s.id === active.id) : deck.length - 1;
  const lower = deck[at]?.deck?.order ?? null;
  const upper = deck[at + 1]?.deck?.order ?? null;
  return keysBetween(lower, upper, count);
}

/** 链接的样式这份文档里没有：断开链接，值留着 */
function unlinkMissingStyles(node: Record<string, unknown>, styleIds: ReadonlySet<string>): void {
  for (const key of ['fill', 'stroke'] as const) {
    const paint = node[key] as { colorStyle?: string } | null | undefined;
    if (paint?.colorStyle && !styleIds.has(paint.colorStyle)) {
      const { colorStyle: _gone, ...rest } = paint;
      node[key] = rest;
    }
  }
  if (typeof node.textStyle === 'string' && !styleIds.has(node.textStyle)) delete node.textStyle;
}

/** 资源按内容重新算出的 id 和剪贴板里写的不一样时，换成新的 */
function remapAssets(node: Record<string, unknown>, map: ReadonlyMap<string, string>): void {
  if (map.size === 0) return;
  const fill = node.fill as { type?: string; assetId?: string } | null | undefined;
  if (fill?.type === 'image' && fill.assetId && map.has(fill.assetId)) {
    node.fill = { ...fill, assetId: map.get(fill.assetId) };
  }
  const appearance = node.appearance as { runs: { library: string }[] } | undefined;
  if (appearance) {
    node.appearance = {
      ...appearance,
      runs: appearance.runs.map((run) => (map.has(run.library) ? { ...run, library: map.get(run.library) } : run)),
    };
  }
}

// ───────────── 纯文字 ─────────────

/** 从别的软件粘贴进来的纯文字：在视口中间（或者当前画板中间）建一个文本 */
export function pastePlainText(editor: Editor, raw: string): NodeId | null {
  const text = raw.replace(/\r\n?/g, '\n').slice(0, MAX_PLAIN_TEXT);
  if (text.trim() === '') return null;
  const { store } = editor;
  const container = pasteContainer(editor, { kind: 'auto' });
  const longest = Math.max(...text.split('\n').map((line) => line.length));
  const wrap = longest > WRAP_AFTER_CHARS;
  const node = createNode('text', {
    parent: container.id,
    index: rootIndices(editor, container, 1)[0]!,
    seq: nextSeq(store, 'text'),
    size: [wrap ? WRAP_WIDTH : 0, 0],
    text,
    style: editor.defaultTextStyle,
    align: 'left',
    sizing: wrap ? 'fixed' : 'auto',
    fill: solid(DEFAULT_TEXT_COLOR),
  });
  // 先排一次版量出大小，让文字的中心落在目标位置
  const layout = editor.textLayouts.get(node);
  const view = visibleWorld(editor);
  const box = containerBox(editor, container);
  const toTarget = invert(worldTransform(store, container.id)) ?? IDENTITY;
  const center = view ? rectCenter(view) : box ? rectCenter(box) : { x: 0, y: 0 };
  const [tx0, ty0]: [number, number] = view ? applyToPoint(toTarget, center.x, center.y) : [center.x, center.y];
  const placed = { ...node, transform: translation(tx0 - layout.width / 2, ty0 - layout.height / 2) };
  store.transact('paste text', (tx) => tx.create(placed));
  store.sealHistory();
  editor.select([placed.id]);
  return placed.id;
}

// ───────────── 小工具 ─────────────

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isMatrix(value: unknown): boolean {
  return Array.isArray(value) && value.length === 6 && value.every(isFiniteNumber);
}

function isRect(value: unknown): value is Rect {
  return isObject(value) && [value.x, value.y, value.w, value.h].every(isFiniteNumber);
}
