import { applyPropertiesFrom } from '../commands/properties';
import type { Tool } from './tool';

/**
 * 吸管（I）：点一个对象，把它的外观（填充、描边、不透明度、混合模式、圆角、文字样式）套到选中的对象上；
 * 按住 Alt 点只取填充。没有选中的对象时什么都不做
 */
export function createEyedropperTool(): Tool {
  return {
    id: 'eyedropper',
    cursor: 'crosshair',

    onPointerDown(e, editor) {
      const source = editor.pickDeep(e.world);
      if (!source || editor.selection.length === 0 || editor.selection.includes(source.id)) return;
      applyPropertiesFrom(editor, source, e.alt);
    },
  };
}
