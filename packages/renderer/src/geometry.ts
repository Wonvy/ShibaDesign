import type { CanvasKit, Path } from 'canvaskit-wasm';
import { arrowPaths } from './arrows';
import {
  applyToPoint,
  hasShapeStyle,
  invert,
  maskParts,
  transformRect,
  unionRects,
  worldTransform,
  type DocStore,
  type NodeId,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import { clipsChildren, type NodeTypeRegistry, type OutlineContext } from './node-types';
import { strokeBounds } from './path-ops';

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
      // 蒙版组的范围就是蒙版的范围
      const { mask } = maskParts(this.store, node);
      if (mask?.visible) return transformRect(mask.transform, this.localBounds(mask));
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

  /**
   * 节点画出来的范围（本地坐标）：几何边界再加上描边，端点、拐角都算在内。导出图片时按它裁，描边不会被切掉一半。
   * 编组是子节点画出来的范围合起来；蒙版组只露出蒙版范围里的东西。布尔组的运算对象自己的描边不画，不算
   */
  drawnBounds(node: SceneNode): Rect {
    const def = this.registry.get(node.type);
    if (def?.children === 'draw') {
      const { mask } = maskParts(this.store, node);
      if (mask?.visible) {
        const clip = node.type === 'group' && node.mask === 'shape' ? this.localBounds(mask) : this.drawnBounds(mask);
        return transformRect(mask.transform, clip);
      }
      const rects = this.store
        .children(node.id)
        .filter((c) => c.visible)
        .map((c) => transformRect(c.transform, this.drawnBounds(c)));
      return unionRects(rects) ?? EMPTY_RECT;
    }
    const bounds = this.localBounds(node);
    // 关了裁剪的画框：里面伸出去的东西也画出来
    const overflow =
      def?.children === 'clip' && !clipsChildren(def, node)
        ? this.store
            .children(node.id)
            .filter((c) => c.visible)
            .map((c) => transformRect(c.transform, this.drawnBounds(c)))
        : [];
    if (!hasShapeStyle(node) || !node.stroke) return unionRects([bounds, ...overflow])!;
    const stroke = strokeBounds(this.ck, this.outlineOf(node), node.stroke);
    const rects = stroke ? [bounds, stroke, ...overflow] : [bounds, ...overflow];
    // 箭头伸出线的端点
    const arrows = arrowPaths(this.ck, node);
    if (arrows) {
      const [x0, y0, x1, y1] = arrows.heads.computeTightBounds();
      if (Number.isFinite(x0) && x1! >= x0!) rects.push({ x: x0!, y: y0!, w: x1! - x0!, h: y1! - y0! });
      arrows.line.delete();
      arrows.heads.delete();
    }
    return unionRects(rects)!;
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

  /** 蒙版组坐标里的一点在不在蒙版里：形状看轮廓，文字、编组这类看范围 */
  private insideMask(mask: SceneNode, x: number, y: number): boolean {
    const inverse = invert(mask.transform);
    if (!inverse) return false;
    const [mx, my] = applyToPoint(inverse, x, y);
    const def = this.registry.get(mask.type);
    if (def && !def.draw && (def.children === 'none' || def.children === 'consume')) {
      return this.outlineOf(mask).contains(mx, my);
    }
    const b = this.localBounds(mask);
    return mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h;
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
      // 画板、画框：点在自己的轮廓里时，没点中里面的东西就是点中了自己（空白处）；
      // 裁剪内容的，轮廓外面什么都点不中
      const inside = def.children === 'clip' && this.outlineOf(node).contains(x, y);
      if (clipsChildren(def, node) && !inside) return null;
      // 蒙版组：只有蒙版范围里的内容点得中，蒙版本身点不中（在图层列表里选）
      const { mask, contents } = maskParts(this.store, node);
      if (mask?.visible) {
        if (!this.insideMask(mask, x, y)) return null;
        for (let i = contents.length - 1; i >= 0; i--) {
          const hit = this.hitNode(contents[i]!, x, y, tolerance);
          if (hit) return hit;
        }
        return null;
      }
      const kids = this.store.children(node.id);
      for (let i = kids.length - 1; i >= 0; i--) {
        const hit = this.hitNode(kids[i]!, x, y, tolerance);
        if (hit) return hit;
      }
      return inside ? node : null;
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
