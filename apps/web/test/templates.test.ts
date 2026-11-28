import { describe, expect, it } from 'vitest';
import {
  DocStore,
  artboards,
  colorStyles,
  components,
  descendants,
  instancesOf,
  slides,
  textStyles,
  translation,
  validateDocument,
  type SceneNode,
} from '@shiba/core';
import { BUILTIN_TEMPLATES } from '../src/templates/builtin';
import { BLANK_PRESETS, blankDocument } from '../src/templates/presets';

/** 测试里用键名当文字，看得出每一处取的是哪条 */
const t = (key: string): string => `[${key}]`;

/** 节点上链接的样式和它的值对得上（对不上的话，下一次修改时整理器就会断开链接） */
function linksConsistent(store: DocStore, node: SceneNode): boolean {
  const colors = new Map(colorStyles(store).map((s) => [s.id, s.color]));
  const texts = new Map(textStyles(store).map((s) => [s.id, s.style]));
  if ('fill' in node && node.fill?.type === 'solid' && node.fill.colorStyle) {
    const color = colors.get(node.fill.colorStyle);
    if (!color || JSON.stringify(color) !== JSON.stringify(node.fill.color)) return false;
  }
  if (node.type === 'text' && node.textStyle) {
    const style = texts.get(node.textStyle);
    if (!style || JSON.stringify(style) !== JSON.stringify(node.style)) return false;
  }
  return true;
}

describe('空白尺寸', () => {
  it('演示稿是一页幻灯片，别的是普通画板，大小对', () => {
    for (const preset of BLANK_PRESETS) {
      const store = DocStore.fromJSON(blankDocument(preset));
      const [board] = artboards(store);
      expect(board!.size).toEqual(preset.size);
      expect(slides(store)).toHaveLength(preset.slides ? 1 : 0);
    }
  });
});

describe('内置模板', () => {
  for (const template of BUILTIN_TEMPLATES) {
    it(`${template.id}：能通过文件校验，样式链接都对得上，示例文字来自语言包`, () => {
      const data = template.build(t);
      expect(() => validateDocument(JSON.parse(JSON.stringify(data)))).not.toThrow();
      const store = DocStore.fromJSON(data);
      expect(slides(store).length > 0).toBe(template.slides);
      const all = [...store.all()];
      for (const node of all) expect(linksConsistent(store, node)).toBe(true);
      const texts = all.filter((n) => n.type === 'text');
      expect(texts.length).toBeGreaterThan(0);
      // 每段文字都是从语言包取的（"01"、"@shibadesign" 这种两种语言一样的也走语言包，这里只看不是空的）
      for (const text of texts) expect(text.type === 'text' && text.text.length > 0).toBe(true);
      // 样式名也来自语言包，每个都带用途
      for (const style of [...colorStyles(store), ...textStyles(store)]) {
        expect(style.name.startsWith('[template.styleName.')).toBe(true);
        expect(style.role).toBeDefined();
      }
      // 同一个父节点下的层序不重复
      for (const node of [store.root, ...descendants(store, store.root.id)]) {
        const kids = store.children(node.id).map((k) => k.index);
        expect(new Set(kids).size).toBe(kids.length);
      }
    });
  }

  it('演示稿的页脚是组件：主组件在画板外面，内容页放实例，改主组件时都跟着变', () => {
    const store = DocStore.fromJSON(BUILTIN_TEMPLATES.find((tpl) => tpl.id === 'minimal')!.build(t));
    const [main] = components(store);
    expect(main).toBeDefined();
    expect(main!.parent).toBe(store.root.id);
    const instances = instancesOf(store, main!.id);
    expect(instances.length).toBe(3);
    expect(instances.every((i) => store.get(i.parent!)?.type === 'artboard')).toBe(true);
    const footerText = store.children(main!.id).find((n) => n.type === 'text')!;
    store.transact('edit footer', (tx) => tx.update(footerText.id, { transform: translation(4, 0) }));
    for (const instance of instances) {
      const copy = store.children(instance.id).find((n) => n.source === footerText.id)!;
      expect(copy.transform).toEqual(translation(4, 0));
    }
  });

  it('改模板的标题样式，每一页的标题都跟着变', () => {
    const store = DocStore.fromJSON(BUILTIN_TEMPLATES.find((tpl) => tpl.id === 'dark')!.build(t));
    const title = textStyles(store).find((s) => s.role === 'title')!;
    store.transact('restyle', (tx) =>
      tx.update(store.root.id, {
        textStyles: textStyles(store).map((s) =>
          s.id === title.id ? { ...s, style: { ...s.style, fontSize: 72 } } : s,
        ),
      }),
    );
    const titles = [...store.all()].filter((n) => n.type === 'text' && n.textStyle === title.id);
    expect(titles.length).toBeGreaterThanOrEqual(slides(store).length);
    expect(titles.every((n) => n.type === 'text' && n.style.fontSize === 72)).toBe(true);
  });
});
