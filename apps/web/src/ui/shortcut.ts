/** 当前是不是苹果的系统。快捷键在 Mac 上显示成 ⌘⇧Z，在别的系统上显示成 Ctrl+Shift+Z */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const MODIFIERS = ['mod', 'alt', 'shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Mac 上修饰键的顺序和系统菜单一致：⌃⌥⇧⌘ */
const MAC_ORDER: readonly Modifier[] = ['alt', 'shift', 'mod'];
const MAC_SYMBOL: Record<Modifier, string> = { mod: '⌘', alt: '⌥', shift: '⇧' };
const PC_ORDER: readonly Modifier[] = ['mod', 'alt', 'shift'];
const PC_NAME: Record<Modifier, string> = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' };

const MAC_KEYS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  ' ': 'Space',
};
const PC_KEYS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Del',
  tab: 'Tab',
  ' ': 'Space',
};

/** 把快捷键表里的写法（'mod+shift+z'、'shift++'）拆成修饰键和主键 */
export function parseShortcut(key: string): { modifiers: Set<Modifier>; base: string } {
  const modifiers = new Set<Modifier>();
  let rest = key;
  for (;;) {
    const found = MODIFIERS.find((m) => rest.startsWith(`${m}+`) && rest.length > m.length + 1);
    if (!found) break;
    modifiers.add(found);
    rest = rest.slice(found.length + 1);
  }
  return { modifiers, base: rest };
}

/** 给人看的快捷键：Mac 上是 "⌥⌘K"，别的系统是 "Ctrl+Alt+K" */
export function formatShortcut(key: string, mac = IS_MAC): string {
  const { modifiers, base } = parseShortcut(key);
  const names = mac ? MAC_KEYS : PC_KEYS;
  const main = names[base] ?? (base.length === 1 ? base.toUpperCase() : base.charAt(0).toUpperCase() + base.slice(1));
  if (mac)
    return (
      MAC_ORDER.filter((m) => modifiers.has(m))
        .map((m) => MAC_SYMBOL[m])
        .join('') + main
    );
  return [...PC_ORDER.filter((m) => modifiers.has(m)).map((m) => PC_NAME[m]), main].join('+');
}
