import type { BlendMode, Color, Matrix } from '@shiba/core';

/**
 * PDF 导入的中间表示。
 *
 * 导入分两步：先把 PDF 的绘图指令解释成这里定义的"页面上有哪些东西"，
 * 再把这些东西变成文档节点。两步之间只靠这份数据打交道，
 * 所以换解析库只需要重写第一步，改进还原效果（比如把文字变成可编辑文本）只需要改第二步。
 *
 * 所有坐标都已经换算成页面坐标：原点在页面左上角，y 向下，1 个单位等于 PDF 的 1 点（1/72 英寸）。
 */

/**
 * 路径数据：一个扁平的数字数组，每条命令是一个命令码加它的坐标。
 * 0 移动到 (x, y)；1 直线到 (x, y)；2 三次曲线 (c1x, c1y, c2x, c2y, x, y)；
 * 3 二次曲线 (cx, cy, x, y)；4 闭合。
 */
export type PathData = number[];

export const MOVE = 0;
export const LINE = 1;
export const CUBIC = 2;
export const QUAD = 3;
export const CLOSE = 4;

/** 轴对齐的包围盒 */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 画一个对象时生效的裁剪范围。
 * 目前只记录包围盒，以及它是不是恰好就是这个矩形——
 * 是矩形时可以精确处理（裁掉矩形和图片的多余部分），不是时只能判断"完全在外面"。
 */
export interface PdfClip extends Box {
  /** 裁剪区域正好是这个包围盒 */
  exact: boolean;
  /**
   * 裁剪区域正好是这一条路径（并且不是矩形）。
   * "先用一个形状裁剪，再画一张盖住它的图片或色块"是 PDF 里表达圆角图片、圆形头像、渐变色块的常见写法，
   * 有了这条路径就能把它还原成"一个填了图片的形状"。
   */
  shape?: { data: PathData; fillRule: 'nonzero' | 'evenodd' };
  /**
   * 裁剪是几个形状叠出来的（先后设了好几次裁剪，取它们的交集）时，每一个形状。
   * 这时裁剪区域是包围盒和这些形状的交集；生成节点时一个形状套一层蒙版组，精确还原
   */
  shapes?: { data: PathData; fillRule: 'nonzero' | 'evenodd' }[];
}

export interface PdfStroke {
  color: Color;
  width: number;
  /** 虚线（页面坐标里的长度）；省略是实线 */
  dash?: number[];
  dashOffset?: number;
  cap?: 'round' | 'square';
  join?: 'round' | 'bevel';
}

/**
 * 软蒙版（PDF 的透明蒙版）：items 是蒙版里画的东西，按亮度（luminosity）或透明度（alpha）遮住它所作用的对象。
 * 同一个蒙版作用于好几个对象时，这些对象共用同一个对象，生成节点时据此把它们放进同一个蒙版组
 */
export interface PdfSoftMask {
  subtype: 'luminosity' | 'alpha';
  items: PdfItem[];
}

interface PdfItemBase {
  blendMode: BlendMode;
  clip: PdfClip | null;
  /** 画这个对象时生效的软蒙版 */
  softMask?: PdfSoftMask;
}

/**
 * 线性或径向渐变（PDF 的 axial / radial shading）。几何留在渐变自己的坐标里，matrix 把它换到页面坐标，
 * 生成节点时再换算到节点的本地坐标
 */
export interface PdfGradient {
  kind: 'linear' | 'radial';
  /** 色标，按位置排好；透明度已经乘上了当时的填充透明度 */
  stops: { offset: number; color: Color }[];
  /** 线性：起点、终点；径向：起始圆和结束圆的圆心 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 径向：起始圆和结束圆的半径 */
  r0: number;
  r1: number;
  /** 渐变坐标 → 页面坐标 */
  matrix: Matrix;
}

export interface PdfPathItem extends PdfItemBase {
  kind: 'path';
  data: PathData;
  /** 填充色；用渐变填充时是渐变的平均色，供不支持渐变的地方使用 */
  fill: Color | null;
  /** 用渐变填充时的渐变 */
  gradient?: PdfGradient;
  fillRule: 'nonzero' | 'evenodd';
  stroke: PdfStroke | null;
}

