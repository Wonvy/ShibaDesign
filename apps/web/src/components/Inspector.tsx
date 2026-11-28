import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, useEditorState, useSelectedNodes } from '../editor/context';
import { displayName } from '../names';
import { SlidePanel, listPanels } from '../panels';
import { findTab } from '../dock/layout';
import { focusPanel, showPanel, useDockLayout } from '../dock/store';
import { Section } from '../ui/controls';
import { FramePresets } from './FramePresets';

/** 右侧属性栏：按注册表依次渲染对当前选区有意义的面板 */
export function Inspector(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const nodes = useSelectedNodes();
  const viewMode = useEditorState((s) => s.viewMode);
  const tool = useEditorState((s) => s.tool);
  const layout = useDockLayout();
  // 订阅这两项是为了在切换幻灯片、修改动画后重新渲染
  useEditorState((s) => s.activeArtboardId);
  useEditorState((s) => s.docVersion);
  const slide = editor.activeArtboard;

  if (nodes.length === 0 && viewMode === 'slides' && slide?.deck) {
    return (
      <aside className="inspector">
        <SlidePanel editor={editor} slide={slide} />
      </aside>
    );
  }

  if (nodes.length === 0 && tool === 'frame') {
    return (
      <aside className="inspector">
        <FramePresets />
      </aside>
    );
  }

  if (nodes.length === 0) {
    return (
      <aside className="inspector">
        <div className="empty">
          <strong>{t('inspector.empty')}</strong>
          <p>{t('inspector.emptyHint')}</p>
        </div>
      </aside>
    );
  }

  const props = { editor, nodes };
  return (
    <aside className="inspector">
      <div className="inspector-header">
        {nodes.length === 1
          ? displayName(nodes[0]!, t, editor.store)
          : t('inspector.multiple', { count: nodes.length })}
      </div>
      {listPanels()
        .filter((panel) => panel.when?.(props) ?? true)
        .map((panel) =>
          findTab(layout, dockIdOf(panel.id)) ? (
            // 这一节弹出成了浮动面板：这里只留一行，点它把面板找回来
            <button
              key={panel.id}
              type="button"
              className="section section-floated"
              onClick={() => focusPanel(dockIdOf(panel.id))}
            >
              {t('dock.inFloating', { name: t(panel.titleKey) })}
            </button>
          ) : (
            <Section
              key={panel.id}
              id={panel.id}
              title={t(panel.titleKey)}
              actions={
                <button
                  type="button"
                  className="section-popout"
                  title={t('dock.popOut')}
                  aria-label={`${t('dock.popOut')}: ${t(panel.titleKey)}`}
                  onClick={() => showPanel(dockIdOf(panel.id))}
                >
                  <ExternalLink size={12} />
                </button>
              }
            >
              <panel.component {...props} />
            </Section>
          ),
        )}
    </aside>
  );
}

/** 属性栏的一节弹出来以后是哪个面板：图片调整有专门的浮动面板（带图钉和看原图），别的是"inspector:分区 id" */
function dockIdOf(panelId: string): string {
  return panelId === 'image' ? 'image' : `inspector:${panelId}`;
}
