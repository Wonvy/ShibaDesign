import {
  hasBoxCorners,
  type BlendMode,
  type Effect,
  type Fill,
  type NodePatch,
  type RectNode,
  type SceneNode,
  type Stroke,
  type TextAlign,
  type TextStyle,
} from '@shiba/core';
import type { Editor } from '../editor';
import type { Command } from './command';

/**
 * 复制属性、粘贴属性（⌥⌘C / ⌥⌘V）：把一个对象的外观套到别的对象上。
 * 只记在编辑器里，不写进系统剪贴板，免得冲掉用户刚复制的东西
 */
interface PropertySet {
  opacity: number;
  blendMode: BlendMode;
  /** 省略表示来源没有这一项（比如编组没有填充） */
  fill?: Fill | null;
  stroke?: Stroke | null;
  cornerRadius?: number;
  corners?: Pick<RectNode, 'cornerRadii' | 'cornerStyle' | 'cornerSmoothing'>;
  text?: { style: TextStyle; align: TextAlign; textStyle?: string };
  /** 投影、模糊；来源是画板时省略 */
  effects?: readonly Effect[] | undefined;
  hasEffects?: boolean;
}

const copied = new WeakMap<Editor, PropertySet>();

function propertiesOf(node: SceneNode): PropertySet {
  const props: PropertySet = { opacity: node.opacity, blendMode: node.blendMode };
  if ('fill' in node) props.fill = node.fill;
  if ('stroke' in node) props.stroke = node.stroke;
  if (hasBoxCorners(node)) {
    props.cornerRadius = node.cornerRadius;
    props.corners = {
      cornerRadii: node.cornerRadii,
      cornerStyle: node.cornerStyle,
      cornerSmoothing: node.cornerSmoothing,
    };
  }
  if (node.type === 'text') props.text = { style: node.style, align: node.align, textStyle: node.textStyle };
  if (node.type !== 'artboard') {
    props.hasEffects = true;
    props.effects = node.effects;
  }
  return props;
}

/** 把复制来的属性换成对某个节点有意义的修改；文本只收纯色，画板不收图片 */
function patchFor(node: SceneNode, props: PropertySet): NodePatch | null {
  const patch: Record<string, unknown> = {};
  if (node.type !== 'artboard') {
    patch.opacity = props.opacity;
    patch.blendMode = props.blendMode;
    // 来源没有效果时把目标的效果也去掉（和填充、描边一样整套换过去）
    if (props.hasEffects) patch.effects = props.effects;
  }
  if ('fill' in node && props.fill !== undefined) {
    const fill = props.fill;
    const accepts =
      node.type === 'text'
        ? fill === null || fill.type === 'solid'
        : node.type === 'artboard'
          ? fill === null || fill.type !== 'image'
          : true;
    if (accepts) patch.fill = fill;
  }
  if ('stroke' in node && props.stroke !== undefined) patch.stroke = props.stroke;
  if (hasBoxCorners(node) && props.cornerRadius !== undefined) {
    patch.cornerRadius = props.cornerRadius;
    Object.assign(patch, props.corners);
  }
  if (node.type === 'text' && props.text) {
    patch.style = props.text.style;
    patch.align = props.text.align;
    patch.textStyle = props.text.textStyle;
  }
  return Object.keys(patch).length > 0 ? (patch as NodePatch) : null;
}

export const copyProperties: Command = {
  id: 'edit.copyProperties',
  enabled: (editor) => editor.selection.length === 1,
  run(editor) {
    const node = editor.selectedNodes()[0];
    if (node) copied.set(editor, propertiesOf(node));
  },
};

export const pasteProperties: Command = {
  id: 'edit.pasteProperties',
  enabled: (editor) => copied.has(editor) && editor.selection.length > 0,
  run(editor) {
    const props = copied.get(editor);
    if (!props) return;
    editor.updateSelection('paste properties', (node) => patchFor(node, props));
    editor.store.sealHistory();
  },
};

/** 有没有复制过属性（界面上决定"粘贴属性"能不能点） */
export function hasCopiedProperties(editor: Editor): boolean {
  return copied.has(editor);
}

/** 吸管用：把 source 的外观套到选中的对象上；fillOnly 只套填充（Alt 点） */
export function applyPropertiesFrom(editor: Editor, source: SceneNode, fillOnly: boolean): void {
  const props = propertiesOf(source);
  editor.updateSelection('eyedropper', (node) => {
    const patch = patchFor(node, props);
    if (!patch || !fillOnly) return patch;
    return 'fill' in patch ? ({ fill: (patch as { fill: unknown }).fill } as NodePatch) : null;
  });
  editor.store.sealHistory();
}
