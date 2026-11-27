/**
 * 通用注册表。工具、命令等可扩展的东西都放在注册表里：
 * 新增功能 = 写一个带 id 的对象并 register，不需要改已有代码。
 */
export class Registry<T extends { id: string }> {
  private items = new Map<string, T>();

  constructor(private readonly kind: string) {}

  register(item: T): this {
    this.items.set(item.id, item);
    return this;
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  require(id: string): T {
    const item = this.items.get(id);
    if (!item) throw new Error(`未注册的${this.kind}：${id}`);
    return item;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  list(): T[] {
    return [...this.items.values()];
  }
}
