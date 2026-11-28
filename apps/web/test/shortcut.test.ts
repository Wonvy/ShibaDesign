import { describe, expect, it } from 'vitest';
import { formatShortcut, parseShortcut } from '../src/ui/shortcut';

describe('快捷键的显示', () => {
  it('拆出修饰键和主键，加号本身也能当主键', () => {
    expect(parseShortcut('mod+shift+z')).toEqual({ modifiers: new Set(['mod', 'shift']), base: 'z' });
    expect(parseShortcut('shift++')).toEqual({ modifiers: new Set(['shift']), base: '+' });
    expect(parseShortcut('=')).toEqual({ modifiers: new Set(), base: '=' });
  });

  it('Mac 上按 ⌥⇧⌘ 的顺序写符号', () => {
    expect(formatShortcut('mod+shift+z', true)).toBe('⇧⌘Z');
    expect(formatShortcut('mod+alt+k', true)).toBe('⌥⌘K');
    expect(formatShortcut('shift+arrowleft', true)).toBe('⇧←');
    expect(formatShortcut('mod+enter', true)).toBe('⌘↵');
    expect(formatShortcut('v', true)).toBe('V');
  });

  it('别的系统上写成 Ctrl+Alt+Shift+键', () => {
    expect(formatShortcut('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(formatShortcut('mod+alt+k', false)).toBe('Ctrl+Alt+K');
    expect(formatShortcut('delete', false)).toBe('Del');
    expect(formatShortcut('shift+1', false)).toBe('Shift+1');
  });
});
