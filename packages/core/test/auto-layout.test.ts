import { describe, expect, it } from 'vitest';
import { computeLayout, inferLayout, isAutoLayout, isItemSizing, type AutoLayout, type LayoutItem } from '../src';

const layout = (patch: Partial<AutoLayout> = {}): AutoLayout => ({
  direction: 'horizontal',
  gap: 10,
  padding: [5, 20, 5, 20],
  justify: 'start',
  align: 'start',
  sizing: { h: 'fixed', v: 'fixed' },
  ...patch,
});
const item = (id: string, width: number, height: number, sizing: Partial<LayoutItem['sizing']> = {}): LayoutItem => ({
  id,
  width,
  height,
  sizing: { h: 'fixed', v: 'fixed', ...sizing },
});
const items = [item('a', 40, 20), item('b', 60, 30), item('c', 20, 10)];

describe('自动布局的计算', () => {
  it('横排：从左内边距开始，一个接一个，间距 10；交叉轴靠上', () => {
    const r = computeLayout([300, 100], layout(), items);
    expect(r.size).toEqual([300, 100]);
    expect(r.boxes.get('a')).toEqual({ x: 20, y: 5, w: 40, h: 20 });
    expect(r.boxes.get('b')).toEqual({ x: 70, y: 5, w: 60, h: 30 });
    expect(r.boxes.get('c')).toEqual({ x: 140, y: 5, w: 20, h: 10 });
  });

  it('包住内容：画框的大小等于内容加内边距', () => {
    const r = computeLayout([300, 100], layout({ sizing: { h: 'hug', v: 'hug' } }), items);
    // 40 + 60 + 20 + 两个间距 20 + 左右内边距 40；高 30 + 上下 10
    expect(r.size).toEqual([180, 40]);
  });

  it('竖排、居中对齐、主轴靠后', () => {
    const r = computeLayout([100, 200], layout({ direction: 'vertical', align: 'center', justify: 'end' }), items);
    // 主轴可用 190，内容 20 + 30 + 10 + 20 = 80，从 5 + 110 = 115 开始
    expect(r.boxes.get('a')).toEqual({ x: 20 + (60 - 40) / 2, y: 115, w: 40, h: 20 });
    expect(r.boxes.get('c')!.y).toBe(115 + 20 + 10 + 30 + 10);
  });

  it('两端对齐：间距撑开到填满', () => {
    const r = computeLayout([300, 100], layout({ justify: 'spaceBetween' }), items);
    expect(r.boxes.get('a')!.x).toBe(20);
    expect(r.boxes.get('c')!.x + 20).toBe(280);
    // 可用 260，内容 120，两个空隙各 70
    expect(r.boxes.get('b')!.x).toBe(20 + 40 + 70);
  });

  it('填满：剩下的空间平分给填满的；交叉轴填满等于画框里的高度', () => {
    const r = computeLayout([300, 100], layout(), [item('a', 40, 20), item('b', 10, 30, { h: 'fill', v: 'fill' })]);
    // 可用 260 - 40 - 间距 10 = 210
    expect(r.boxes.get('b')).toEqual({ x: 70, y: 5, w: 210, h: 90 });
  });

  it('包住内容的方向上填满按固定算', () => {
    const r = computeLayout([300, 100], layout({ sizing: { h: 'hug', v: 'fixed' } }), [
      item('a', 40, 20, { h: 'fill' }),
    ]);
    expect(r.boxes.get('a')!.w).toBe(40);
    expect(r.size[0]).toBe(80);
  });

  it('宽度变了的子对象重新量高度（文字折行），包住内容的画框跟着变高', () => {
    const measure = (_: LayoutItem, width: number) => Math.ceil(400 / width) * 10;
    const r = computeLayout(
      [200, 50],
      layout({ direction: 'vertical', padding: [0, 0, 0, 0], sizing: { h: 'fixed', v: 'hug' } }),
      [item('t', 400, 10, { h: 'fill' })],
      measure,
    );
    expect(r.boxes.get('t')).toEqual({ x: 0, y: 0, w: 200, h: 20 });
    expect(r.size).toEqual([200, 20]);
  });

  it('按现在的摆放猜一套：竖着排的猜成竖排，间距取平均空隙，内边距取到四边的距离', () => {
    const guess = inferLayout(
      [100, 200],
      [
        { x: 10, y: 10, w: 80, h: 30 },
        { x: 10, y: 50, w: 80, h: 30 },
        { x: 10, y: 94, w: 80, h: 30 },
      ],
    );
    expect(guess).toMatchObject({ direction: 'vertical', gap: 12, padding: [10, 10, 76, 10] });
  });

  it('文件校验', () => {
    expect(isAutoLayout(layout())).toBe(true);
    expect(isAutoLayout({ ...layout(), direction: 'diagonal' })).toBe(false);
    expect(isAutoLayout({ ...layout(), padding: [1, 2, 3] })).toBe(false);
    expect(isAutoLayout({ ...layout(), padding: [1, 2, 3, -4] })).toBe(false);
    expect(isAutoLayout({ ...layout(), sizing: { h: 'fill', v: 'hug' } })).toBe(false);
    expect(isItemSizing({ h: 'fill', v: 'fixed' })).toBe(true);
    expect(isItemSizing({ h: 'hug', v: 'fixed' })).toBe(false);
  });
});
