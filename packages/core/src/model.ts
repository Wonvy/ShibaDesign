/**
 * 文档数据模型。
 *
 * 所有节点都是不可变的普通对象，存放在一张以 id 为键的表里；
 * 树结构靠 `parent` + `index`（分数索引）表达，方便以后接入协同。
 *
 * 扩展新的节点类型：在自己的模块里用声明合并往 `NodeTypeMap` 加一项，
 * 再到渲染器里注册对应的 NodeTypeDef 即可，不需要改这个文件。
 */

import type { SlideAnimation, SlideTransition } from './animation';

export type NodeId = string;

/** 2×3 仿射矩阵 [a, b, c, d, e, f]：x' = a·x + c·y + e，y' = b·x + d·y + f */
export type Matrix = readonly [number, number, number, number, number, number];

/** 颜色分量均为 0–1 */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 16 种标准混合模式，与 CSS mix-blend-mode、PDF 混合模式一一对应 */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export interface SolidFill {
  type: 'solid';
  color: Color;
}

export const IMAGE_FITS = ['cover', 'contain', 'stretch'] as const;
/** cover：铺满并裁掉多余部分；contain：完整显示，可能留空；stretch：拉伸到正好填满 */
export type ImageFit = (typeof IMAGE_FITS)[number];

/**
 * 图片填充。图片不是单独的节点类型，而是形状的一种填充，
 * 所以任何形状（包括钢笔路径和布尔组）都天然是图片的蒙版。
 */
export interface ImageFill {
  type: 'image';
  /** 资源库里的图片 id，见 AssetStore */
  assetId: string;
  fit: ImageFit;
  /** 调色与模糊。省略表示不做任何调整 */
  adjust?: ImageAdjustments;
  /** 在形状里把图片再放大多少倍，最小为 1。省略表示 1 */
  zoom?: number;
  /** 图片在形状里的水平位置，-1 到 1：0 居中，1 表示把图片推到最右。省略表示 0 */
  panX?: number;
  /** 图片在形状里的垂直位置，-1 到 1：0 居中，1 表示把图片推到最下。省略表示 0 */
  panY?: number;
}

/**
 * 图片的非破坏性调整：只是一组参数，原图不动，随时可以改回去。
 * 亮度、对比度、饱和度、色相的算法与 CSS 滤镜的定义一致，
 * 这样以后导出成网页时可以直接用 CSS 实现同样的效果。
 */
export interface ImageAdjustments {
  /** 亮度，-100 到 100，0 为不变 */
  brightness: number;
  /** 对比度，-100 到 100 */
  contrast: number;
  /** 饱和度，-100 到 100；-100 是黑白 */
  saturation: number;
  /** 色温，-100（冷，偏蓝）到 100（暖，偏黄） */
  temperature: number;
  /** 色调，-100（偏绿）到 100（偏洋红） */
  tint: number;
  /** 色相旋转，-180 到 180 度 */
  hue: number;
  /** 模糊半径，0 到 100，单位与文档坐标相同 */
  blur: number;
}

export const NO_ADJUSTMENTS: ImageAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  hue: 0,
  blur: 0,
};

export type Fill = SolidFill | ImageFill;

export interface Stroke {
  color: Color;
  width: number;
}

export interface BaseNode {
  id: NodeId;
  type: string;
  /** 复制幻灯片时保留，平滑切换靠它在前后两页之间配对 */
  lineageId: string;
  /** 同类型内的序号，用来生成"矩形 3"这样的默认名 */
  seq: number;
  /** 用户起的名字；为空时界面按当前语言显示默认名 */
  name?: string;
  parent: NodeId | null;
  /** 同级排序用的分数索引，字典序越大越靠上 */
  index: string;
  /** 本地坐标 → 父节点坐标 */
  transform: Matrix;
  /** 本地坐标系里的盒子大小，盒子左上角在原点 */
  size: readonly [number, number];
  opacity: number;
  blendMode: BlendMode;
  visible: boolean;
  locked: boolean;
}

export interface ShapeStyle {
  fill: Fill | null;
  stroke: Stroke | null;
}

export interface PageNode extends BaseNode {
  type: 'page';
}

export interface SlideDeck {
  /** 幻灯片顺序的分数索引 */
  order: string;
  /** 演讲者备注 */
  notes: string;
  /** 进入这一页时的切换效果。省略表示没有效果 */
  transition?: SlideTransition;
  /** 这一页的动画，按播放顺序排列。省略表示没有动画 */
  animations?: readonly SlideAnimation[];
}

export interface ArtboardNode extends BaseNode {
  type: 'artboard';
  fill: SolidFill | null;
  /** 有这个字段就是一页幻灯片；order 是幻灯片顺序的分数索引 */
  deck: SlideDeck | null;
}

export interface RectNode extends BaseNode, ShapeStyle {
  type: 'rect';
  cornerRadius: number;
}

export interface EllipseNode extends BaseNode, ShapeStyle {
  type: 'ellipse';
}

