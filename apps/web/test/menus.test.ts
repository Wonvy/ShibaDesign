import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '@shiba/editor';
import en from '../src/i18n/locales/en.json';
import zh from '../src/i18n/locales/zh-CN.json';
import { COMMAND_GROUPS, COMMAND_LABELS, commandGroup, labelKeyFor } from '../src/menus/labels';
import { tidy, type MenuEntry } from '../src/menus/model';

function lookup(strings: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], strings);
}

describe('菜单的名字', () => {
  it('每条快捷键都有名字，分组认得', () => {
    const missing = DEFAULT_BINDINGS.filter((b) => !labelKeyFor(b.command, b.args)).map((b) => b.command);
    expect(missing).toEqual([]);
    for (const binding of DEFAULT_BINDINGS) {
      expect(COMMAND_GROUPS).toContain(commandGroup(binding.command));
    }
  });

  it('名字在中英文语言包里都有', () => {
    for (const key of [...new Set(Object.values(COMMAND_LABELS))]) {
      expect(typeof lookup(zh.strings, key), `zh-CN 缺 ${key}`).toBe('string');
      expect(typeof lookup(en.strings, key), `en 缺 ${key}`).toBe('string');
    }
    for (const group of COMMAND_GROUPS) {
      expect(typeof lookup(zh.strings, `menu.group.${group}`)).toBe('string');
      expect(typeof lookup(en.strings, `menu.group.${group}`)).toBe('string');
    }
  });

  it('带参数的查不到时退回不带参数的那一条', () => {
    expect(labelKeyFor('edit.nudge', { dx: 1, dy: 0 })).toBe('menu.nudge');
    expect(labelKeyFor('arrange.align', 'left')).toBe('align.left');
    expect(labelKeyFor('nothing.here')).toBeUndefined();
  });

  it('菜单里多余的分隔线去掉', () => {
    const item = { id: 'a', labelKey: 'x' };
    const entries: MenuEntry[] = ['separator', item, 'separator', 'separator', item, 'separator'];
    expect(tidy(entries)).toEqual([item, 'separator', item]);
  });
});
