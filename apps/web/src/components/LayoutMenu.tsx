import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LAYOUT_SLOTS, slideLayouts, type LayoutTexts } from '@shiba/core';
import { useEditor } from '../editor/context';
import { Menu } from '../ui/Menu';

/** 每个版式的示意图：48 × 27 的框里几块条、块。没有示意图的版式（扩展的）画一个空框 */
const SKETCHES: Record<string, [number, number, number, number, 'line' | 'block' | 'accent'][]> = {
  blank: [],
  title: [
    [10, 10, 28, 4, 'block'],
    [16, 17, 16, 2, 'line'],
  ],
  titleContent: [
    [5, 4, 22, 3, 'block'],
    [5, 11, 30, 1.5, 'line'],
    [5, 15, 26, 1.5, 'line'],
    [5, 19, 28, 1.5, 'line'],
  ],
  twoColumns: [
    [5, 4, 22, 3, 'block'],
    [5, 11, 17, 1.5, 'line'],
    [5, 15, 15, 1.5, 'line'],
    [26, 11, 17, 1.5, 'line'],
    [26, 15, 14, 1.5, 'line'],
  ],
  imageText: [
    [0, 0, 22, 27, 'line'],
    [26, 7, 17, 3, 'block'],
    [26, 13, 16, 1.5, 'line'],
    [26, 17, 13, 1.5, 'line'],
  ],
  section: [
    [5, 8, 6, 1.5, 'accent'],
    [5, 12, 8, 2, 'accent'],
    [5, 16, 26, 4, 'block'],
  ],
  titleOnly: [[5, 4, 26, 3, 'block']],
  quote: [
    [8, 8, 32, 3, 'block'],
    [12, 13, 24, 3, 'block'],
    [18, 19, 12, 1.5, 'line'],
  ],
};

function LayoutSketch({ id }: { id: string }): ReactNode {
  return (
    <svg className="layout-sketch" viewBox="0 0 48 27" aria-hidden="true">
      <rect x="0.5" y="0.5" width="47" height="26" rx="2" className="layout-sketch-frame" />
      {(SKETCHES[id] ?? []).map(([x, y, w, h, kind], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={Math.min(1, h / 2)} className={`layout-sketch-${kind}`} />
      ))}
    </svg>
  );
}

/**
 * 新建幻灯片：选一个版式（标题页、标题和正文、两栏……）。新的一页沿用当前页的大小和背景，
 * 占位文字用当前的语言，文档里有带用途的样式（模板里定好的）时用它们
 */
export function LayoutMenu(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const texts = (): LayoutTexts =>
    Object.fromEntries(LAYOUT_SLOTS.map((slot) => [slot, t(`layoutText.${slot}`)])) as LayoutTexts;

  return (
    // 左栏会裁掉超出它的部分，所以菜单往下展开、宽度不超过左栏
    <Menu label={t('slide.add')} trigger={<Plus size={15} />} align="right" popoverClassName="layout-popover">
      {(close) => (
        <div className="layout-menu" role="group" aria-label={t('layout.heading')}>
          <p className="menu-hint">{t('layout.heading')}</p>
          <div className="layout-grid">
            {slideLayouts().map((layout) => (
              <button
                key={layout.id}
                type="button"
                className="layout-option"
                role="menuitem"
                onClick={() => {
                  close();
                  editor.commands.run('artboard.add', { layout: layout.id, texts: texts() });
                }}
              >
                <LayoutSketch id={layout.id} />
                <span>{t(`layout.${layout.id}`, { defaultValue: layout.id })}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Menu>
  );
}