/** 一个字：字形的轮廓，以及把它放到页面上的变换 */
export interface PdfGlyph {
  /**
   * 字形轮廓，以字号为 1 个单位，y 向上，编码和 PathData 相同。
   * 同一个字体里同一个字形的所有出现共用同一个数组，生成字形库时靠它去重。
   */
  outline: ArrayLike<number>;
  /** 字形所在的字体。同一个字体的字形放进同一个字形库 */
  font: string;
  /** 字形坐标 → 页面坐标 */
  matrix: Matrix;
  /** 这个字形代表的文字；单独画的重音符号这类附属字形是空串 */
  text: string;
  /** 步进宽度，单位和轮廓相同 */
  advance: number;
  /** 这个字的填充色。一行字中间可能换颜色，所以每个字各记一份；还没确定时省略 */
  fill?: Color | null;
}

/** 一段文字主要用的字体：混排时取字数最多的那种 */
export interface PdfTextFont {
  /** PDF 里的字体名，比如 "ABCDEF+Helvetica-Bold" */
  name: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  monospace: boolean;
}

/** 一行字里用同一种字体、字号、颜色的一段 */
export interface PdfTextStyleRun {
  /** 这一段占 text 里多少个字符（UTF-16） */
  length: number;
  font: PdfTextFont;
  size: number;
  fill: Color | null;
}

/**
 * 一行文字（同一条基线上紧挨着的几段会合成一个）。
 * 既记下每个字的字形和位置，用来原样显示；也记下文字内容、字号、基线，用来还原成可以编辑的文本。
 */
export interface PdfTextItem extends PdfItemBase {
  kind: 'text';
  text: string;
  /** 每个字的字形。PDF 没有内嵌字体时拿不到字形，这里为空，只能用我们自己的字体重排 */
  glyphs: PdfGlyph[];
  /** 主要的填充色：一行字换了颜色时，取字数最多的那种 */
  fill: Color | null;
  stroke: PdfStroke | null;
  /** 主要的字体：混排时取字数最多的那种 */
  font: PdfTextFont;
  /** 按字体、字号、颜色分的几段，长度加起来等于 text 的长度。合并出来的一行里各段的样式可能不同 */
  styles: PdfTextStyleRun[];
  /** 字号，页面单位 */
  size: number;
  /** 基线起点 */
  x: number;
  y: number;
  /** 基线方向，单位向量 */
  dirX: number;
  dirY: number;
  /** 沿基线方向的总长度 */
  length: number;
  vertical: boolean;
}

/** 解码后的像素。同一张图片在一页里出现多次时共用同一个对象 */
export interface PdfImageSource {
  width: number;
  height: number;
  /**
   * rgba / rgb：每像素 4 / 3 字节；
   * bw：每像素 1 位，每行补齐到整字节，1 是白、0 是黑；
   * mask：每像素 1 位，0 的地方用当前填充色上色，1 的地方透明
   */
  format: 'rgba' | 'rgb' | 'bw' | 'mask';
  data: Uint8Array | Uint8ClampedArray;
}

export interface PdfImageItem extends PdfItemBase {
  kind: 'image';
  source: PdfImageSource;
  /** 蒙版图片的上色颜色；普通图片为 null */
  tint: Color | null;
  opacity: number;
  /** 把单位正方形（左上角为原点，y 向下）映射到页面上的变换 */
  matrix: Matrix;
}

/** 需要先合成、再整体应用透明度或混合模式的一组对象（PDF 的透明组），或者一段没法合并成一个对象的文字 */
export interface PdfGroupItem extends PdfItemBase {
  kind: 'group';
  name?: string;
  opacity: number;
  items: PdfItem[];
}

export type PdfItem = PdfPathItem | PdfTextItem | PdfImageItem | PdfGroupItem;

/**
 * 没法完全还原的地方，按种类计数。界面据此告诉用户哪里和原文件可能不一样。
 * 这里只有数字，怎么说给用户听由界面层决定。
 */
export interface PdfIssues {
  /** 被裁剪、但裁剪没法精确还原的对象（裁剪范围是几个形状叠出来的，只能按外框近似） */
  clips: number;
  /** 没法还原的渐变（网格渐变、函数渐变，以及描边和文字上的渐变），已改成它的平均色 */
  gradients: number;
  /** 图案填充，已去掉填充 */
  patterns: number;
  /** 没法还原的透明蒙版，已忽略 */
  softMasks: number;
  /** 没有内嵌字体、改用默认字体重排的文字 */
  fallbackText: number;
  /** 解码失败、没能放进来的图片 */
  images: number;
}

export function emptyIssues(): PdfIssues {
  return { clips: 0, gradients: 0, patterns: 0, softMasks: 0, fallbackText: 0, images: 0 };
}

export interface PdfPage {
  width: number;
  height: number;
  /** 从下到上 */
  items: PdfItem[];
  issues: PdfIssues;
}
