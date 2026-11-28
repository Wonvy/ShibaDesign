import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, Keymap, keyOf } from '../src/keymap';

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: '',
    code: '',
    ...init,
  } as KeyboardEvent;
}

describe('快捷键匹配', () => {
  it('字母和数字按物理键认，Mac 上按着 Option 打出别的字符也配得上', () => {
    expect(keyOf(key({ key: '˚', code: 'KeyK', altKey: true, metaKey: true }))).toBe('mod+alt+k');
    expect(keyOf(key({ key: '!', code: 'Digit1', shiftKey: true }))).toBe('shift+1');
    expect(keyOf(key({ key: 'V', code: 'KeyV', shiftKey: true }))).toBe('shift+v');
  });

  it('标点也按物理键认，写不按 Shift 时的字；方向键、功能键按 event.key 认', () => {
    expect(keyOf(key({ key: ']', code: 'BracketRight', metaKey: true }))).toBe('mod+]');
    expect(keyOf(key({ key: '“', code: 'BracketLeft', metaKey: true, altKey: true }))).toBe('mod+alt+[');
    expect(keyOf(key({ key: '+', code: 'Equal', shiftKey: true }))).toBe('shift+=');
    expect(keyOf(key({ key: '>', code: 'Period', shiftKey: true, metaKey: true }))).toBe('mod+shift+.');
    expect(keyOf(key({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true }))).toBe('shift+arrowleft');
  });

  it('没有 code 的事件（模拟出来的、某些虚拟键盘）退回 event.key', () => {
    expect(keyOf(key({ key: 'v' }))).toBe('v');
  });

  it('默认绑定：Shift+1 适应画面、Shift+0 缩放到 100%', () => {
    const keymap = new Keymap().add(...DEFAULT_BINDINGS);
    expect(keymap.match(key({ key: '!', code: 'Digit1', shiftKey: true }))?.command).toBe('view.zoomToFit');
    expect(keymap.match(key({ key: ')', code: 'Digit0', shiftKey: true }))?.command).toBe('view.zoom100');
  });
});