/** 贝塞尔锚点。控制柄用本地绝对坐标；没有控制柄时与锚点重合 */
export interface Anchor {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface Subpath {
  closed: boolean;
  anchors: readonly Anchor[];
}

export interface PathNode extends BaseNode, ShapeStyle {
  type: 'path';
  subpaths: readonly Subpath[];
  fillRule: 'nonzero' | 'evenodd';
}

export const BOOLEAN_OPS = ['union', 'subtract', 'intersect', 'exclude'] as const;
export type BooleanOp = (typeof BOOLEAN_OPS)[number];

/** 非破坏性布尔组：子节点是运算对象，结果路径由渲染器实时计算 */
export interface BooleanNode extends BaseNode, ShapeStyle {
  type: 'boolean';
  op: BooleanOp;
}

export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export interface TextStyle {
  /** 西文和中文分别指定字体，排版时按字符自动切换 */
  fontFamily: { latin: string; cjk: string };
  fontSize: number;
  /** 字重，400 是常规，700 是粗体 */
  fontWeight: number;
  /** 行高，字号的倍数 */
  lineHeight: number;
  /** 字距，单位与字号相同 */
  letterSpacing: number;
}

/**
 * 文本。目前整段文字共用一个样式；以后加字符级样式时会新增一个按区间记录的字段，
 * 现有字段作为默认样式保留。
 */
export interface TextNode extends BaseNode {
  type: 'text';
  /** 内容，段落之间用 \n 分隔 */
  text: string;
  style: TextStyle;
  align: TextAlign;
  /**
   * auto：宽度随内容，只在换行符处折行；
   * fixed：宽度固定为 size[0]，自动折行。
   * 两种情况下高度都由排版结果决定，size[1] 不使用。
   */
  sizing: 'auto' | 'fixed';
  fill: SolidFill | null;
  /**
   * 保真外观：从别的文件（比如 PDF）导入的文字，在被改动之前按原文件的字形显示，看起来和原来一模一样。
   * 文字或排版参数一旦改动就不再使用它，改按上面的样式正常排版。见 text-appearance.ts。
   * 有保真外观时，size 就是原文件里这段文字占的范围（自动宽度也一样）。
   */
  appearance?: TextAppearance;
}

/**
 * 一组用同一个字形库、同样大小和方向的字形。
 * 字形库是资源库里的一份字形轮廓（见 text-appearance.ts），同一个字体的所有字形只存一份。
 */
export interface GlyphRun {
  /** 字形库的资源 id */
  library: string;
  /** 把字形从字形库的坐标（以字号为 1 个单位，y 向上）放到节点本地坐标的线性部分 [a, b, c, d] */
  matrix: readonly [number, number, number, number];
  /** 每 3 个数一组：字形在字形库里的序号、字形原点在节点本地坐标里的 x、y */
  glyphs: readonly number[];
}

export interface TextAppearance {
  runs: readonly GlyphRun[];
  /** 生成外观时文字和排版参数的指纹。和节点当前的对不上，说明改过了 */
  basis: string;
  /** 原文件里第一行基线的位置（本地坐标的 y）。换成正常排版时按它对齐，文字不会上下跳 */
  baseline: number;
}

/**
 * 编组：把几个对象当成一个整体来选择、移动、旋转和缩放。
 * 组自己没有外观，也不裁剪子节点；给组设置不透明度或混合模式时，子节点先合成再整体应用。
 */
export interface GroupNode extends BaseNode {
  type: 'group';
}

/** 节点类型表。其他模块可以通过声明合并扩展它 */
export interface NodeTypeMap {
  page: PageNode;
  artboard: ArtboardNode;
  rect: RectNode;
  ellipse: EllipseNode;
  path: PathNode;
  boolean: BooleanNode;
  text: TextNode;
  group: GroupNode;
}

export type NodeType = keyof NodeTypeMap;
export type SceneNode = NodeTypeMap[NodeType];

type UnionKeys<T> = T extends unknown ? keyof T : never;
type PatchableKeys = Exclude<UnionKeys<SceneNode>, 'id' | 'type'>;

/** 对任意节点的局部修改：键取所有节点类型的并集 */
export type NodePatch = {
  [K in PatchableKeys]?: Extract<SceneNode, Partial<Record<K, unknown>>>[K];
};

export interface DocumentData {
  /** 文件格式版本，用于以后做迁移 */
  version: number;
  rootId: NodeId;
  nodes: Record<NodeId, SceneNode>;
}

export const DOCUMENT_VERSION = 1;

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function rgba(r: number, g: number, b: number, a = 1): Color {
  return { r, g, b, a };
}

export function solid(color: Color): SolidFill {
  return { type: 'solid', color };
}

/** 生成 12 位随机 id */
export function createId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(36).padStart(2, '0').slice(-2);
  return out.slice(0, 12);
}

type CreateProps<T extends SceneNode> = Omit<
  T,
  'id' | 'type' | 'lineageId' | 'opacity' | 'blendMode' | 'visible' | 'locked' | 'transform' | 'size'
> &
  Partial<Pick<BaseNode, 'id' | 'lineageId' | 'opacity' | 'blendMode' | 'visible' | 'locked' | 'transform' | 'size'>>;

/** 用默认值补全公共字段，创建一个节点 */
export function createNode<K extends NodeType>(type: K, props: CreateProps<NodeTypeMap[K]>): NodeTypeMap[K] {
  return {
    id: createId(),
    lineageId: createId(),
    opacity: 1,
    blendMode: 'normal',
    visible: true,
    locked: false,
    transform: IDENTITY,
    size: [0, 0],
    ...props,
    type,
  } as unknown as NodeTypeMap[K];
}

export function hasShapeStyle(node: SceneNode): node is Extract<SceneNode, ShapeStyle> {
  return 'stroke' in node;
}
