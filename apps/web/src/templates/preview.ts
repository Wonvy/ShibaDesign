import type { CanvasKit } from 'canvaskit-wasm';
import { AssetStore, DocStore, artboards, slides, type Asset, type DocumentData, type NodeId } from '@shiba/core';
import { createEditor } from '@shiba/editor';
import type { Bitmap } from '@shiba/renderer';
import { DEFAULT_FONTS, registerFonts } from '../fonts';
import { currentTheme } from '../theme';

/** 文档的"封面"：第一页幻灯片，没有幻灯片时是第一张画板 */
export function coverOf(store: DocStore): NodeId | null {
  return slides(store)[0]?.id ?? artboards(store)[0]?.id ?? null;
}

/** 把位图编码成 PNG */
export async function bitmapToPng(bitmap: Bitmap): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.putImageData(new ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * 给一份没有打开的文档画封面的缩略图（模板的预览用）：临时建一个不挂载的编辑器，等字体加载完再画，画完就扔掉。
 * 字体文件浏览器已经缓存过，第二次很快
 */
export async function documentThumbnail(
  ck: CanvasKit,
  document: DocumentData,
  assets: readonly Asset[],
  maxSize: number,
): Promise<Blob | null> {
  const store = DocStore.fromJSON(document);
  const assetStore = new AssetStore();
  assetStore.replaceAll([...assets]);
  const editor = createEditor({
    ck,
    store,
    assets: assetStore,
    theme: currentTheme().canvas,
    defaultFonts: DEFAULT_FONTS,
  });
  try {
    registerFonts(editor.fonts);
    const cover = coverOf(store);
    if (!cover) return null;
    await editor.fontsReady(cover);
    const bitmap = editor.renderThumbnail(cover, maxSize, maxSize);
    return bitmap ? await bitmapToPng(bitmap) : null;
  } finally {
    editor.dispose();
  }
}
