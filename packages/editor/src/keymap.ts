export interface KeyBinding {
  /** 形如 'mod+shift+z'、'delete'、'v'。修饰键顺序固定为 mod、alt、shift */
  key: string;
  command: string;
  args?: unknown;
}

/** 把键盘事件规范化成 KeyBinding.key 的写法 */
export function keyOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase());
  return parts.join('+');
}

/** 快捷键表。后加入的绑定优先，所以用户自定义可以覆盖默认值 */
export class Keymap {
  private bindings: KeyBinding[] = [];

  add(...bindings: KeyBinding[]): this {
    this.bindings.push(...bindings);
    return this;
  }

  match(event: KeyboardEvent): KeyBinding | undefined {
    const key = keyOf(event);
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      if (this.bindings[i]!.key === key) return this.bindings[i];
    }
    return undefined;
  }

  /** 某个命令当前绑定的快捷键，用于在界面上显示 */
  keyFor(command: string, args?: unknown): string | undefined {
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      const b = this.bindings[i]!;
      if (b.command === command && JSON.stringify(b.args) === JSON.stringify(args)) return b.key;
    }
    return undefined;
  }
}

export const DEFAULT_BINDINGS: KeyBinding[] = [
  { key: 'v', command: 'tool.set', args: 'select' },
  { key: 'h', command: 'tool.set', args: 'hand' },
  { key: 'r', command: 'tool.set', args: 'rect' },
  { key: 'o', command: 'tool.set', args: 'ellipse' },
  { key: 'p', command: 'tool.set', args: 'pen' },
  { key: 't', command: 'tool.set', args: 'text' },
  { key: 'mod+z', command: 'edit.undo' },
  { key: 'mod+shift+z', command: 'edit.redo' },
  { key: 'mod+y', command: 'edit.redo' },
  { key: 'delete', command: 'edit.delete' },
  { key: 'backspace', command: 'edit.delete' },
  { key: 'mod+d', command: 'edit.duplicate' },
  { key: 'mod+a', command: 'edit.selectAll' },
  { key: 'escape', command: 'edit.deselect' },
  { key: 'arrowleft', command: 'edit.nudge', args: { dx: -1, dy: 0 } },
  { key: 'arrowright', command: 'edit.nudge', args: { dx: 1, dy: 0 } },
  { key: 'arrowup', command: 'edit.nudge', args: { dx: 0, dy: -1 } },
  { key: 'arrowdown', command: 'edit.nudge', args: { dx: 0, dy: 1 } },
  { key: 'shift+arrowleft', command: 'edit.nudge', args: { dx: -10, dy: 0 } },
  { key: 'shift+arrowright', command: 'edit.nudge', args: { dx: 10, dy: 0 } },
  { key: 'shift+arrowup', command: 'edit.nudge', args: { dx: 0, dy: -10 } },
  { key: 'shift+arrowdown', command: 'edit.nudge', args: { dx: 0, dy: 10 } },
  { key: 'mod+]', command: 'arrange.order', args: 'forward' },
  { key: 'mod+[', command: 'arrange.order', args: 'backward' },
  { key: ']', command: 'arrange.order', args: 'front' },
  { key: '[', command: 'arrange.order', args: 'back' },
  { key: '=', command: 'view.zoomIn' },
  { key: 'shift++', command: 'view.zoomIn' },
  { key: '-', command: 'view.zoomOut' },
  { key: 'shift+!', command: 'view.zoomToFit' },
  { key: 'shift+)', command: 'view.zoom100' },
];
