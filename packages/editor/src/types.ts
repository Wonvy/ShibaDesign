import type { CharacterStyle, Color, NodeId, Point } from '@shiba/core';
import type { FillEditing } from './fill-handles';

/** canvas：自由画布，所有画板可见；slides：一次只看一个画板 */
export type ViewMode = 'canvas' | 'slides';

/** 界面层订阅的编辑器状态。每次变化都会换成一个新对象 */
export interface EditorState {
  tool: string;
  selection: readonly NodeId[];
  viewMode: ViewMode;
  activeArtboardId: NodeId | null;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  /** 文档每变一次加一，界面可以用它判断是否需要重新读取文档 */
  docVersion: number;
  /** 字体或图片每到位一批加一。画面会随之变化，缩略图等需要跟着重画 */
  resourceEpoch: number;
  /** 正在编辑的文字和其中选中的范围；不在编辑文字时为 null */
  textEditing: TextEditing | null;
  /** 正在画布上调整填充（渐变的起点终点、图片在形状里的位置）的节点；没有时为 null。见 fill-handles.ts */
  fillEditing: FillEditing | null;
  /** 视图选项：标尺、辅助线、吸附等。界面层记在浏览器里 */
  view: ViewOptions;
  /** 锁住的工具：画完不回到选择工具。换工具时解开 */
  lockedTool: string | null;
}

/** 视图选项。都是只和这台电脑、这个人有关的偏好，不进文档 */
export interface ViewOptions {
  /** 画布上边和左边的标尺 */
  rulers: boolean;
  /** 显示辅助线 */
  guides: boolean;
  /** 锁定辅助线：点不中、拖不动，不会碰歪 */
  guidesLocked: boolean;
  /** 放大到 800% 以上时画出像素格 */
  pixelGrid: boolean;
  /** 显示画框和画板上的版面网格（显示时也吸附到列和行的边） */
  layoutGrids: boolean;
  /** 选区框下面的"宽 × 高"标签 */
  sizeLabel: boolean;
  /** 吸附到对象和画板 */
  snapObjects: boolean;
  /** 吸附到辅助线 */
  snapGuides: boolean;
  /** 位置和大小取整到像素 */
  snapPixels: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  rulers: false,
  guides: true,
  guidesLocked: false,
  pixelGrid: true,
  layoutGrids: true,
  sizeLabel: true,
  snapObjects: true,
  snapGuides: true,
  snapPixels: false,
};

/** 正在编辑的文字。属性面板按它显示和修改选中那几个字的样式 */
export interface TextEditing {
  nodeId: NodeId;
  /** 选中的范围；没选中时两者相等，就是光标位置 */
  start: number;
  end: number;
  /** 光标处刚换了样式、还没打字时，接下来打的字用的样式 */
  typing: CharacterStyle | null;
}

/** 画布区域用到的颜色，由界面主题提供 */
export interface CanvasTheme {
  /** 画板之外的底色 */
  background: Color;
  /** 选区、控制柄、钢笔预览的颜色（CSS 颜色） */
  accent: string;
  /** 画板名称的颜色 */
  label: string;
  /** 控制柄的填充色 */
  handleFill: string;
  /** 智能参考线、测距的颜色。省略时用洋红色 */
  snap?: string;
  /** 辅助线的颜色。省略时用青色 */
  guide?: string;
  /** 标尺的底色、刻度线的颜色。省略时用画布的底色和画板名的颜色 */
  rulerFill?: string;
  rulerLine?: string;
}

export interface PointerInfo {
  /** 相对画布左上角的 CSS 像素坐标 */
  x: number;
  y: number;
  world: Point;
  shift: boolean;
  alt: boolean;
  /** macOS 上是 ⌘，其他系统是 Ctrl */
  mod: boolean;
  button: number;
  /** 当前是否有按键按住（拖动中） */
  down: boolean;
  /** 按着空格：拖动中按住空格时，挪动的是正在画的东西（形状、选框），而不是继续改大小 */
  space?: boolean;
}

/** 右键点到了什么。界面层按它决定弹哪个菜单 */
export type ContextTarget =
  /** 正在编辑的文字 */
  | { kind: 'text'; id: NodeId }
  /** 对象：右键之后的选区 */
  | { kind: 'object'; ids: readonly NodeId[] }
  /** 画板的空白处或画板名 */
  | { kind: 'artboard'; id: NodeId }
  /** 画板外的空白处 */
  | { kind: 'canvas' }
  /** 辅助线 */
  | { kind: 'guide'; container: NodeId; id: string }
  /** 标尺 */
  | { kind: 'ruler' };

export interface ContextInfo {
  target: ContextTarget;
  /** 右键位置的世界坐标（"粘贴到这里"用） */
  world: Point;
  /** 鼠标下所有的对象，从上到下（"选择图层"子菜单用） */
  stack: readonly NodeId[];
}
