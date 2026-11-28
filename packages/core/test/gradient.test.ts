import { describe, expect, it } from 'vitest';
import {
  DocumentError,
  createNode,
  defaultGradient,
  gradientAverage,
  gradientColorAt,
  gradientCss,
  linearGradientAngle,
  linearGradientPoints,
  normalizeStops,
  reverseStops,
  rgba,
  validateDocument,
  type GradientFill,
} from '../src';

const RED = rgba(1, 0, 0);
const BLUE = rgba(0, 0, 1);

describe('渐变', () => {
  it('按画面上的角度摆线性渐变：两头的色标正好落在外框的对角上，读回来还是同一个角度', () => {
    expect(linearGradientPoints(0, 200, 100)).toEqual({ start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } });
    expect(linearGradientPoints(90, 200, 100)).toEqual({ start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } });
    // 宽矮的框里 45° 的色带：起点在左上角之外一点，让左上角正好是第一个色标
    const diagonal = linearGradientPoints(45, 200, 100);
    expect(linearGradientAngle(diagonal, 200, 100)).toBe(45);
    for (const angle of [0, 30, 90, 135, 200, 315]) {
      expect(linearGradientAngle(linearGradientPoints(angle, 300, 120), 300, 120)).toBe(angle);
    }
  });

  it('颜色和透明度分开直线过渡；两头之外延续首尾的颜色', () => {
    const stops = [
      { offset: 0.2, color: RED },
      { offset: 0.8, color: { ...BLUE, a: 0 } },
    ];
    expect(gradientColorAt(stops, 0)).toEqual(RED);
    const middle = gradientColorAt(stops, 0.5);
    expect([middle.r, middle.g, middle.b, middle.a].map((v) => Math.round(v * 1000) / 1000)).toEqual([
      0.5, 0, 0.5, 0.5,
    ]);
    expect(gradientColorAt(stops, 1)).toEqual({ ...BLUE, a: 0 });
    const average = gradientAverage([
      { offset: 0, color: RED },
      { offset: 1, color: BLUE },
    ]);
    expect(average.r).toBeCloseTo(0.5, 2);
    expect(average.b).toBeCloseTo(0.5, 2);
  });

  it('色标整理、反向、默认渐变', () => {
    expect(
      normalizeStops([
        { offset: 1.5, color: BLUE },
        { offset: -1, color: RED },
      ]),
    ).toEqual([
      { offset: 0, color: RED },
      { offset: 1, color: BLUE },
    ]);
    expect(
      reverseStops([
        { offset: 0.2, color: RED },
        { offset: 1, color: BLUE },
      ]),
    ).toEqual([
      { offset: 0, color: BLUE },
      { offset: 0.8, color: RED },
    ]);
    const fill = defaultGradient(rgba(0.1, 0.2, 0.8), 'linear', 100, 100);
    expect(fill.stops[0]!.color).toEqual(rgba(0.1, 0.2, 0.8));
    // 深色往浅里过渡
    expect(fill.stops[1]!.color.r).toBeGreaterThan(0.5);
  });

  it('CSS 写法：线性渐变的色标位置换算到 CSS 的色带上，径向用相对外框的百分比', () => {
    const fill: GradientFill = {
      type: 'gradient',
      kind: 'linear',
      ...linearGradientPoints(90, 100, 50),
      stops: [
        { offset: 0, color: RED },
        { offset: 1, color: BLUE },
      ],
    };
    expect(gradientCss(fill, 100, 50)).toBe('linear-gradient(180deg, rgba(255, 0, 0, 1) 0%, rgba(0, 0, 255, 1) 100%)');
    const radial: GradientFill = { ...fill, kind: 'radial', start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 } };
    expect(gradientCss(radial, 100, 50)).toBe(
      'radial-gradient(50% 100% at 50% 50%, rgba(255, 0, 0, 1) 0%, rgba(0, 0, 255, 1) 100%)',
    );
  });

  it('文件里的渐变要过校验：色标至少两个、位置在 0 到 1 之间', () => {
    const root = createNode('page', { parent: null, index: 'a0', seq: 1 });
    const doc = (fill: unknown) => ({
      version: 1,
      rootId: root.id,
      nodes: {
        [root.id]: root,
        r: {
          ...createNode('rect', { parent: root.id, index: 'a1', seq: 1, cornerRadius: 0, fill: null, stroke: null }),
          id: 'r',
          fill,
        },
      },
    });
    const good = {
      type: 'gradient',
      kind: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      stops: [
        { offset: 0, color: RED },
        { offset: 1, color: BLUE },
      ],
    };
    expect(() => validateDocument(doc(good))).not.toThrow();
    for (const bad of [
      { ...good, stops: [{ offset: 0, color: RED }] },
      {
        ...good,
        stops: [
          { offset: 0, color: RED },
          { offset: 2, color: BLUE },
        ],
      },
      { ...good, start: { x: 'a', y: 0 } },
    ]) {
      expect(() => validateDocument(doc(bad))).toThrow(DocumentError);
    }
  });
});
