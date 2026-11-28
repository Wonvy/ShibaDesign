import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AssetsPanel } from './AssetsPanel';
import { LayersPanel } from './LayersPanel';

type Tab = 'layers' | 'assets';

const TAB_KEY = 'shiba.sidebarTab';

function savedTab(): Tab {
  try {
    return localStorage.getItem(TAB_KEY) === 'assets' ? 'assets' : 'layers';
  } catch {
    return 'layers';
  }
}

/** 左栏下半部分：图层和资源（组件、颜色样式、文字样式）两页，记住上次看的是哪一页 */
export function Sidebar(): ReactNode {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(savedTab);
  const choose = (next: Tab): void => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // 存不了（隐私模式等）就只在这次打开里记着
    }
  };

  return (
    <div className="panel layers">
      <div className="panel-tabs" role="tablist">
        {(['layers', 'assets'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'is-active' : ''}
            onClick={() => choose(id)}
          >
            {t(`panel.${id}`)}
          </button>
        ))}
      </div>
      {tab === 'layers' ? <LayersPanel /> : <AssetsPanel />}
    </div>
  );
}
