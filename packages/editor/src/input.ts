import type { Editor } from './editor';
import type { PointerInfo } from './types';

/**
 * 输入控制器：把 DOM 事件翻译成工具调用、相机操作和快捷键命令。
 * 空格拖动、鼠标中键拖动、滚轮缩放这些与具体工具无关的操作在这里处理。
 */
export class InputController {
  private readonly abort = new AbortController();
  private pointerDown = false;
  private panning: { x: number; y: number } | null = null;
  private spaceHeld = false;
  private cursor = 'default';

  constructor(
    private readonly element: HTMLCanvasElement,
    private readonly editor: Editor,
  ) {
    const options = { signal: this.abort.signal };
    element.addEventListener('pointerdown', this.onPointerDown, options);
    element.addEventListener('pointermove', this.onPointerMove, options);
    element.addEventListener('pointerup', this.onPointerUp, options);
    element.addEventListener('pointercancel', this.onPointerUp, options);
    element.addEventListener('dblclick', this.onDoubleClick, options);
    element.addEventListener('mousedown', this.onMouseDown, options);
    element.addEventListener('wheel', this.onWheel, { ...options, passive: false });
    element.addEventListener('contextmenu', (e) => e.preventDefault(), options);
    window.addEventListener('keydown', this.onKeyDown, options);
    window.addEventListener('keyup', this.onKeyUp, options);
    window.addEventListener('blur', () => (this.spaceHeld = false), options);
  }

  dispose(): void {
    this.abort.abort();
  }

  setCursor(cursor: string): void {
    this.cursor = cursor;
    this.applyCursor();
  }

  private applyCursor(): void {
    this.element.style.cursor = this.panning ? 'grabbing' : this.spaceHeld ? 'grab' : this.cursor;
  }

  private info(event: PointerEvent | MouseEvent): PointerInfo {
    const rect = this.element.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return {
      x,
      y,
      world: this.editor.screenToWorld(x, y),
      shift: event.shiftKey,
      alt: event.altKey,
      mod: event.metaKey || event.ctrlKey,
      button: event.button,
      down: this.pointerDown,
    };
  }

  private onMouseDown = (event: MouseEvent): void => {
    // 文本编辑时键盘焦点在隐藏的输入框上。浏览器默认会在按下鼠标时把焦点移到画布，
    // 那样输入法就断开了，所以这里拦住默认行为
    if (this.editor.keyboardTarget) event.preventDefault();
  };

  private onDoubleClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.editor.tool.onDoubleClick?.(this.info(event), this.editor);
    this.editor.requestRender();
  };

  private onPointerDown = (event: PointerEvent): void => {
    (this.editor.keyboardTarget ?? this.element).focus({ preventScroll: true });
    this.element.setPointerCapture(event.pointerId);
    if (event.button === 1 || (event.button === 0 && this.spaceHeld)) {
      this.panning = { x: event.clientX, y: event.clientY };
      this.applyCursor();
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    this.pointerDown = true;
    this.editor.tool.onPointerDown?.(this.info(event), this.editor);
    this.editor.requestRender();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.panning) {
      this.editor.panBy(event.clientX - this.panning.x, event.clientY - this.panning.y);
      this.panning = { x: event.clientX, y: event.clientY };
      return;
    }
    this.editor.tool.onPointerMove?.(this.info(event), this.editor);
    if (this.pointerDown) this.editor.requestRender();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    if (this.panning) {
      this.panning = null;
      this.applyCursor();
      return;
    }
    if (!this.pointerDown) return;
    this.pointerDown = false;
    this.editor.tool.onPointerUp?.(this.info(event), this.editor);
    this.editor.requestRender();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.element.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      // 触控板双指捏合在浏览器里表现为 ctrl + 滚轮
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.01));
      this.editor.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
    } else {
      const unit = event.deltaMode === 1 ? 16 : 1;
      this.editor.panBy(-event.deltaX * unit, -event.deltaY * unit);
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isEditable(event.target) || event.isComposing) return;
    const target = this.editor.keyboardTarget;
    if (target) {
      // 正在编辑文字，但焦点跑到了别处（比如刚点过属性面板里的按钮）。
      // 这时按键应该继续进到文字里，而不是触发"按 V 切换工具"这类快捷键。
      // 先把焦点还给输入框；浏览器会把这次按键产生的字符送到新的焦点上。
      const isModifierOnly = ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key);
      if (!isModifierOnly) target.focus({ preventScroll: true });
      return;
    }
    if (event.key === ' ') {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.applyCursor();
      }
      event.preventDefault();
      return;
    }
    if (this.editor.tool.onKeyDown?.(event, this.editor)) {
      event.preventDefault();
      this.editor.requestRender();
      return;
    }
    const binding = this.editor.keymap.match(event);
    if (binding && this.editor.commands.run(binding.command, binding.args)) {
      event.preventDefault();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ') {
      this.spaceHeld = false;
      this.applyCursor();
    }
  };
}

/** 焦点在输入框里时，快捷键不应该生效 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
