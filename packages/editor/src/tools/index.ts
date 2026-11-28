import type { Editor } from '../editor';
import { createDirectSelectTool } from './direct-select';
import { createHandTool } from './hand';
import { createMotionPathTool } from './motion-path';
import { createPenTool } from './pen';
import { createSelectTool } from './select';
import { createShapeTool } from './shape';
import { registerTextTool } from './text';

/** 注册所有内置工具 */
export function registerBuiltinTools(editor: Editor): void {
  editor.tools
    .register(createSelectTool())
    .register(createDirectSelectTool())
    .register(createHandTool())
    .register(createShapeTool('rect'))
    .register(createShapeTool('ellipse'))
    .register(createPenTool())
    .register(createMotionPathTool());
  registerTextTool(editor);
}

export type { Tool } from './tool';
export type { TextToggle } from './text';
export { dragRect } from './shape';
export { steppedFontSize } from './text';
