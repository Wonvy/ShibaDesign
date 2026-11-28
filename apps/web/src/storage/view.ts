import { DEFAULT_VIEW_OPTIONS, type Editor, type ViewOptions } from '@shiba/editor';

/**
 * 视图选项（标尺、辅助线、吸附……）记在浏览器里，下次打开还是这样。只和这台电脑、这个人有关，不进文档
 */
const KEY = 'shiba.view';

function load(): Partial<ViewOptions> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<ViewOptions> = {};
    for (const key of Object.keys(DEFAULT_VIEW_OPTIONS) as (keyof ViewOptions)[]) {
      if (typeof data[key] === 'boolean') out[key] = data[key] as boolean;
    }
    return out;
  } catch {
    return {};
  }
}

/** 恢复上次的视图选项，之后每次改了都存下来。返回取消订阅的函数 */
export function persistViewOptions(editor: Editor): () => void {
  editor.setView(load());
  let last = editor.view;
  return editor.subscribe(() => {
    const view = editor.view;
    if (view === last) return;
    last = view;
    try {
      localStorage.setItem(KEY, JSON.stringify(view));
    } catch {
      // 存不了（隐私模式等）就只在这次打开里有效
    }
  });
}
