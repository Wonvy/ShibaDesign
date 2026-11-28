import { describe, expect, it } from 'vitest';
import { defaultLayoutGrid, isLayoutGridList, stripeBands, type StripeGrid } from '../src';

const red = { r: 1, g: 0, b: 0, a: 0.1 };
const columns = (patch: Partial<StripeGrid> = {}): StripeGrid => ({
  type: 'columns',
  count: 4,
  gutter: 20,
  margin: 40,
  color: red,
  ...patch,
});

describe('版面网格', () => {
  it('拉伸的列：两边留边距，列之间留间隔，列宽平分剩下的', () => {
    // 1000 - 80 - 60 = 860，每列 215
    expect(stripeBands(columns(), 1000)).toEqual([
      { start: 40, size: 215 },
      { start: 275, size: 215 },
      { start: 510, size: 215 },
      { start: 745, size: 215 },
    ]);
  });

  it('固定宽度的列：整组靠前、居中、靠后', () => {
    // 4 × 100 + 3 × 20 = 460
    expect(stripeBands(columns({ size: 100 }), 1000)[0]!.start).toBe(40);
    expect(stripeBands(columns({ size: 100, align: 'center' }), 1000)[0]!.start).toBe(270);
    expect(stripeBands(columns({ size: 100, align: 'end' }), 1000)[3]).toEqual({ start: 860, size: 100 });
  });

  it('默认值和文件校验', () => {
    expect(defaultLayoutGrid('columns')).toMatchObject({ type: 'columns', count: 12, gutter: 20, margin: 20 });
    expect(isLayoutGridList([defaultLayoutGrid('columns'), defaultLayoutGrid('rows'), defaultLayoutGrid('grid')])).toBe(
      true,
    );
    expect(isLayoutGridList([{ ...defaultLayoutGrid('columns'), count: 0 }])).toBe(false);
    expect(isLayoutGridList([{ ...defaultLayoutGrid('columns'), align: 'middle' }])).toBe(false);
    expect(isLayoutGridList([{ type: 'grid', size: 0, color: red }])).toBe(false);
    expect(isLayoutGridList([{ type: 'dots', size: 4, color: red }])).toBe(false);
  });
});
