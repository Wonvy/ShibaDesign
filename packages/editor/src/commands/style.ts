import {
  MAX_STYLE_NAME,
  MAX_STYLES,
  applyTextStyle,
  cleanTextStyle,
  colorStyles,
  findColorStyle,
  findTextStyle,
  hasShapeStyle,
  newStyleId,
  setBaseStyle,
  textStyles,
  type Color,
  type ColorStyleDef,
  type NodePatch,
  type SceneNode,
  type TextNode,
  type TextStyle,
  type TextStyleDef,
  type Transaction,
} from '@shiba/core';
import type { Editor } from '../editor';
import type { Command } from './command';

/**
 * 颜色样式和文字样式的命令。样式存在根页面上，改样式时链接它的对象由 core 的整理器一起改（见 styles.ts），
 * 所以这里只管改样式列表和链接本身。样式的名字由界面起（内核不产生给人看的文字）。
 */

export type ColorTarget = 'fill' | 'stroke';

function writeColorStyles(tx: Transaction, editor: Editor, next: readonly ColorStyleDef[]): void {
  tx.update(editor.store.root.id, { colorStyles: next.length > 0 ? next : undefined });
}

function writeTextStyles(tx: Transaction, editor: Editor, next: readonly TextStyleDef[]): void {
  tx.update(editor.store.root.id, { textStyles: next.length > 0 ? next : undefined });
}

const tidyName = (name: string): string => name.trim().slice(0, MAX_STYLE_NAME);

/** 能套颜色样式的填充：形状、画板背景、文本（整段的颜色） */
function canFill(node: SceneNode): boolean {
  return 'fill' in node;
}

/** 给一个节点的填充或描边套上颜色样式 */
function linkColor(node: SceneNode, target: ColorTarget, style: ColorStyleDef): NodePatch | null {
  if (target === 'stroke') {
    if (!hasShapeStyle(node)) return null;
    return { stroke: { ...(node.stroke ?? { width: 1 }), color: style.color, colorStyle: style.id } };
  }
  if (!canFill(node)) return null;
  if (node.type === 'text') {
    // 整段换色，单独设过颜色的字也跟着换，和改整段颜色一样
    const patch = setBaseStyle(node, { color: style.color });
    return { ...patch, fill: { type: 'solid', color: style.color, colorStyle: style.id } };
  }
  return { fill: { type: 'solid', color: style.color, colorStyle: style.id } } as NodePatch;
}

/** 选区里第一个能取到颜色的对象的颜色，新建颜色样式时用 */
export function selectionColor(editor: Editor, target: ColorTarget): Color | null {
  for (const node of editor.selectedNodes()) {
    if (target === 'stroke' && hasShapeStyle(node) && node.stroke) return node.stroke.color;
    if (target === 'fill' && 'fill' in node && node.fill?.type === 'solid') return node.fill.color;
  }
  return null;
}

export interface AddColorStyleArgs {
  /** 不给时自动生成 */
  id?: string;
  name: string;
  color: Color;
  /** 同时把选中对象的填充或描边链接到新样式 */
  link?: ColorTarget;
}

export const addColorStyle: Command<AddColorStyleArgs> = {
  id: 'style.color.add',
  enabled: (editor) => colorStyles(editor.store).length < MAX_STYLES,
  run(editor, { id, name, color, link }) {
    const style: ColorStyleDef = { id: id ?? newStyleId(), name: tidyName(name), color };
    editor.store.transact('add color style', (tx) => {
      writeColorStyles(tx, editor, [...colorStyles(editor.store), style]);
      if (!link) return;
      for (const node of editor.selectedNodes()) {
        const patch = linkColor(node, link, style);
        if (patch) tx.update(node.id, patch);
      }
    });
    editor.store.sealHistory();
  },
};

export interface UpdateColorStyleArgs {
  id: string;
  name?: string;
  color?: Color;
  /** 拖取色器时传同一个键，整个拖动合并成一步撤销；结束后调用方自己 sealHistory */
  mergeKey?: string;
}

export const updateColorStyle: Command<UpdateColorStyleArgs> = {
  id: 'style.color.update',
  enabled: (editor, args) => findColorStyle(editor.store, args?.id) !== null,
  run(editor, { id, name, color, mergeKey }) {
    const next = colorStyles(editor.store).map((s) =>
      s.id === id ? { ...s, ...(name !== undefined && { name: tidyName(name) }), ...(color && { color }) } : s,
    );
    editor.store.transact('color style', (tx) => writeColorStyles(tx, editor, next), { mergeKey });
    if (!mergeKey) editor.store.sealHistory();
  },
};

/** 删掉颜色样式：链接它的对象断开链接，颜色留着 */
export const removeColorStyle: Command<{ id: string }> = {
  id: 'style.color.remove',
  enabled: (editor, args) => findColorStyle(editor.store, args?.id) !== null,
  run(editor, { id }) {
    const next = colorStyles(editor.store).filter((s) => s.id !== id);
    editor.store.transact('remove color style', (tx) => writeColorStyles(tx, editor, next));
    editor.store.sealHistory();
  },
};

/** 把选中对象的填充或描边链接到一个颜色样式 */
export const applyColorStyle: Command<{ id: string; target: ColorTarget }> = {
  id: 'style.color.apply',
  enabled: (editor, args) => findColorStyle(editor.store, args?.id) !== null && editor.selection.length > 0,
  run(editor, { id, target }) {
    const style = findColorStyle(editor.store, id);
    if (!style) return;
    editor.updateSelection('apply color style', (node) => linkColor(node, target, style));
    editor.store.sealHistory();
  },
};

