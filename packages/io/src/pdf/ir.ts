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
}

export interface PdfStroke {
  color: Color;
  width: number;
}

interface PdfItemBase {
  blendMode: BlendMode;
  clip: PdfClip | null;
}

export interface PdfPathItem extends PdfItemBase {
  kind: 'path';
  data: PathData;
  fill: Color | null;
  fillRule: 'nonzero' | 'evenodd';
  stroke: PdfStroke | null;
}

/**
 * 一段文字。`data` 是每个字的轮廓合在一起的路径，用来原样显示；
 * 其余字段记录这段文字本来是什么，留给以后把它还原成可编辑文本。
 * 找不到字形轮廓时（PDF 没有内嵌字体）`data` 为空，这时只能用我们自己的字体重排。
 */
export interface PdfTextItem extends PdfItemBase {
  kind: 'text';
  text: string;
  data: PathData;
  fill: Color | null;
  stroke: PdfStroke | null;
  /** PDF 里的字体名，比如 "ABCDEF+Helvetica-Bold" */
  fontName: string;
  /** 解析库给字体起的内部标识，同一个字体对象相同 */
  fontId: string;
  bold: boolean;
  italic: boolean;
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
  /** 被裁剪、但裁剪没有还原的对象 */
  clips: number;
  /** 渐变填充，已改成它的平均色 */
  gradients: number;
  /** 图案填充，已去掉填充 */
  patterns: number;
  /** 透明蒙版，已忽略 */
  softMasks: number;
  /** 虚线描边，已改成实线 */
  dashes: number;
  /** 没有内嵌字体、改用默认字体重排的文字 */
  fallbackText: number;
  /** 解码失败、没能放进来的图片 */
  images: number;
}

export function emptyIssues(): PdfIssues {
  return { clips: 0, gradients: 0, patterns: 0, softMasks: 0, dashes: 0, fallbackText: 0, images: 0 };
}

export interface PdfPage {
  width: number;
  height: number;
  /** 从下到上 */
  items: PdfItem[];
  issues: PdfIssues;
}
