import {
  ArrowUpRight,
  Circle,
  Hand,
  Hash,
  Minus,
  MousePointer,
  MousePointer2,
  Pencil,
  PenTool,
  Pipette,
  Scaling,
  Square,
  Star,
  Triangle,
  Type,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';

/**
 * 顶栏上的工具按钮。相近的工具编成一组，按钮显示这一组上次用的那个，右下角的小三角（或者右键）展开整组。
 * 新增工具：先在编辑器里注册工具（editor.tools.register），再在这里加一项
 */
export interface ToolbarItem {
  /** 工具 id，与 editor.tools 里注册的一致 */
  tool: string;
  icon: LucideIcon;
  labelKey: string;
}

export interface ToolbarGroup {
  id: string;
  tools: ToolbarItem[];
}

export const toolbarGroups: ToolbarGroup[] = [
  {
    id: 'select',
    tools: [
      { tool: 'select', icon: MousePointer2, labelKey: 'tool.select' },
      { tool: 'direct', icon: MousePointer, labelKey: 'tool.direct' },
      { tool: 'scale', icon: Scaling, labelKey: 'tool.scale' },
    ],
  },
  { id: 'frame', tools: [{ tool: 'frame', icon: Hash, labelKey: 'tool.frame' }] },
  {
    id: 'shapes',
    tools: [
      { tool: 'rect', icon: Square, labelKey: 'tool.rect' },
      { tool: 'ellipse', icon: Circle, labelKey: 'tool.ellipse' },
      { tool: 'line', icon: Minus, labelKey: 'tool.line' },
      { tool: 'arrow', icon: ArrowUpRight, labelKey: 'tool.arrow' },
      { tool: 'polygon', icon: Triangle, labelKey: 'tool.polygon' },
      { tool: 'star', icon: Star, labelKey: 'tool.star' },
    ],
  },
  {
    id: 'pen',
    tools: [
      { tool: 'pen', icon: PenTool, labelKey: 'tool.pen' },
      { tool: 'pencil', icon: Pencil, labelKey: 'tool.pencil' },
    ],
  },
  { id: 'text', tools: [{ tool: 'text', icon: Type, labelKey: 'tool.text' }] },
  { id: 'eyedropper', tools: [{ tool: 'eyedropper', icon: Pipette, labelKey: 'tool.eyedropper' }] },
  {
    id: 'navigate',
    tools: [
      { tool: 'hand', icon: Hand, labelKey: 'tool.hand' },
      { tool: 'zoom', icon: ZoomIn, labelKey: 'tool.zoom' },
    ],
  },
];

/** 平铺的全部工具（命令面板、快捷键表用） */
export const toolbarItems: ToolbarItem[] = toolbarGroups.flatMap((g) => g.tools);
