import { describe, expect, it } from 'vitest';
import {
  IDENTITY_CURVE,
  IMAGE_PRESETS,
  channelTables,
  curveFunction,
  curveTable,
  hasCurves,
  imagePreset,
  isIdentityCurve,
  normalizeCurve,
  normalizeCurves,
} from '../src';

const p = (x: number, y: number) => ({ x, y });

describe('曲线', () => {
  it('两个点之间是直线，经过每个控制点，第一个点左边、最后一个点右边是平的', () => {
    const line = curveFunction([p(0, 0.2), p(1, 0.8)]);
    expect(line(0.5)).toBeCloseTo(0.5, 6);
    const s = curveFunction([p(0.1, 0.05), p(0.3, 0.2), p(0.7, 0.85), p(0.9, 0.95)]);
    expect(s(0.3)).toBeCloseTo(0.2, 6);
    expect(s(0.7)).toBeCloseTo(0.85, 6);
    expect(s(0)).toBe(0.05);
    expect(s(1)).toBe(0.95);
  });

  it('单调插值：控制点单调时曲线也单调，不会冲过相邻两点', () => {
    const table = curveTable([p(0, 0), p(0.1, 0.6), p(0.2, 0.65), p(1, 1)]);
    for (let i = 1; i < table.length; i++) expect(table[i]!).toBeGreaterThanOrEqual(table[i - 1]! - 1e-6);
    // 0.1 到 0.2 这一段在 0.6 和 0.65 之间
    for (let i = 26; i <= 51; i++) {
      expect(table[i]!).toBeGreaterThanOrEqual(0.6 - 1e-6);
      expect(table[i]!).toBeLessThanOrEqual(0.65 + 1e-6);
    }
  });

  it('整理控制点：排序、限制在 0–1、x 相同的只留后一个、不够两个点时没有曲线', () => {
    expect(normalizeCurve([p(1.2, 0.5), p(0.5, -1), p(0.5, 0.4), p(0, 0)])).toEqual([p(0, 0), p(0.5, 0.4), p(1, 0.5)]);
    expect(normalizeCurve([p(0.5, 0.5)])).toBeNull();
    expect(normalizeCurve([p(0, Number.NaN), p(1, 1)])).toBeNull();
  });

  it('不变的直线：两端在 (0, 0) 和 (1, 1)，中间的点都在对角线上', () => {
    expect(isIdentityCurve(undefined)).toBe(true);
    expect(isIdentityCurve(IDENTITY_CURVE)).toBe(true);
    expect(isIdentityCurve([p(0, 0), p(0.4, 0.4), p(1, 1)])).toBe(true);
    expect(isIdentityCurve([p(0, 0.1), p(1, 1)])).toBe(false);
    // 端点不在两头时，两头是平的，不是直线
    expect(isIdentityCurve([p(0.2, 0.2), p(1, 1)])).toBe(false);
    expect(hasCurves({ red: IDENTITY_CURVE })).toBe(false);
    expect(normalizeCurves({ rgb: IDENTITY_CURVE, blue: [p(0, 0), p(1, 0.5)] })).toEqual({
      blue: [p(0, 0), p(1, 0.5)],
    });
    expect(normalizeCurves({ rgb: IDENTITY_CURVE })).toBeUndefined();
  });

  it('通道的查找表：先过通道自己的曲线，再过总曲线', () => {
    const tables = channelTables({ rgb: [p(0, 0), p(1, 0.5)], red: [p(0, 1), p(1, 0)] })!;
    // 红：0 → 通道曲线 1 → 总曲线 0.5；绿没有自己的曲线：1 → 0.5
    expect(tables.red[0]).toBeCloseTo(0.5, 6);
    expect(tables.red[255]).toBeCloseTo(0, 6);
    expect(tables.green[255]).toBeCloseTo(0.5, 6);
    expect(channelTables({})).toBeNull();
  });
});

describe('滤镜预设', () => {
  it('id 不重复，曲线都是有效的，按 id 找得到；不认识的 id 当作没有', () => {
    const ids = IMAGE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of IMAGE_PRESETS) {
      expect(imagePreset(preset.id)).toBe(preset);
      for (const curve of Object.values(preset.curves ?? {})) expect(normalizeCurve(curve)).toEqual(curve);
    }
    expect(imagePreset('from-the-future')).toBeUndefined();
  });
});
