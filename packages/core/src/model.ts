import type { CornerStyle } from './corners';
import type { ArrowHead } from './stroke';
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
import type { ParagraphOverride } from './paragraphs';
import type { StrokeCap, StrokeJoin } from './stroke';
import type { ColorStyleDef, TextStyleDef } from './styles';

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
  /** 链接的颜色样式的 id，见 styles.ts。color 始终是样式当前的颜色，改样式时跟着改。省略表示没有链接 */
  colorStyle?: string;
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
  /** 调色、模糊、锐化。省略表示不做任何调整 */
  adjust?: ImageAdjustments;
  /** 曲线，见 curves.ts。省略表示不调 */
  curves?: ImageCurves;
  /** 滤镜预设和它的强度，见 image-presets.ts。省略表示没有滤镜 */
  filter?: PresetFilter;
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
  /** 锐化强度，0 到 200（百分比）：100 表示把细节的反差加一倍。省略表示不锐化 */
  sharpen?: number;
  /** 锐化的半径，单位与文档坐标相同，0.1 到 10。省略表示 1 */
  sharpenRadius?: number;
}

/** 曲线上的一个控制点：输入、输出都在 0 到 1 */
export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * 曲线：总曲线作用于红绿蓝三个通道，另外每个通道可以有自己的曲线（先过通道自己的，再过总曲线）。
 * 每条曲线是按 x 从小到大的控制点，至少两个；省略的那条是不变的直线。见 curves.ts
 */
export interface ImageCurves {
  rgb?: readonly CurvePoint[];
  red?: readonly CurvePoint[];
  green?: readonly CurvePoint[];
  blue?: readonly CurvePoint[];
}

