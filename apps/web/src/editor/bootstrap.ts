import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';
import { AssetStore, DocStore } from '@shiba/core';
import { createEditor, type Editor } from '@shiba/editor';
import { loadCanvasKit } from '@shiba/renderer';
import { createStarterDocument, trackChanges } from '../files';
import { DEFAULT_FONTS, registerFonts } from '../fonts';
import { i18n } from '../i18n';
import { displayName } from '../names';
import { enableDraftAutosave, loadDraft } from '../storage/draft';
import { currentTheme, subscribeTheme } from '../theme';

/** 加载渲染引擎、恢复上次的草稿，并创建编辑器 */
export async function createApp(): Promise<Editor> {
  const [ck, draft] = await Promise.all([loadCanvasKit(wasmUrl), loadDraft()]);
  const assets = new AssetStore();
  if (draft) assets.replaceAll(draft.assets);
  const store = DocStore.fromJSON(draft?.document ?? createStarterDocument());
  const editor = createEditor({ ck, store, assets, theme: currentTheme().canvas, defaultFonts: DEFAULT_FONTS });
  registerFonts(editor.fonts);

  // 内核不产生给人看的文字，节点的默认名由界面层按当前语言生成
  editor.labelOf = (node) => displayName(node, i18n.t.bind(i18n));
  i18n.on('languageChanged', () => editor.requestRender());
  subscribeTheme(() => editor.setTheme(currentTheme().canvas));
  enableDraftAutosave(store, assets);
  trackChanges(store);

  if (import.meta.env.DEV) (window as unknown as { shiba: Editor }).shiba = editor;
  return editor;
}
