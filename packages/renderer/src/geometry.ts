import type { CanvasKit, Path } from 'canvaskit-wasm';
import {
  applyToPoint,
  hasShapeStyle,
  invert,
  transformRect,
  unionRects,
  worldTransform,
  type DocStore,
  type NodeId,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import type { NodeTypeRegistry, OutlineContext } from './node-types';

interface Entry {
  node: SceneNode;
  deps: readonly Path[];
  path: Path;
  bounds: Rect | null;
}

const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

/**
 * 几何缓存：每个节点的轮廓路径、边界，以及命中测试。
 * 节点对象不可变，所以用"节点对象是否还是同一个"来判断缓存是否过期。
 */
export class GeometryCache {
  private entries = new Map<NodeId, Entry>();
  private readonly ctx: OutlineContext;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ck: CanvasKit,
    private readonly store: DocStore,
    private readonly registry: NodeTypeRegistry,
  ) {
    this.ctx = {
      ck,
      children: (node) => store.children(node.id),
      outlineOf: (node) => this.outlineOf(node),
    };
    this.unsubscribe = store.subscribe((change) => {
      for (const patch of change.patches) {
        if (!patch.after) this.drop(patch.id);
      }
    });
  }

  /** 节点的轮廓，本地坐标。返回值由缓存持有，调用方不要 delete */
  outlineOf(node: SceneNode): Path {
    return this.resolve(node).path;
  }

  /** 节点在自己坐标系里的几何边界（不含描边） */
  localBounds(node: SceneNode): Rect {
    const def = this.registry.get(node.type);
    if (def?.children === 'draw') {
      const rects = this.store
        .children(node.id)
        .filter((c) => c.visible)
        .map((c) => transformRect(c.transform, this.localBounds(c)));
      return unionRects(rects) ?? EMPTY_RECT;
    }
    const entry = this.resolve(node);
    if (!entry.bounds) {
      const b = entry.path.computeTightBounds();
      entry.bounds = { x: b[0]!, y: b[1]!, w: b[2]! - b[0]!, h: b[3]! - b[1]! };
    }
    return entry.bounds;
  }

  /** 节点在世界坐标里的外接矩形 */
  worldBounds(node: SceneNode): Rect {
    return transformRect(worldTransform(this.store, node.id), this.localBounds(node));
  }

  /**
   * 命中测试。返回最上层被点中的节点；点在画板空白处时返回画板本身。
   * @param roots 从哪些节点开始找（它们的父变换会被自动考虑）
   * @param tolerance 世界坐标下的容差，用于细线和无填充形状
   */
  hitTest(worldX: number, worldY: number, roots: readonly NodeId[], tolerance: number): SceneNode | null {
    for (let i = roots.length - 1; i >= 0; i--) {
      const root = this.store.get(roots[i]!);
      if (!root) continue;
      let x = worldX;
      let y = worldY;
      if (root.parent) {
        const inv = invert(worldTransform(this.store, root.parent));
        if (!inv) continue;
        [x, y] = applyToPoint(inv, worldX, worldY);
      }
      const hit = this.hitNode(root, x, y, tolerance);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 丢弃满足条件的节点的缓存。用于轮廓取决于文档之外的东西的节点类型，
   * 比如文本的大小取决于字体是否加载完。
   */
  invalidate(predicate: (node: SceneNode) => boolean): void {
    for (const [id, entry] of this.entries) {
      if (!predicate(entry.node)) continue;
      entry.path.delete();
      this.entries.delete(id);
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const entry of this.entries.values()) entry.path.delete();
    this.entries.clear();
  }

  private resolve(node: SceneNode): Entry {
    const def = this.registry.get(node.type);
    const depNodes = def?.outlineDeps?.(node, this.ctx) ?? [];
    const deps = depNodes.map((d) => this.outlineOf(d));
    const cached = this.entries.get(node.id);
    if (cached && cached.node === node && sameItems(cached.deps, deps)) return cached;

    cached?.path.delete();
    const path = def ? def.outline(node, this.ctx) : new this.ck.Path();
    const entry: Entry = { node, deps, path, bounds: null };
    this.entries.set(node.id, entry);
    return entry;
  }

  private drop(id: NodeId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.path.delete();
    this.entries.delete(id);
  }

  /** (px, py) 是父节点坐标系里的点 */
  private hitNode(node: SceneNode, px: number, py: number, tolerance: number): SceneNode | null {
    if (!node.visible || node.locked) return null;
    const def = this.registry.get(node.type);
    if (!def) return null;
    const inv = invert(node.transform);
    if (!inv) return null;
    const [x, y] = applyToPoint(inv, px, py);

    if (def.children === 'draw' || def.children === 'clip') {
      if (def.children === 'clip' && !this.outlineOf(node).contains(x, y)) return null;
      const kids = this.store.children(node.id);
      for (let i = kids.length - 1; i >= 0; i--) {
        const hit = this.hitNode(kids[i]!, x, y, tolerance);
        if (hit) return hit;
      }
      return def.children === 'clip' ? node : null;
    }

    const outline = this.outlineOf(node);
    const styled = hasShapeStyle(node);
    const filled = !styled || node.fill !== null;
    if (filled && outline.contains(x, y)) return node;

    const strokeWidth = styled && node.stroke ? node.stroke.width : 0;
    if (strokeWidth > 0 || !filled) {
      const stroked = outline.makeStroked({ width: Math.max(strokeWidth, tolerance * 2) });
      if (stroked) {
        const hit = stroked.contains(x, y);
        stroked.delete();
        if (hit) return node;
      }
    }
    return null;
  }
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