/** 断开选中对象的填充或描边和颜色样式的链接，颜色不变 */
export const detachColorStyle: Command<{ target: ColorTarget }> = {
  id: 'style.color.detach',
  run(editor, { target }) {
    editor.updateSelection('detach color style', (node) => {
      if (target === 'stroke' && hasShapeStyle(node) && node.stroke?.colorStyle) {
        const { colorStyle: _drop, ...stroke } = node.stroke;
        return { stroke };
      }
      if (target === 'fill' && 'fill' in node && node.fill?.type === 'solid' && node.fill.colorStyle) {
        const { colorStyle: _drop, ...fill } = node.fill;
        return { fill } as NodePatch;
      }
      return null;
    });
    editor.store.sealHistory();
  },
};

/** 选中的文本 */
function selectedTexts(editor: Editor): TextNode[] {
  return editor.selectedNodes().filter((n): n is TextNode => n.type === 'text');
}

export interface AddTextStyleArgs {
  id?: string;
  name: string;
  /** 不给时取选中的第一段文本的样式 */
  style?: TextStyle;
  /** 同时把选中的文本链接到新样式 */
  link?: boolean;
}

export const addTextStyle: Command<AddTextStyleArgs> = {
  id: 'style.text.add',
  enabled: (editor, args) =>
    textStyles(editor.store).length < MAX_STYLES && (!!args?.style || selectedTexts(editor).length > 0),
  run(editor, { id, name, style, link }) {
    const source = style ?? selectedTexts(editor)[0]?.style ?? editor.defaultTextStyle;
    const def: TextStyleDef = { id: id ?? newStyleId(), name: tidyName(name), style: cleanTextStyle(source) };
    editor.store.transact('add text style', (tx) => {
      writeTextStyles(tx, editor, [...textStyles(editor.store), def]);
      if (link) for (const node of selectedTexts(editor)) tx.update(node.id, applyTextStyle(node, def));
    });
    editor.store.sealHistory();
  },
};

export interface UpdateTextStyleArgs {
  id: string;
  name?: string;
  style?: TextStyle;
}

export const updateTextStyle: Command<UpdateTextStyleArgs> = {
  id: 'style.text.update',
  enabled: (editor, args) => findTextStyle(editor.store, args?.id) !== null,
  run(editor, { id, name, style }) {
    const next = textStyles(editor.store).map((s) =>
      s.id === id
        ? { ...s, ...(name !== undefined && { name: tidyName(name) }), ...(style && { style: cleanTextStyle(style) }) }
        : s,
    );
    editor.store.transact('text style', (tx) => writeTextStyles(tx, editor, next));
    editor.store.sealHistory();
  },
};

/** 用选中的第一段文本现在的样子重新定义文字样式，所有链接它的文本跟着变，选中的文本也链接上 */
export const redefineTextStyle: Command<{ id: string }> = {
  id: 'style.text.redefine',
  enabled: (editor, args) => findTextStyle(editor.store, args?.id) !== null && selectedTexts(editor).length > 0,
  run(editor, { id }) {
    const texts = selectedTexts(editor);
    const source = texts[0];
    const current = findTextStyle(editor.store, id);
    if (!source || !current) return;
    const def: TextStyleDef = { ...current, style: cleanTextStyle(source.style) };
    editor.store.transact('redefine text style', (tx) => {
      writeTextStyles(
        tx,
        editor,
        textStyles(editor.store).map((s) => (s.id === id ? def : s)),
      );
      for (const node of texts) {
        const latest = tx.get(node.id);
        if (latest?.type === 'text') tx.update(node.id, applyTextStyle(latest, def));
      }
    });
    editor.store.sealHistory();
  },
};

export const removeTextStyle: Command<{ id: string }> = {
  id: 'style.text.remove',
  enabled: (editor, args) => findTextStyle(editor.store, args?.id) !== null,
  run(editor, { id }) {
    const next = textStyles(editor.store).filter((s) => s.id !== id);
    editor.store.transact('remove text style', (tx) => writeTextStyles(tx, editor, next));
    editor.store.sealHistory();
  },
};

/** 给选中的文本套用文字样式（整个文本） */
export const applyTextStyleCommand: Command<{ id: string }> = {
  id: 'style.text.apply',
  enabled: (editor, args) => findTextStyle(editor.store, args?.id) !== null && selectedTexts(editor).length > 0,
  run(editor, { id }) {
    const def = findTextStyle(editor.store, id);
    if (!def) return;
    editor.updateSelection('apply text style', (node) => (node.type === 'text' ? applyTextStyle(node, def) : null));
    editor.store.sealHistory();
  },
};

/** 断开选中文本和文字样式的链接，样子不变 */
export const detachTextStyle: Command = {
  id: 'style.text.detach',
  enabled: (editor) => selectedTexts(editor).some((n) => n.textStyle !== undefined),
  run(editor) {
    editor.store.transact('detach text style', (tx) => {
      for (const node of selectedTexts(editor)) {
        if (node.textStyle === undefined) continue;
        const { textStyle: _drop, ...rest } = node;
        tx.replace(rest as TextNode);
      }
    });
    editor.store.sealHistory();
  },
};
