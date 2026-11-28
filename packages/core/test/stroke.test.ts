import { describe, expect, it } from 'vitest';
import { dashKind, dashPattern, dashPreset, rgba } from '../src';

describe('描边的虚线', () => {
  it('奇数个长度重复一遍；空的、全是 0 的、有负数的当作实线', () => {
    expect(dashPattern({ dash: [6] })).toEqual([6, 6]);
    expect(dashPattern({ dash: [6, 2, 1] })).toEqual([6, 2, 1, 6, 2, 1]);
    expect(dashPattern({ dash: [0, 4] })).toEqual([0, 4]);
    expect(dashPattern({})).toBeNull();
    expect(dashPattern({ dash: [] })).toBeNull();
    expect(dashPattern({ dash: [0, 0] })).toBeNull();
    expect(dashPattern({ dash: [4, -1] })).toBeNull();
  });

  it('预设按线宽算；认得出用的是哪个预设', () => {
    const color = rgba(0, 0, 0);
    expect(dashPreset('dashed', 2)).toEqual({ dash: [8, 4], cap: 'butt' });
    expect(dashPreset('dotted', 2)).toEqual({ dash: [0, 4], cap: 'round' });
    expect(dashPreset('solid', 2)).toEqual({ dash: undefined, cap: undefined });
    expect(dashKind({ color, width: 2, ...dashPreset('dashed', 2) })).toBe('dashed');
    expect(dashKind({ color, width: 2, ...dashPreset('dotted', 2) })).toBe('dotted');
    expect(dashKind({ color, width: 2 })).toBe('solid');
    expect(dashKind({ color, width: 2, dash: [5, 1] })).toBe('custom');
  });
});
