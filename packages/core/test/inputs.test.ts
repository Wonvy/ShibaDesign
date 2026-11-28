import { describe, expect, it } from 'vitest';
import { DocStore, createNode, evaluateNumberInput, parseColorText } from '../src';

describe('数字输入框的算式', () => {
  it('普通的数和四则运算、括号', () => {
    expect(evaluateNumberInput('42', 0)).toBe(42);
    expect(evaluateNumberInput('100+20', 0)).toBe(120);
    expect(evaluateNumberInput('(10 + 5) * 2', 0)).toBe(30);
    expect(evaluateNumberInput('10-2*3', 0)).toBe(4);
    expect(evaluateNumberInput('-5', 10)).toBe(-5);
    expect(evaluateNumberInput('.5', 0)).toBe(0.5);
    expect(evaluateNumberInput('3×4', 0)).toBe(12);
  });

  it('开头是运算符时相对现在的值；百分号是现在的值的百分之几', () => {
    expect(evaluateNumberInput('*2', 30)).toBe(60);
    expect(evaluateNumberInput('/3', 30)).toBe(10);
    expect(evaluateNumberInput('+10', 30)).toBe(40);
    expect(evaluateNumberInput('50%', 200)).toBe(100);
    expect(evaluateNumberInput('+10%', 200)).toBe(220);
  });

  it('算不出来时返回 null', () => {
    expect(evaluateNumberInput('', 1)).toBeNull();
    expect(evaluateNumberInput('abc', 1)).toBeNull();
    expect(evaluateNumberInput('1/0', 1)).toBeNull();
    expect(evaluateNumberInput('(1+2', 1)).toBeNull();
    expect(evaluateNumberInput('2+', 1)).toBeNull();
    expect(evaluateNumberInput('alert(1)', 1)).toBeNull();
  });
});

describe('颜色输入', () => {
  it('十六进制、rgb()、rgba()、hsl()', () => {
    expect(parseColorText('#ff0000')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColorText('0f0')).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(parseColorText('rgb(0, 0, 255)')).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(parseColorText('rgba(255 255 255 / 50%)')).toEqual({ r: 1, g: 1, b: 1, a: 0.5 });
    const green = parseColorText('hsl(120, 100%, 50%)')!;
    expect(green.r).toBeCloseTo(0, 9);
    expect(green.g).toBeCloseTo(1, 9);
    expect(green.b).toBeCloseTo(0, 9);
    const gray = parseColorText('hsla(0deg 0% 50% / 0.25)')!;
    expect(gray).toMatchObject({ a: 0.25 });
    expect(gray.r).toBeCloseTo(0.5, 9);
    expect(parseColorText('rgb(1, 2)')).toBeNull();
    expect(parseColorText('blue')).toBeNull();
  });
});

describe('撤销分组', () => {
  it('beginGroup 和 endGroup 之间的修改合成一步撤销，中间的封口不起作用', () => {
    const store = DocStore.create();
    const rect = store.transact('add', (tx) =>
      tx.create(
        createNode('rect', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [10, 10],
          cornerRadius: 0,
          fill: null,
          stroke: null,
        }),
      ),
    );
    store.sealHistory();
    store.beginGroup();
    for (const w of [20, 30, 40]) {
      store.transact('resize', (tx) => tx.update(rect.id, { size: [w, 10] }));
      store.sealHistory();
    }
    store.endGroup();
    expect(store.get(rect.id)?.size).toEqual([40, 10]);
    store.undo();
    expect(store.get(rect.id)?.size).toEqual([10, 10]);
    store.undo();
    expect(store.get(rect.id)).toBeUndefined();
  });
});
