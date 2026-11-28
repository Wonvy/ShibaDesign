import { Pin, PinOff } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImageFill, NodeId, SceneNode } from '@shiba/core';
import { AssetsPanel } from '../components/AssetsPanel';
import { InspectPanel } from '../components/InspectPanel';
import { Inspector } from '../components/Inspector';
import { LayersPanel } from '../components/LayersPanel';
import { SlideStrip } from '../components/SlideStrip';
import { useEditor, useEditorState, useSelectedNodes } from '../editor/context';
import { listPanels } from '../panels';
import { SlideNotes } from '../panels/AnimationPanel';
import { ImagePanel } from '../panels/ImagePanel';
import { registerDockPanel, registerDockPanelFactory } from './registry';

/** 注册内置的面板：幻灯片、图层、资源、属性、检查、备注、图片调整，以及属性栏里弹出来的各个分区 */
export function registerBuiltinDockPanels(): void {
  registerDockPanel({ id: 'slides', titleKey: 'panel.slides', component: SlideStrip, defaultPlace: { zone: 'left' } });
  registerDockPanel({ id: 'layers', titleKey: 'panel.layers', component: LayersPanel, defaultPlace: { zone: 'left' } });
  registerDockPanel({ id: 'assets', titleKey: 'panel.assets', component: AssetsPanel, defaultPlace: { zone: 'left' } });
  registerDockPanel({
    id: 'properties',
    titleKey: 'panel.properties',
    component: Inspector,
    defaultPlace: { zone: 'right' },
  });
  registerDockPanel({
    id: 'inspect',
    titleKey: 'panel.inspect',
    component: InspectPanel,
    defaultPlace: { zone: 'right' },
  });
  registerDockPanel({ id: 'notes', titleKey: 'panel.notes', component: NotesPanel, defaultPlace: { zone: 'bottom' } });
  registerDockPanel({
    id: 'image',
    titleKey: 'panel.image',
    component: ImageDockPanel,
    defaultPlace: 'float',
    floatSize: { w: 320, h: 560 },
  });
  registerDockPanelFactory('inspector:', (panelId) => {
    const def = listPanels().find((p) => p.id === panelId);
    if (!def) return null;
    return {
      id: `inspector:${panelId}`,
      titleKey: def.titleKey,
      component: () => <InspectorSection panelId={panelId} />,
      defaultPlace: 'float',
      floatSize: { w: 300, h: 380 },
    };
  });
}

/** 演讲者备注：当前这一页的备注，选中对象时也能写 */
function NotesPanel(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  useEditorState((s) => s.activeArtboardId);
  useEditorState((s) => s.docVersion);
  const slide = editor.activeArtboard;
  if (!slide?.deck) return <p className="empty-note dock-empty">{t('dock.notesEmpty')}</p>;
  return (
    <div className="dock-notes">
      <SlideNotes key={slide.id} editor={editor} slide={slide} />
    </div>
  );
}

function imageFillOf(node: SceneNode | undefined): ImageFill | null {
  return node && 'fill' in node && node.fill?.type === 'image' ? node.fill : null;
}

/**
 * 图片调整的浮动面板（像 Photoshop 的属性面板）：跟着选区走，选中的不是图片时显示提示，不自动关掉。
 * 图钉按下后固定在这张图片上，选别的东西也不变。按住"原图"时画布上这张图片暂时不带任何调整
 */
function ImageDockPanel(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const selected = useSelectedNodes();
  useEditorState((s) => s.docVersion);
  const [pinned, setPinned] = useState<NodeId | null>(null);
  const preview = useRef<string | null>(null);

  const pinnedNode = pinned ? editor.store.get(pinned) : undefined;
  const nodes = pinnedNode && imageFillOf(pinnedNode) ? [pinnedNode] : selected.filter((n) => imageFillOf(n));
  if (nodes.length === 0) {
    return <p className="empty-note dock-empty">{t('dock.imageEmpty')}</p>;
  }

  /** 按住"原图"：用一个合并键临时去掉调整，松开时整个放弃（不进撤销历史） */
  const showOriginal = (): void => {
    if (preview.current) return;
    const key = editor.newMergeKey('original');
    preview.current = key;
    editor.store.transact(
      'preview original',
      (tx) => {
        for (const node of nodes) {
          const fill = imageFillOf(tx.get(node.id));
          if (!fill) continue;
          const { adjust: _a, curves: _c, filter: _f, ...plain } = fill;
          tx.update(node.id, { fill: plain });
        }
      },
      { mergeKey: key },
    );
  };
  const hideOriginal = (): void => {
    const key = preview.current;
    preview.current = null;
    if (key) editor.store.abandon(key);
  };

  return (
    <div className="image-dock">
      <div className="image-dock-bar">
        <button
          type="button"
          className={`icon-btn${pinned ? ' is-active' : ''}`}
          title={t(pinned ? 'dock.unpin' : 'dock.pin')}
          aria-label={t(pinned ? 'dock.unpin' : 'dock.pin')}
          onClick={() => setPinned(pinned ? null : (nodes[0]?.id ?? null))}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          type="button"
          className="text-btn image-dock-original"
          onPointerDown={showOriginal}
          onPointerUp={hideOriginal}
          onPointerLeave={hideOriginal}
          onBlur={hideOriginal}
        >
          {t('dock.original')}
        </button>
      </div>
      <ImagePanel editor={editor} nodes={nodes} />
    </div>
  );
}

/** 属性栏里弹出来的一个分区：跟着选区走，对选区没意义时显示提示 */
function InspectorSection({ panelId }: { panelId: string }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const nodes = useSelectedNodes();
  useEditorState((s) => s.docVersion);
  const def = listPanels().find((p) => p.id === panelId);
  if (!def) return null;
  const props = { editor, nodes };
  if (nodes.length === 0 || !(def.when?.(props) ?? true)) {
    return <p className="empty-note dock-empty">{t('dock.sectionEmpty')}</p>;
  }
  const Component = def.component;
  return (
    <div className="inspector-section-dock">
      <Component {...props} />
    </div>
  );
}
