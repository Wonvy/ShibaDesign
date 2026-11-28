import type { ContextInfo, Editor } from '@shiba/editor';

/**
 * 菜单的数据模型。右键菜单、顶部菜单栏、命令面板用同一份菜单项定义，
 * 所以不会出现"右键里有、菜单里没有"，快捷键也只在快捷键表里写一次。
 */

export interface MenuContext {
  editor: Editor;
  /** 右键点到了什么；顶部菜单栏和命令面板里是按当前选区算的 */
  info: ContextInfo;
  /** 面板里右键点到的那一项（幻灯片、图层、样式、组件）的 id */
  subject?: string;
}

export interface MenuItemDef {
  /** 在同一个菜单里唯一，命令面板也用它去重 */
  id: string;
  /** 显示的文字（语言包的键） */
  labelKey: string;
  labelArgs?: Record<string, unknown>;
  /** 已经翻译好的文字（图层名、页码这类不在语言包里的）；有它时不用 labelKey */
  label?: string;
  /** 执行一个命令：能不能点看命令的 enabled，快捷键从快捷键表里取 */
  command?: string;
  args?: unknown;
  /** 不是命令的操作（打开对话框、切换面板） */
  run?: (ctx: MenuContext) => void;
  /** 额外的"能不能点"；和命令的 enabled 同时满足才能点 */
  enabled?: (ctx: MenuContext) => boolean;
  checked?: (ctx: MenuContext) => boolean;
  /** 子菜单 */
  submenu?: (ctx: MenuContext) => MenuEntry[];
  /** 不在快捷键表里的快捷键（⌘C、⌘V 走浏览器事件），只用来显示 */
  shortcut?: string;
  /** 悬停在这一项上时（"选择图层"里的某一层）画布上高亮它 */
  hoverNode?: string;
}

export type MenuEntry = MenuItemDef | 'separator';

/** 一项算出来的样子：能不能点、显示的快捷键 */
export interface ResolvedItem {
  def: MenuItemDef;
  enabled: boolean;
  checked: boolean;
  shortcut: string | undefined;
}

export function resolveItem(def: MenuItemDef, ctx: MenuContext): ResolvedItem {
  const { editor } = ctx;
  const commandOk = def.command ? editor.commands.canRun(def.command, def.args) : true;
  const extraOk = def.enabled ? def.enabled(ctx) : true;
  const hasAction = Boolean(def.command || def.run || def.submenu);
  return {
    def,
    enabled: hasAction && commandOk && extraOk,
    checked: def.checked ? def.checked(ctx) : false,
    shortcut: def.shortcut ?? (def.command ? editor.keymap.keyFor(def.command, def.args) : undefined),
  };
}

export function runItem(def: MenuItemDef, ctx: MenuContext): void {
  if (def.run) def.run(ctx);
  else if (def.command) ctx.editor.commands.run(def.command, def.args);
}

/** 去掉开头、结尾和连着的分隔线（某一组的项都不出现时会剩下） */
export function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry === 'separator' && (out.length === 0 || out.at(-1) === 'separator')) continue;
    out.push(entry);
  }
  while (out.at(-1) === 'separator') out.pop();
  return out;
}

type MenuBuilder = (ctx: MenuContext) => MenuEntry[];

const menus = new Map<string, MenuBuilder>();
const extensions = new Map<string, { order: number; build: MenuBuilder }[]>();

/** 注册一个菜单（右键菜单或者顶部菜单栏的一栏）。同 id 后注册的覆盖先注册的 */
export function registerMenu(id: string, build: MenuBuilder): void {
  menus.set(id, build);
}

/**
 * 往已有的菜单里加项（扩展功能用）：加在末尾，前面自动加分隔线；order 小的在前
 */
export function extendMenu(id: string, build: MenuBuilder, order = 100): void {
  const list = extensions.get(id) ?? [];
  list.push({ order, build });
  list.sort((a, b) => a.order - b.order);
  extensions.set(id, list);
}

export function buildMenu(id: string, ctx: MenuContext): MenuEntry[] {
  const base = menus.get(id)?.(ctx) ?? [];
  const extra = (extensions.get(id) ?? []).flatMap((e) => ['separator' as const, ...e.build(ctx)]);
  return tidy([...base, ...extra]);
}
