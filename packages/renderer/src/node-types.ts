import type { BlendMode as SkBlendMode, Canvas, CanvasKit, Paint, Path } from 'canvaskit-wasm';
import type { NodeType, NodeTypeMap, Rect, SceneNode } from '@shiba/core';
import type { ImageCache } from './images';

/**
 * 节点类型注册表：渲染器、命中测试、边界计算都通过它认识节点。
 *
 * 新增一种节点（比如文本、图片）：
 *   1. 在数据模型里用声明合并往 NodeTypeMap 加类型；
 *   2. 写一个 NodeTypeDef，调用 registry.register(def)。
 * 渲染器本身不需要改。
 */

export interface OutlineContext {
  ck: CanvasKit;
  /** 子节点，从下到上 */
  children(node: SceneNode): readonly SceneNode[];
  /** 另一个节点的轮廓（它自己的本地坐标）。由缓存持有，不要 delete */
  outlineOf(node: SceneNode): Path;
}

export interface DrawContext {
  ck: CanvasKit;
  canvas: Canvas;
  /** 节点的轮廓，本地坐标 */
  outline: Path;
  /** 需要直接乘到颜色上的不透明度；已经开了离屏层时为 1 */
  opacity: number;
  /** 需要直接设到画笔上的混合模式；已经开了离屏层时为 SrcOver */
  blendMode: SkBlendMode;
  /** 可复用的画笔，用前自行设置所有属性 */
  paint: Paint;
  /** 图片缓存；渲染器没有配图片缓存时为 null */
  images: ImageCache | null;
  /** 节点在本地坐标里的几何边界，图片填充按它来铺。用到时才算，所以是函数 */
  bounds(): Rect;
}

/**
 * 子节点的处理方式：
 * - none     叶子节点
 * - draw     容器，画完自己再依次画子节点
 * - clip     容器，子节点被自己的轮廓裁剪（画板）
 * - consume  子节点是运算输入，不单独绘制（布尔组）
 */
export type ChildrenMode = 'none' | 'draw' | 'clip' | 'consume';

export interface NodeTypeDef<T extends SceneNode = SceneNode> {
  type: T['type'];
  children: ChildrenMode;
  /** 轮廓依赖的其他节点；它们变化时轮廓会重算 */
  outlineDeps?(node: T, ctx: OutlineContext): readonly SceneNode[];
  /** 生成轮廓（本地坐标）。返回的 Path 交给缓存管理 */
  outline(node: T, ctx: OutlineContext): Path;
  /** 自定义绘制；不提供时按 fill / stroke 绘制轮廓 */
  draw?(node: T, ctx: DrawContext): void;
}

export class NodeTypeRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private defs = new Map<string, NodeTypeDef<any>>();

  register<K extends NodeType>(def: NodeTypeDef<NodeTypeMap[K]>): this {
    this.defs.set(def.type, def);
    return this;
  }

  get(type: string): NodeTypeDef | undefined {
    return this.defs.get(type);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }
}
