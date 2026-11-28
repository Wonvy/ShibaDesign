import { registerBuiltinCommands } from './commands';
import { Editor, type EditorOptions } from './editor';
import { registerBuiltinTools } from './tools';

/** 创建一个装好全部内置工具和命令的编辑器 */
export function createEditor(options: EditorOptions): Editor {
  const editor = new Editor(options);
  registerBuiltinTools(editor);
  registerBuiltinCommands(editor);
  return editor;
}

export { Editor } from './editor';
export type { EditorOptions, SelectionFrame } from './editor';
export * from './types';
export * from './registry';
export * from './keymap';
export * from './commands';
export * from './tools';
export * from './resize';
export { flowChildren, layoutFrame, layoutFrames, relayoutAll } from './auto-layout';
export * from './ops';
export * from './fill-handles';
export * from './motion-handles';
export * from './clipboard';
export * from './snap';
export { RULER_SIZE, rulerStep } from './guides';
export type { GuideHit } from './guides';
export * from './corner-handles';
export { scaleUniform, scaledParams } from './scale';
export { fitCurve } from './curve-fit';
