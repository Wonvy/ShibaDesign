import type { Editor } from '../editor';
import type { PointerInfo } from '../types';

/**
 * 工具接口。每个工具是一个独立对象，内部自己维护拖动状态。
 * 新增工具：实现这个接口，调用 editor.tools.register(tool)。
 */
export interface Tool {
  id: string;
  /** 默认鼠标指针（CSS cursor） */
  cursor: string;
  onActivate?(editor: Editor): void;
  onDeactivate?(editor: Editor): void;
  onPointerDown?(event: PointerInfo, editor: Editor): void;
  /** 拖动和悬停都会调用；用 event.down 区分 */
  onPointerMove?(event: PointerInfo, editor: Editor): void;
  onPointerUp?(event: PointerInfo, editor: Editor): void;
  onDoubleClick?(event: PointerInfo, editor: Editor): void;
  /** 返回 true 表示已处理，编辑器不再查快捷键表 */
  onKeyDown?(event: KeyboardEvent, editor: Editor): boolean;
  /** 在覆盖层上画工具自己的辅助图形；ctx 的单位是 CSS 像素 */
  drawOverlay?(ctx: CanvasRenderingContext2D, editor: Editor): void;
}