/** 滤镜预设：用哪一个、强度多少。预设的定义在 image-presets.ts，发布之后不再改，不认识的预设当作没有 */
export interface PresetFilter {
  preset: string;
  /** 强度，0 到 100 */
  amount: number;
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

export const GRADIENT_KINDS = ['linear', 'radial'] as const;
/** linear：线性渐变；radial：径向渐变 */
export type GradientKind = (typeof GRADIENT_KINDS)[number];

export interface GradientStop {
  /** 位置，0 到 1 */
  offset: number;
  color: Color;
}

/**
 * 渐变填充。起点终点按节点外框的相对位置记（0 到 1，可以超出），形状缩放时渐变跟着缩放；
 * 但渐变本身在节点的本地坐标里画：线性渐变的色带总是垂直于起点到终点的连线，径向渐变总是正圆。
 * 这和 PDF、SVG 的渐变一一对应，导入导出时不失真。见 gradient.ts
 */
export interface GradientFill {
  type: 'gradient';
  kind: GradientKind;
  /** 线性：起点；径向：圆心 */
  start: { x: number; y: number };
  /** 线性：终点；径向：圆周上的一点，到圆心的距离就是半径 */
  end: { x: number; y: number };
  /**
   * 径向渐变压扁成椭圆：垂直于圆心到 end 方向的半径，是 end 方向半径的多少倍。省略表示 1，正圆。
   * 设计软件里常把径向渐变拉成椭圆，导入 PDF 时用得上
   */
  aspect?: number;
  /** 色标，至少两个，按位置从小到大。颜色在相邻色标之间直线过渡，透明度和颜色分开过渡 */
  stops: readonly GradientStop[];
}

export type Fill = SolidFill | ImageFill | GradientFill;

/** 描边，居中画在轮廓上。端点、拐角、虚线见 stroke.ts，省略时是平头、尖角、实线 */
export interface Stroke {
  color: Color;
  width: number;
  /** 虚线：实线段和空白交替的长度，文档单位。省略或空数组是实线 */
  dash?: readonly number[];
  /** 虚线从路径起点往后错开多少 */
  dashOffset?: number;
  cap?: StrokeCap;
  join?: StrokeJoin;
  /** 描边颜色链接的颜色样式，和 SolidFill.colorStyle 一样 */
  colorStyle?: string;
  /** 开放路径起点、终点的箭头。省略表示没有。见 stroke.ts */
  arrowStart?: ArrowHead;
  arrowEnd?: ArrowHead;
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
  /**
   * 组件实例里的副本：对应主组件（或嵌套的那一层）里的哪个节点。内容由那个节点决定，同步时照它改。
   * 省略表示不是实例里的副本。见 components.ts
   */
  source?: NodeId;
  /** 实例里的副本上改过的属性名：同步时保留自己的值，不跟主组件走。省略表示没改过 */
  overrides?: readonly string[];
}

export interface ShapeStyle {
  fill: Fill | null;
  stroke: Stroke | null;
}

/**
 * 页面。文档的根节点是一个页面，文档级的数据也记在它上面：颜色样式和文字样式（见 styles.ts）。
 */
/**
 * 辅助线：竖线（axis 'x'，在 x = offset 处）或横线（axis 'y'）。画板上的辅助线坐标相对画板、只画在画板里、
 * 跟着画板移动，复制这一页时一起复制；页面上的辅助线画满整个画布。导出时不画
 */
export interface Guide {
  id: string;
  axis: 'x' | 'y';
  offset: number;
}

export interface PageNode extends BaseNode {
  type: 'page';
  /** 页面上的辅助线（不在任何画板里的）。省略表示没有 */
  guides?: readonly Guide[];
  /** 颜色样式，按显示顺序。省略表示没有 */
  colorStyles?: readonly ColorStyleDef[];
  /** 文字样式，按显示顺序。省略表示没有 */
  textStyles?: readonly TextStyleDef[];
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
  /** 隐藏幻灯片：演示、导出网页和视频时跳过，编辑时照常显示。省略表示不隐藏 */
  skip?: boolean;
}

export interface ArtboardNode extends BaseNode {
  type: 'artboard';
  /** 背景：纯色或渐变 */
  fill: SolidFill | GradientFill | null;
  /** 有这个字段就是一页幻灯片；order 是幻灯片顺序的分数索引 */
  deck: SlideDeck | null;
  /** 画板上的辅助线，坐标相对画板。省略表示没有 */
  guides?: readonly Guide[];
}

export interface RectNode extends BaseNode, ShapeStyle {
  type: 'rect';
  cornerRadius: number;
  /** 四个角分别的半径：左上、右上、右下、左下。省略表示四个角都是 cornerRadius。见 corners.ts */
  cornerRadii?: readonly [number, number, number, number];
  /** 圆角样式：圆角、反向圆角、倒角。省略是圆角 */
  cornerStyle?: CornerStyle;
  /** 平滑度 0 到 1（像 iOS 图标那样连续的圆角）。省略是 0 */
  cornerSmoothing?: number;
}

export interface EllipseNode extends BaseNode, ShapeStyle {
  type: 'ellipse';
}

/**
 * 画框：做界面用的容器，一屏里面套着卡片、卡片里套着按钮，每层都是一个画框。
 * 和编组不同，它有自己的大小、填充、描边、圆角，默认裁掉超出范围的内容；和画板不同，它不是幻灯片，
 * 可以放在画板里，也可以互相嵌套。圆角的几项和矩形一样（见 corners.ts）
 */
export interface FrameNode extends BaseNode, ShapeStyle {
  type: 'frame';
  cornerRadius: number;
  cornerRadii?: readonly [number, number, number, number];
  cornerStyle?: CornerStyle;
  cornerSmoothing?: number;
  /** 裁掉超出画框的内容 */
  clip: boolean;
}

/** 多边形（sides 条边）或星形（有 innerRatio 时，sides 个角）。画在外框里，见 polygon.ts */
export interface PolygonNode extends BaseNode, ShapeStyle {
  type: 'polygon';
  sides: number;
  /** 星形内顶点到中心的距离是外顶点的几倍（0 到 1）。省略表示多边形 */
  innerRatio?: number;
  /** 每个顶点一样的圆角，以及样式和平滑度，同矩形 */
  cornerRadius: number;
  cornerStyle?: CornerStyle;
  cornerSmoothing?: number;
}

/** 贝塞尔锚点。控制柄用本地绝对坐标；没有控制柄时与锚点重合 */
export interface Anchor {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  /** 这个尖角的圆角半径（两边都是直线时才起作用）。省略表示不圆。见 corners.ts */
  radius?: number;
}

export interface Subpath {
  closed: boolean;
  anchors: readonly Anchor[];
}

export interface PathNode extends BaseNode, ShapeStyle {
  type: 'path';
  subpaths: readonly Subpath[];
  fillRule: 'nonzero' | 'evenodd';
  /** 锚点圆角的样式和平滑度，同矩形。省略是圆角、不平滑 */
  cornerStyle?: CornerStyle;
  cornerSmoothing?: number;
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
  /** 斜体。省略表示正体 */
  italic?: boolean;
  /** 下划线。省略表示没有 */
  underline?: boolean;
  /** 删除线。省略表示没有 */
  strikethrough?: boolean;
}

/** 可以按字符单独设置的样式项。整段的默认值来自文本节点的 style 和 fill */
export interface CharacterStyle {
  fontFamily: { latin: string; cjk: string };
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  letterSpacing: number;
  /** 文字颜色；null 表示不画 */
  color: Color | null;
}

/**
 * 一段文字自己的样式。start、end 是字符串下标（UTF-16），左闭右开；
 * style 只记和整段默认样式不同的那几项。见 text-spans.ts
 */
export interface TextSpan {
  start: number;
  end: number;
  style: Partial<CharacterStyle>;
}

/**
 * 文本。style 和 fill 是整段的默认样式；其中一部分字可以有自己的样式，按区间记在 spans 里。
 * align 是默认的对齐方式，每一段还可以有自己的段落样式（paragraphs）。行高和宽度模式是整个文本共用的。
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
  /** 和默认样式不同的那些字，按位置排好、互不重叠。省略表示整段都是默认样式 */
  spans?: readonly TextSpan[];
  /**
   * 每一段（用换行分开）自己的段落样式：对齐、段前段后距、缩进、列表。按段落序号排，
   * 每项只记和默认值不同的那几项，没有不同的是 null。省略表示每段都用默认值。见 paragraphs.ts
   */
  paragraphs?: readonly (ParagraphOverride | null)[];
  /**
   * 保真外观：从别的文件（比如 PDF）导入的文字，在被改动之前按原文件的字形显示，看起来和原来一模一样。
   * 文字或排版参数一旦改动就不再使用它，改按上面的样式正常排版。见 text-appearance.ts。
   * 有保真外观时，size 就是原文件里这段文字占的范围（自动宽度也一样）。
   */
  appearance?: TextAppearance;
  /** 链接的文字样式的 id，见 styles.ts。style 始终是样式当前的值，改样式时跟着改。省略表示没有链接 */
  textStyle?: string;
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
  /** 这组字自己的颜色（原文件里一行字中间换了颜色）。省略表示用节点的填充色 */
  color?: Color;
}

