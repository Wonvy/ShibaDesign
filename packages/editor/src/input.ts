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
  /** 最后一次指针事件的位置，按下或松开修饰键时用它把新的修饰键状态告诉工具 */
  private lastPointer: { clientX: number; clientY: number; button: number } | null = null;
  private pointerId: number | null = null;
  /** 这次按下是在标尺或辅助线上：拖动交给 editor.guides，不交给工具 */
  private guideDrag = false;

  constructor(
    private readonly element: HTMLCanvasElement,
    private readonly editor: Editor,
  ) {
    const options = { signal: this.abort.signal };
    element.addEventListener('pointerdown', this.onPointerDown, options);
    element.addEventListener('pointermove', this.onPointerMove, options);
    element.addEventListener('pointerup', this.onPointerUp, options);
    element.addEventListener('pointercancel', this.onPointerUp, options);
    element.addEventListener('pointerleave', () => this.editor.setHover(null), options);
    element.addEventListener('dblclick', this.onDoubleClick, options);
    element.addEventListener('mousedown', this.onMouseDown, options);
    element.addEventListener('wheel', this.onWheel, { ...options, passive: false });
    element.addEventListener('contextmenu', this.onContextMenu, options);
    window.addEventListener('keydown', this.onKeyDown, options);
    window.addEventListener('keyup', this.onKeyUp, options);
    window.addEventListener(
      'blur',
      () => {
        this.spaceHeld = false;
        // 拖到一半切到别的程序：松手事件可能收不到，当成取消
        this.cancelDrag();
      },
      options,
    );
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
    this.lastPointer = { clientX: event.clientX, clientY: event.clientY, button: event.button };
    return this.infoAt(event.clientX, event.clientY, event, event.button);
  }

  private infoAt(
    clientX: number,
    clientY: number,
    keys: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean },
    button: number,
  ): PointerInfo {
    const rect = this.element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return {
      x,
      y,
      world: this.editor.screenToWorld(x, y),
      shift: keys.shiftKey,
      alt: keys.altKey,
      mod: keys.metaKey || keys.ctrlKey,
      button,
      down: this.pointerDown,
      space: this.spaceHeld,
    };
  }

  /**
   * 拖动中按下或松开了修饰键：鼠标没动也要让工具按新的状态重算一次，
   * 比如拖到一半按下 Shift 立刻锁定方向，按下 Alt 立刻变成复制
   */
  private refreshModifiers(event: KeyboardEvent): void {
    const last = this.lastPointer;
    if (!last) return;
    const info = this.infoAt(last.clientX, last.clientY, event, last.button);
    if (this.guideDrag) this.editor.guides.move(info);
    else this.editor.tool.onPointerMove?.(info, this.editor);
    this.editor.requestRender();
  }

  private isCanvasFocus(target: EventTarget | null): boolean {
    return target === this.element || target === document.body || target === document.documentElement || !target;
  }

  /** 取消正在进行的拖动：工具撤回这次拖动的改动，之后的松手不再交给工具 */
  private cancelDrag(): boolean {
    if (!this.pointerDown) return false;
    this.pointerDown = false;
    if (this.pointerId !== null && this.element.hasPointerCapture(this.pointerId)) {
      this.element.releasePointerCapture(this.pointerId);
    }
    this.pointerId = null;
    if (this.guideDrag) {
      this.guideDrag = false;
      this.editor.guides.cancel();
      return true;
    }
    this.editor.tool.onCancel?.(this.editor);
    this.editor.requestRender();
    return true;
  }

  private onMouseDown = (event: MouseEvent): void => {
    // 文本编辑时键盘焦点在隐藏的输入框上。浏览器默认会在按下鼠标时把焦点移到画布，
    // 那样输入法就断开了，所以这里拦住默认行为
    if (this.editor.keyboardTarget) event.preventDefault();
  };

  /** 右键（Mac 上也是 Ctrl+单击、触控板双指轻点）：浏览器自己的菜单不要，换成界面层的菜单 */
  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const handler = this.editor.contextMenuHandler;
    if (this.pointerDown || this.panning || !handler) return;
    const rect = this.element.getBoundingClientRect();
    const info = this.editor.contextAt(event.clientX - rect.left, event.clientY - rect.top);
    this.editor.requestRender();
    handler({ ...info, clientX: event.clientX, clientY: event.clientY });
  };

  private onDoubleClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const rect = this.element.getBoundingClientRect();
    const guide = this.editor.guides.hit(event.clientX - rect.left, event.clientY - rect.top);
    if (guide?.kind === 'guide') {
      // 双击辅助线：输入精确的位置
      this.editor.guideEditHandler?.({ container: guide.container, id: guide.id });
      return;
    }
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
    // Mac 上 Ctrl+单击是右键：接着会来 contextmenu 事件，这里不交给工具
    if (event.ctrlKey && !event.metaKey && IS_MAC) return;
    this.pointerDown = true;
    this.pointerId = event.pointerId;
    const info = this.info(event);
    // 标尺上随时能拖出辅助线；已有的辅助线用选择工具拖（选区的控制柄优先）
    const guide = this.editor.guides.hit(info.x, info.y);
    const usable =
      guide?.kind === 'ruler' ||
      (guide?.kind === 'guide' &&
        this.editor.tool.id === 'select' &&
        !this.editor.overlayLayer?.hitHandle(info.x, info.y));
    if (guide && usable) {
      this.guideDrag = true;
      this.editor.guides.begin(guide, info);
      return;
    }
    this.editor.guides.clearSelection();
    this.editor.tool.onPointerDown?.(info, this.editor);
    this.editor.requestRender();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.panning) {
      this.editor.panBy(event.clientX - this.panning.x, event.clientY - this.panning.y);
      this.panning = { x: event.clientX, y: event.clientY };
      return;
    }
    const info = this.info(event);
    if (this.guideDrag) {
      this.editor.guides.move(info);
      return;
    }
    if (!this.pointerDown) {
      // 停在标尺或辅助线上：指针变成双箭头，不再交给工具（也就不画悬停高亮）
      const cursor = this.editor.guides.cursorAt(info.x, info.y);
      if (cursor && (this.editor.tool.id === 'select' || this.editor.guides.hit(info.x, info.y)?.kind === 'ruler')) {
        this.element.style.cursor = cursor;
        this.editor.setHover(null);
        return;
      }
      this.applyCursor();
    }
    this.editor.tool.onPointerMove?.(info, this.editor);
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
    this.pointerId = null;
    if (this.guideDrag) {
      this.guideDrag = false;
      this.editor.guides.end(this.info(event));
      return;
    }
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
      if (!isModifier(event.key)) target.focus({ preventScroll: true });
      return;
    }
    if (this.pointerDown) {
      if (event.key === 'Escape') {
        this.cancelDrag();
        event.preventDefault();
        return;
      }
      if (isModifier(event.key)) {
        this.refreshModifiers(event);
        return;
      }
    } else if (isModifier(event.key)) {
      // 没在拖动时按下 Alt：悬停的工具要知道（按住 Alt 测距）
      this.refreshModifiers(event);
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.editor.guides.removeSelected()) {
      event.preventDefault();
      return;
    }
    if (event.key === ' ') {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        // 拖动中按下空格：让工具挪动正在画的东西；没在拖动时是抓手
        if (this.pointerDown) this.refreshModifiers(event);
        else this.applyCursor();
      }
      event.preventDefault();
      return;
    }
    // 回车、Tab 只在焦点在画布上（或者没有焦点）时当快捷键：焦点在面板的按钮上时，回车是按下按钮、Tab 是移动焦点
    const plain = !event.metaKey && !event.ctrlKey;
    if ((event.key === 'Enter' || event.key === 'Tab') && plain && !this.isCanvasFocus(event.target)) return;
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
    if (isModifier(event.key)) this.refreshModifiers(event);
    if (event.key === ' ') {
      this.spaceHeld = false;
      if (this.pointerDown) this.refreshModifiers(event);
      this.applyCursor();
    }
  };
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function isModifier(key: string): boolean {
  return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
}

/** 焦点在输入框里时，快捷键不应该生效 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
