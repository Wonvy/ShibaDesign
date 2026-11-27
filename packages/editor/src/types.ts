import type { Color, NodeId, Point } from '@shiba/core';

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
}
