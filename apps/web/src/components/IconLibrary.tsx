import { DynamicIcon, dynamicIconImports, iconNames, type IconName } from 'lucide-react/dynamic';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Point } from '@shiba/core';
import type { Editor, IconNode } from '@shiba/editor';
import { useEditor } from '../editor/context';
import { ICON_DRAG_TYPE } from './AssetsPanel';

/** 一次最多列出多少个图标（全部有两千多个，搜索后再缩小范围） */
const MAX_SHOWN = 120;

/** 按名字取一个图标的数据，放到画布上（点图标放在中间，拖到画布上放在松手处） */
export async function insertIconByName(editor: Editor, name: string, at?: Point): Promise<void> {
  if (!(name in dynamicIconImports)) return;
  const module = (await dynamicIconImports[name as IconName]()) as { __iconData?: { node: IconNode } };
  const node = module.__iconData?.node;
  if (!node) return;
  editor.commands.run('icon.insert', { name, node, ...(at ? { at } : {}) });
}

/**
 * 资源面板里的图标库（lucide，ISC 许可，可以商用）：搜索框加一格一格的图标，点一下放到画布中间，
 * 拖到画布上放在松手的地方，放上去的是普通的钢笔路径。图标的数据用到时才加载
 */
export default function IconLibrary(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return iconNames.filter((name) => words.every((w) => name.includes(w)));
  }, [query]);
  const shown = matches.slice(0, MAX_SHOWN);

  return (
    <div className="icon-library">
      <input
        className="field-input icon-search"
        type="search"
        placeholder={t('icons.search')}
        aria-label={t('icons.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="icon-grid">
        {shown.map((name) => (
          <button
            key={name}
            type="button"
            className="icon-cell"
            title={name}
            aria-label={name}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(ICON_DRAG_TYPE, name);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => void insertIconByName(editor, name)}
          >
            <DynamicIcon name={name} size={18} />
          </button>
        ))}
      </div>
      {matches.length === 0 && <p className="empty-note">{t('icons.none')}</p>}
      {matches.length > MAX_SHOWN && (
        <p className="panel-hint">{t('icons.more', { shown: MAX_SHOWN, count: matches.length })}</p>
      )}
    </div>
  );
}
