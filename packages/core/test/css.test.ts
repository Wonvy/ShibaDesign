import { describe, expect, it } from 'vitest';
import {
  createNode,
  cssText,
  exportFileName,
  isExportList,
  nodeCss,
  rgba,
  solid,
  translation,
  type FrameNode,
  type RectNode,
  type TextNode,
} from '../src';

const base = { parent: 'p', index: 'a0', seq: 1 };

describe('写成 CSS', () => {
  it('矩形：宽高、背景、边框、圆角、阴影、模糊、不透明度、混合模式', () => {
    const rect = createNode('rect', {
      ...base,
      transform: translation(10, 10),
      size: [120, 40],
      cornerRadius: 8,
      fill: solid(rgba(0.2, 0.4, 1)),
      stroke: { color: rgba(0, 0, 0, 0.5), width: 2, dash: [4, 2] },
      opacity: 0.8,
      blendMode: 'multiply',
      effects: [
        { type: 'dropShadow', color: rgba(0, 0, 0, 0.25), x: 0, y: 4, blur: 8, spread: 0 },
        { type: 'innerShadow', color: rgba(1, 1, 1), x: 0, y: 1, blur: 0, spread: 0 },
        { type: 'layerBlur', radius: 4 },
        { type: 'backgroundBlur', radius: 20, hidden: true },
      ],
    }) as RectNode;
    expect(cssText(nodeCss(rect, { width: 120, height: 40 }))).toBe(
      [
        'width: 120px;',
        'height: 40px;',
        'background: #3366ff;',
        'border: 2px dashed rgba(0, 0, 0, 0.5);',
        'border-radius: 8px;',
        'box-shadow: 0px 4px 8px 0px rgba(0, 0, 0, 0.25), inset 0px 1px 0px 0px #ffffff;',
        'filter: blur(2px);',
        'opacity: 0.8;',
        'mix-blend-mode: multiply;',
      ].join('\n'),
    );
  });

  it('四个角不一样的圆角、旋转', () => {
    const rect = createNode('rect', {
      ...base,
      transform: [0, 1, -1, 0, 0, 0],
      size: [100, 100],
      cornerRadius: 0,
      cornerRadii: [10, 0, 10, 0],
      fill: null,
      stroke: null,
    }) as RectNode;
    const css = nodeCss(rect, { width: 100, height: 100 });
    expect(css).toContainEqual({ property: 'border-radius', value: '10px 0px 10px 0px' });
    expect(css).toContainEqual({ property: 'transform', value: 'rotate(90deg)' });
  });

  it('自动布局的画框写成 flex；里面填满的子对象写成 flex: 1', () => {
    const frame = createNode('frame', {
      ...base,
      size: [300, 100],
      fill: null,
      stroke: null,
      cornerRadius: 0,
      clip: true,
      layout: {
        direction: 'vertical',
        gap: 12,
        padding: [16, 24, 16, 24],
        justify: 'center',
        align: 'end',
        sizing: { h: 'fixed', v: 'hug' },
      },
    }) as FrameNode;
    const css = cssText(nodeCss(frame, { width: 300, height: 100 }));
    expect(css).toContain('display: flex;');
    expect(css).toContain('flex-direction: column;');
    expect(css).toContain('justify-content: center;');
    expect(css).toContain('align-items: flex-end;');
    expect(css).toContain('gap: 12px;');
    expect(css).toContain('padding: 16px 24px;');
    expect(css).toContain('overflow: hidden;');
    const child = createNode('rect', {
      ...base,
      size: [10, 10],
      cornerRadius: 0,
      fill: null,
      stroke: null,
      layoutSizing: { h: 'fill', v: 'fill' },
    }) as RectNode;
    const childCss = nodeCss(child, { width: 10, height: 10, parentLayout: 'vertical' });
    expect(childCss).toContainEqual({ property: 'flex', value: '1 0 0' });
    expect(childCss).toContainEqual({ property: 'align-self', value: 'stretch' });
  });

  it('文字：字体、字号、字重、斜体、行高、字距、装饰线、对齐、颜色', () => {
    const text = createNode('text', {
      ...base,
      text: '你好',
      style: {
        fontFamily: { latin: 'Inter', cjk: 'Noto Sans SC' },
        fontSize: 18,
        fontWeight: 700,
        lineHeight: 1.5,
        letterSpacing: 0.5,
        italic: true,
        underline: true,
      },
      align: 'center',
      sizing: 'auto',
      fill: solid(rgba(0.1, 0.1, 0.1)),
    }) as TextNode;
    expect(cssText(nodeCss(text, { width: 40, height: 27 }))).toBe(
      [
        'width: 40px;',
        'height: 27px;',
        'font-family: "Inter", "Noto Sans SC";',
        'font-size: 18px;',
        'font-weight: 700;',
        'font-style: italic;',
        'line-height: 1.5;',
        'letter-spacing: 0.5px;',
        'text-decoration: underline;',
        'text-align: center;',
        'color: #1a1a1a;',
      ].join('\n'),
    );
  });
});

describe('导出设置', () => {
  it('文件名：没写后缀时倍率不是 1 的位图加 @2x；矢量不加；写了后缀用后缀', () => {
    expect(exportFileName('图标', { scale: 1, format: 'png' })).toBe('图标.png');
    expect(exportFileName('图标', { scale: 2, format: 'png' })).toBe('图标@2x.png');
    expect(exportFileName('图标', { scale: 3, format: 'jpeg' })).toBe('图标@3x.jpg');
    expect(exportFileName('图标', { scale: 2, format: 'svg' })).toBe('图标.svg');
    expect(exportFileName('图标', { scale: 2, format: 'png', suffix: '-large' })).toBe('图标-large.png');
  });

  it('文件校验', () => {
    expect(
      isExportList([
        { scale: 2, format: 'png' },
        { scale: 1, format: 'pdf', suffix: '' },
      ]),
    ).toBe(true);
    expect(isExportList([{ scale: 0, format: 'png' }])).toBe(false);
    expect(isExportList([{ scale: 9, format: 'png' }])).toBe(false);
    expect(isExportList([{ scale: 1, format: 'gif' }])).toBe(false);
    expect(isExportList([{ scale: 1, format: 'png', suffix: 'x'.repeat(65) }])).toBe(false);
  });
});
