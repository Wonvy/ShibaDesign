export interface KeyBinding {
  /**
   * 形如 'mod+shift+z'、'delete'、'v'、'shift+1'。修饰键顺序固定为 mod、alt、shift。
   * 字母、数字、标点写美式键盘键帽上不按 Shift 时的字（按物理键匹配，见 keyOf），其余的键写 event.key 的小写
   */
  key: string;
  command: string;
  args?: unknown;
}

/**
 * 把键盘事件规范化成 KeyBinding.key 的写法。
 * 字母和数字按物理键（event.code）认：Mac 上按住 Option 时 event.key 是别的字符（⌥K 是 "˚"），
 * Shift 加数字在不同键盘布局下也不一样（美式键盘 Shift+1 是 "!"），按 event.key 配不上。
 * 代价是法语 AZERTY 这类布局按的是键的位置，不是键帽上的字（Figma 也是这样取舍的）。
 * 标点、方向键、功能键仍按 event.key。
 */
export function keyOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(baseKey(event));
  return parts.join('+');
}

/** 标点键也按物理键认：Mac 上按住 Option 时 "[" 是 "“"，按住 Shift 时 "." 是 ">" */
const PUNCTUATION: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

function baseKey(event: KeyboardEvent): string {
  const code = event.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const punctuation = PUNCTUATION[code];
  if (punctuation) return punctuation;
  return (event.key ?? '').toLowerCase();
}

/** 快捷键表。后加入的绑定优先，所以用户自定义可以覆盖默认值 */
/** 用户改过的快捷键：这个命令（带参数）换成 key；key 是 null 表示不要快捷键 */
export interface KeyOverride {
  command: string;
  args?: unknown;
  key: string | null;
}

/** 命令连同参数的标识，判断两条绑定是不是同一个操作 */
export function bindingId(command: string, args?: unknown): string {
  return `${command}|${JSON.stringify(args)}`;
}

export class Keymap {
  private bindings: KeyBinding[] = [];
  private overrides: KeyOverride[] = [];
  private cache: KeyBinding[] | null = null;

  add(...bindings: KeyBinding[]): this {
    this.bindings.push(...bindings);
    this.cache = null;
    return this;
  }

  /**
   * 用户自定义的快捷键（快捷键表里改的）：改过的命令不再用默认的键，换成用户给的（或者没有），
   * 用户的绑定排在最后，同一个键上用户的优先
   */
  setOverrides(overrides: readonly KeyOverride[]): void {
    this.overrides = [...overrides];
    this.cache = null;
  }

  getOverrides(): readonly KeyOverride[] {
    return this.overrides;
  }

  /** 默认绑定（不含用户改的），恢复默认时对照用 */
  defaults(): readonly KeyBinding[] {
    return this.bindings;
  }

  private effective(): KeyBinding[] {
    if (this.cache) return this.cache;
    const changed = new Set(this.overrides.map((o) => bindingId(o.command, o.args)));
    const base = this.bindings.filter((b) => !changed.has(bindingId(b.command, b.args)));
    const added = this.overrides.flatMap((o) =>
      o.key ? [{ key: o.key, command: o.command, ...(o.args !== undefined ? { args: o.args } : {}) }] : [],
    );
    this.cache = [...base, ...added];
    return this.cache;
  }

  match(event: KeyboardEvent): KeyBinding | undefined {
    const key = keyOf(event);
    const bindings = this.effective();
    for (let i = bindings.length - 1; i >= 0; i--) {
      if (bindings[i]!.key === key) return bindings[i];
    }
    return undefined;
  }

  /** 当前生效的全部绑定（同一个键后加的覆盖先加的），快捷键表用 */
  list(): KeyBinding[] {
    const byKey = new Map<string, KeyBinding>();
    for (const binding of this.effective()) byKey.set(binding.key, binding);
    return [...byKey.values()];
  }

  /** 某个命令当前绑定的快捷键，用于在界面上显示 */
  keyFor(command: string, args?: unknown): string | undefined {
    const bindings = this.effective();
    for (let i = bindings.length - 1; i >= 0; i--) {
      const b = bindings[i]!;
      if (b.command === command && JSON.stringify(b.args) === JSON.stringify(args)) return b.key;
    }
    return undefined;
  }