export interface TextAppearance {
  runs: readonly GlyphRun[];
  /** 生成外观时文字和排版参数的指纹。和节点当前的对不上，说明改过了 */
  basis: string;
  /** 原文件里第一行基线的位置（本地坐标的 y）。换成正常排版时按它对齐，文字不会上下跳 */
  baseline: number;
}

export const MASK_MODES = ['shape', 'alpha', 'luminance'] as const;
/**
 * 蒙版怎么遮：
 * shape 按蒙版的轮廓裁剪（只看形状，不看颜色）；
 * alpha 按蒙版画出来的不透明程度遮（半透明、渐变、文字都可以当蒙版）；
 * luminance 按蒙版画出来的亮度遮，越亮越不透明
 */
export type MaskMode = (typeof MASK_MODES)[number];

/**
 * 编组：把几个对象当成一个整体来选择、移动、旋转和缩放。
 * 组自己没有外观；给组设置不透明度或混合模式时，子节点先合成再整体应用。
 * 设了 mask 就是蒙版组：组里最上面的对象当蒙版，按 mask 指定的方式遮住其余的对象，蒙版自己不画出来。
 */
export interface GroupNode extends BaseNode {
  type: 'group';
  /** 省略表示普通编组 */
  mask?: MaskMode;
  /**
   * 主组件：子节点就是组件的内容，所有实例照着它显示。见 components.ts。
   * 组件和实例都是编组，渲染、导出、选中、缩放这些按编组处理的地方不用另外认它们
   */
  component?: boolean;
  /** 组件实例：主组件的 id。子节点是主组件内容的副本（带 source），主组件改了跟着同步 */
  instanceOf?: NodeId;
}

/** 节点类型表。其他模块可以通过声明合并扩展它 */
export interface NodeTypeMap {
  page: PageNode;
  artboard: ArtboardNode;
  rect: RectNode;
  ellipse: EllipseNode;
  polygon: PolygonNode;
  path: PathNode;
  boolean: BooleanNode;
  text: TextNode;
  group: GroupNode;
  frame: FrameNode;
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
