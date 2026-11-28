import { describe, expect, it } from 'vitest';
import {
  DocStore,
  activeEffects,
  blurSigma,
  createNode,
  defaultEffect,
  effectOutset,
  isEffectList,
  validateDocument,
} from '../src';

describe('效果', () => {
  it('模糊半径换成标准差是一半；关掉的效果不算；画板不画效果', () => {
    expect(blurSigma(8)).toBe(4);
    expect(blurSigma(-1)).toBe(0);
    const store = DocStore.create();
    const effects = [defaultEffect('dropShadow'), { ...defaultEffect('layerBlur'), hidden: true }];
    const [rect, board] = store.transact('add', (tx) => [
      tx.create(
        createNode('rect', {
          parent: store.root.id,
          index: 'a0',
          seq: 1,
          size: [10, 10],
          cornerRadius: 0,
          fill: null,
          stroke: null,
          effects,
        }),
      ),
      tx.create(
        createNode('artboard', {
          parent: store.root.id,
          index: 'a1',
          seq: 1,
          size: [10, 10],
          fill: null,
          deck: null,
          effects,
        }),
      ),
    ]);
    expect(activeEffects(rect!)).toEqual([effects[0]]);
    expect(activeEffects(board!)).toEqual([]);
  });

  it('画出来的范围：投影按偏移、扩展、三倍标准差往外扩，图层模糊四周再扩；内阴影、背景模糊不扩', () => {
    expect(
      effectOutset([{ type: 'dropShadow', color: { r: 0, g: 0, b: 0, a: 1 }, x: 4, y: -2, blur: 4, spread: 1 }]),
    ).toEqual({ left: 3, top: 9, right: 11, bottom: 5 });
    expect(effectOutset([{ type: 'layerBlur', radius: 10 }])).toEqual({ left: 15, top: 15, right: 15, bottom: 15 });
    expect(
      effectOutset([
        { type: 'innerShadow', color: { r: 0, g: 0, b: 0, a: 1 }, x: 40, y: 40, blur: 10, spread: 0 },
        { type: 'backgroundBlur', radius: 30 },
      ]),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('文件校验：认识的类型、有限的数字、模糊不是负数、不超过 16 个', () => {
    expect(isEffectList([defaultEffect('innerShadow'), defaultEffect('backgroundBlur')])).toBe(true);
    expect(isEffectList([{ type: 'glow', radius: 3 }])).toBe(false);
    expect(isEffectList([{ ...defaultEffect('dropShadow'), blur: -1 }])).toBe(false);
    expect(isEffectList([{ type: 'layerBlur', radius: Number.NaN }])).toBe(false);
    expect(isEffectList(Array.from({ length: 17 }, () => defaultEffect('layerBlur')))).toBe(false);
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
          effects: [defaultEffect('dropShadow')],
        }),
      ),
    );
    const good = store.toJSON();
    expect(() => validateDocument(good)).not.toThrow();
    const bad = { ...good, nodes: { ...good.nodes, [rect.id]: { ...rect, effects: [{ type: 'dropShadow' }] } } };
    expect(() => validateDocument(bad)).toThrow();
  });
});