  /** 这个键现在给了哪个操作（用户改快捷键时检查冲突） */
  bindingFor(key: string): KeyBinding | undefined {
    const bindings = this.effective();
    for (let i = bindings.length - 1; i >= 0; i--) if (bindings[i]!.key === key) return bindings[i];
    return undefined;
  }
}

export const DEFAULT_BINDINGS: KeyBinding[] = [
  { key: 'v', command: 'tool.set', args: 'select' },
  { key: 'a', command: 'tool.set', args: 'direct' },
  { key: 'k', command: 'tool.set', args: 'scale' },
  { key: 'f', command: 'tool.set', args: 'frame' },
  { key: 'l', command: 'tool.set', args: 'line' },
  { key: 'shift+l', command: 'tool.set', args: 'arrow' },
  { key: 'shift+p', command: 'tool.set', args: 'pencil' },
  { key: 'i', command: 'tool.set', args: 'eyedropper' },
  { key: 'z', command: 'tool.set', args: 'zoom' },
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
  { key: 'mod+alt+c', command: 'edit.copyProperties' },
  { key: 'mod+alt+v', command: 'edit.pasteProperties' },
  { key: 'mod+g', command: 'group.create' },
  { key: 'mod+shift+g', command: 'group.release' },
  { key: 'mod+alt+g', command: 'frame.wrap' },
  { key: 'shift+a', command: 'frame.autoLayout' },
  { key: 'alt+shift+a', command: 'frame.removeAutoLayout' },
  { key: 'shift+h', command: 'arrange.flip', args: 'horizontal' },
  { key: 'shift+v', command: 'arrange.flip', args: 'vertical' },
  { key: 'mod+a', command: 'edit.selectAll' },
  { key: 'mod+b', command: 'text.toggle', args: 'bold' },
  { key: 'mod+i', command: 'text.toggle', args: 'italic' },
  { key: 'mod+u', command: 'text.toggle', args: 'underline' },
  { key: 'mod+shift+x', command: 'text.toggle', args: 'strikethrough' },
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
  { key: 'shift+=', command: 'view.zoomIn' },
  { key: 'mod+=', command: 'view.zoomIn' },
  { key: '-', command: 'view.zoomOut' },
  { key: 'mod+-', command: 'view.zoomOut' },
  { key: 'shift+1', command: 'view.zoomToFit' },
  { key: 'shift+0', command: 'view.zoom100' },
  { key: 'shift+2', command: 'view.zoomToSelection' },
  { key: 'shift+r', command: 'view.toggle', args: 'rulers' },
  { key: 'mod+;', command: 'view.toggle', args: 'guides' },
  { key: 'mod+alt+;', command: 'view.toggle', args: 'guidesLocked' },
  { key: "mod+'", command: 'view.toggle', args: 'pixelGrid' },
  { key: 'shift+g', command: 'view.toggle', args: 'layoutGrids' },

  // 选择
  { key: 'enter', command: 'select.children' },
  { key: 'shift+enter', command: 'select.parent' },
  { key: 'tab', command: 'select.next' },
  { key: 'shift+tab', command: 'select.previous' },

  // 键盘改大小、复制一份并挪动
  { key: 'mod+arrowleft', command: 'edit.resize', args: { dw: -1, dh: 0 } },
  { key: 'mod+arrowright', command: 'edit.resize', args: { dw: 1, dh: 0 } },
  { key: 'mod+arrowup', command: 'edit.resize', args: { dw: 0, dh: -1 } },
  { key: 'mod+arrowdown', command: 'edit.resize', args: { dw: 0, dh: 1 } },
  { key: 'mod+shift+arrowleft', command: 'edit.resize', args: { dw: -10, dh: 0 } },
  { key: 'mod+shift+arrowright', command: 'edit.resize', args: { dw: 10, dh: 0 } },
  { key: 'mod+shift+arrowup', command: 'edit.resize', args: { dw: 0, dh: -10 } },
  { key: 'mod+shift+arrowdown', command: 'edit.resize', args: { dw: 0, dh: 10 } },
  { key: 'alt+arrowleft', command: 'edit.duplicateNudge', args: { dx: -1, dy: 0 } },
  { key: 'alt+arrowright', command: 'edit.duplicateNudge', args: { dx: 1, dy: 0 } },
  { key: 'alt+arrowup', command: 'edit.duplicateNudge', args: { dx: 0, dy: -1 } },
  { key: 'alt+arrowdown', command: 'edit.duplicateNudge', args: { dx: 0, dy: 1 } },
  { key: 'alt+shift+arrowleft', command: 'edit.duplicateNudge', args: { dx: -10, dy: 0 } },
  { key: 'alt+shift+arrowright', command: 'edit.duplicateNudge', args: { dx: 10, dy: 0 } },
  { key: 'alt+shift+arrowup', command: 'edit.duplicateNudge', args: { dx: 0, dy: -10 } },
  { key: 'alt+shift+arrowdown', command: 'edit.duplicateNudge', args: { dx: 0, dy: 10 } },

  // 对齐、分布（和 Figma 一样）
  { key: 'alt+a', command: 'arrange.align', args: 'left' },
  { key: 'alt+h', command: 'arrange.align', args: 'hcenter' },
  { key: 'alt+d', command: 'arrange.align', args: 'right' },
  { key: 'alt+w', command: 'arrange.align', args: 'top' },
  { key: 'alt+v', command: 'arrange.align', args: 'vcenter' },
  { key: 'alt+s', command: 'arrange.align', args: 'bottom' },
  { key: 'alt+shift+h', command: 'arrange.distribute', args: 'hspacing' },
  { key: 'alt+shift+v', command: 'arrange.distribute', args: 'vspacing' },

  // 结构
  { key: 'mod+alt+m', command: 'mask.toggle' },
  { key: 'alt+shift+u', command: 'boolean.create', args: 'union' },
  { key: 'alt+shift+s', command: 'boolean.create', args: 'subtract' },
  { key: 'alt+shift+i', command: 'boolean.create', args: 'intersect' },
  { key: 'alt+shift+e', command: 'boolean.create', args: 'exclude' },
  { key: 'mod+e', command: 'path.flatten' },
  { key: 'mod+alt+o', command: 'path.outlineStroke' },
  { key: 'mod+shift+o', command: 'text.outline' },
  { key: 'mod+alt+k', command: 'component.create' },
  { key: 'mod+alt+b', command: 'component.detach' },
  { key: 'mod+shift+l', command: 'node.toggleLock' },
  { key: 'mod+shift+h', command: 'node.toggleVisible' },

  // 文字
  { key: 'mod+shift+.', command: 'text.fontStep', args: 1 },
  { key: 'mod+shift+,', command: 'text.fontStep', args: -1 },
  { key: 'mod+alt+l', command: 'text.paragraph', args: { patch: { align: 'left' } } },
  { key: 'mod+alt+t', command: 'text.paragraph', args: { patch: { align: 'center' } } },
  { key: 'mod+alt+r', command: 'text.paragraph', args: { patch: { align: 'right' } } },
  { key: 'mod+alt+j', command: 'text.paragraph', args: { patch: { align: 'justify' } } },
  { key: 'mod+shift+8', command: 'text.list', args: 'bullet' },
  { key: 'mod+shift+7', command: 'text.list', args: 'number' },

  // 下面这几个命令由界面层注册（要用浏览器的剪贴板、打开演示界面）。⌘C / ⌘V 走浏览器的 copy、paste 事件，不在这里
  { key: 'mod+shift+c', command: 'edit.copyAsPng' },
  { key: 'mod+enter', command: 'present.play' },
  { key: 'mod+shift+enter', command: 'present.playFromStart' },
  { key: 'mod+r', command: 'node.rename' },
  { key: 'alt+1', command: 'dock.show', args: 'layers' },
  { key: 'alt+2', command: 'dock.show', args: 'assets' },
  { key: 'alt+3', command: 'dock.show', args: 'slides' },
  { key: 'mod+\\', command: 'dock.toggleHidden' },
  { key: 'mod+k', command: 'help.commandPalette' },
  { key: 'shift+/', command: 'help.shortcuts' },
  { key: 'mod+shift+k', command: 'image.pick' },
];
