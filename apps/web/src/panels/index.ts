import { hasShapeStyle } from '@shiba/core';
import { slideLayerOf } from '@shiba/editor';
import { AnimationPanel } from './AnimationPanel';
import { AppearancePanel } from './AppearancePanel';
import { AlignPanel, BooleanPanel, MaskPanel, OrderPanel } from './ArrangePanels';
import { ComponentPanel, showComponentPanel } from './ComponentPanel';
import { FramePanel } from './FramePanel';
import { ImagePanel } from './ImagePanel';
import { PathPanel } from './PathPanel';
import { PolygonPanel } from './PolygonPanel';
import { TextPanel } from './TextPanel';
import { TransformPanel } from './TransformPanel';
import { registerPanel } from './registry';

/** 注册内置的属性面板。顺序由 order 决定 */
export function registerBuiltinPanels(): void {
  registerPanel({
    id: 'component',
    titleKey: 'panel.component',
    order: 5,
    when: ({ editor, nodes }) => showComponentPanel(editor, nodes),
    component: ComponentPanel,
  });
  registerPanel({ id: 'align', titleKey: 'panel.align', order: 10, component: AlignPanel });
  registerPanel({
    id: 'order',
    titleKey: 'panel.order',
    order: 20,
    when: ({ nodes }) => nodes.some((n) => n.type !== 'artboard'),
    component: OrderPanel,
  });
  registerPanel({
    id: 'boolean',
    titleKey: 'panel.boolean',
    order: 30,
    when: ({ nodes }) => nodes.some((n) => n.type === 'boolean') || nodes.filter(hasShapeStyle).length >= 2,
    component: BooleanPanel,
  });
  registerPanel({
    id: 'path',
    titleKey: 'panel.path',
    order: 33,
    when: ({ nodes }) => nodes.some((n) => n.type === 'text' || hasShapeStyle(n)),
    component: PathPanel,
  });
  registerPanel({
    id: 'mask',
    titleKey: 'panel.mask',
    order: 35,
    when: ({ nodes }) =>
      nodes.filter((n) => n.type !== 'artboard').length >= 2 ||
      (nodes.length === 1 && nodes[0]!.type === 'group' && !!nodes[0]!.mask),
    component: MaskPanel,
  });
  registerPanel({ id: 'transform', titleKey: 'panel.transform', order: 40, component: TransformPanel });
  registerPanel({
    id: 'frame',
    titleKey: 'panel.frame',
    order: 41,
    when: ({ nodes }) => nodes.every((n) => n.type === 'frame'),
    component: FramePanel,
  });
  registerPanel({
    id: 'polygon',
    titleKey: 'panel.polygon',
    order: 42,
    when: ({ nodes }) => nodes.every((n) => n.type === 'polygon'),
    component: PolygonPanel,
  });
  registerPanel({
    id: 'text',
    titleKey: 'panel.text',
    order: 45,
    when: ({ nodes }) => nodes.some((n) => n.type === 'text'),
    component: TextPanel,
  });
  registerPanel({ id: 'appearance', titleKey: 'panel.appearance', order: 50, component: AppearancePanel });
  registerPanel({
    id: 'image',
    titleKey: 'panel.image',
    order: 60,
    when: ({ nodes }) => nodes.some((n) => 'fill' in n && n.fill?.type === 'image'),
    component: ImagePanel,
  });
  registerPanel({
    id: 'animation',
    titleKey: 'panel.animation',
    order: 70,
    when: ({ editor, nodes }) => nodes.some((n) => slideLayerOf(editor.store, n.id) !== null),
    component: AnimationPanel,
  });
}

export { SlidePanel } from './AnimationPanel';
export { listPanels, registerPanel } from './registry';
export type { PanelDef, PanelProps } from './registry';
