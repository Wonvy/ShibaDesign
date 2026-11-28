import { Circle, Hand, MousePointer, MousePointer2, PenTool, Square, Type, type LucideIcon } from 'lucide-react';

/**
 * 顶栏上的工具按钮。
 * 新增工具：先在编辑器里注册工具（editor.tools.register），再在这里加一项。
 */
export interface ToolbarItem {
  /** 工具 id，与 editor.tools 里注册的一致 */
  tool: string;
  icon: LucideIcon;
  labelKey: string;
}

export const toolbarItems: ToolbarItem[] = [
  { tool: 'select', icon: MousePointer2, labelKey: 'tool.select' },
  { tool: 'direct', icon: MousePointer, labelKey: 'tool.direct' },
  { tool: 'hand', icon: Hand, labelKey: 'tool.hand' },
  { tool: 'rect', icon: Square, labelKey: 'tool.rect' },
  { tool: 'ellipse', icon: Circle, labelKey: 'tool.ellipse' },
  { tool: 'pen', icon: PenTool, labelKey: 'tool.pen' },
  { tool: 'text', icon: Type, labelKey: 'tool.text' },
];
