import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, useEditorState, useSelectedNodes } from '../editor/context';
import { displayName } from '../names';
import { SlidePanel, listPanels } from '../panels';
import { Section } from '../ui/controls';

/** 右侧属性栏：按注册表依次渲染对当前选区有意义的面板 */
export function Inspector(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const nodes = useSelectedNodes();
  const viewMode = useEditorState((s) => s.viewMode);
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
        {nodes.length === 1 ? displayName(nodes[0]!, t) : t('inspector.multiple', { count: nodes.length })}
      </div>
      {listPanels()
        .filter((panel) => panel.when?.(props) ?? true)
        .map((panel) => (
          <Section key={panel.id} title={t(panel.titleKey)}>
            <panel.component {...props} />
          </Section>
        ))}
    </aside>
  );
}
