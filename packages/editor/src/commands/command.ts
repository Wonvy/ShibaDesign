import type { Editor } from '../editor';

/**
 * 命令：一个有 id 的可执行操作。按钮、菜单、快捷键都只引用命令 id。
 * 新增功能：写一个 Command，调用 editor.commands.register(command)。
 */
export interface Command<A = void> {
  id: string;
  run(editor: Editor, args: A): void;
  /** 当前是否可执行；不提供时始终可执行 */
  enabled?(editor: Editor, args: A): boolean;
}

export class CommandRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private commands = new Map<string, Command<any>>();

  constructor(private readonly editor: Editor) {}

  register<A>(command: Command<A>): this {
    this.commands.set(command.id, command);
    return this;
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  canRun(id: string, args?: unknown): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    return command.enabled ? command.enabled(this.editor, args) : true;
  }

  /** 执行命令；命令不存在或当前不可用时返回 false */
  run(id: string, args?: unknown): boolean {
    const command = this.commands.get(id);
    if (!command) {
      console.warn(`[shiba] 未注册的命令：${id}`);
      return false;
    }
    if (command.enabled && !command.enabled(this.editor, args)) return false;
    command.run(this.editor, args);
    return true;
  }

  list(): string[] {
    return [...this.commands.keys()];
  }
}
