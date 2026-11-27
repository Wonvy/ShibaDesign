import { useSyncExternalStore } from 'react';
import { DocStore, createNode, referencedAssetIds, rgba, solid, type DocumentData, type Point } from '@shiba/core';
import type { Editor } from '@shiba/editor';
import { SHIBA_EXTENSION, SHIBA_MIME, ShibaFileError, packShiba, unpackShiba } from '@shiba/io';
import { i18n } from './i18n';
import { displayName } from './names';
import { toast } from './ui/toast';

/**
 * 文件操作：新建、打开、保存 .shiba 文件，导出 PNG，导入图片。
 *
 * 浏览器支持"文件系统访问"接口时（Chrome、Edge），保存会直接写回用户选的那个文件；
 * 不支持时（Safari、Firefox）退回成下载一个文件。
 */

// ───────────── 当前文件的状态 ─────────────

export interface FileState {
  /** 当前文件名；还没保存过时为 null */
  name: string | null;
  /** 自上次保存以来是否有修改 */
  dirty: boolean;
}

interface SaveHandle {
  name: string;
  createWritable(): Promise<{ write(data: Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface PickerWindow {
  showSaveFilePicker?(options: { suggestedName: string; types: PickerType[] }): Promise<SaveHandle>;
  showOpenFilePicker?(options: { types: PickerType[]; multiple: boolean }): Promise<SaveHandle[]>;
}

const picker = window as unknown as PickerWindow;
const t = (key: string, options: Record<string, unknown> = {}): string => i18n.t(key, options);

let state: FileState = { name: null, dirty: false };
let handle: SaveHandle | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<FileState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

export function useFileState(): FileState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** 文档一有修改就标记为"未保存" */
export function trackChanges(store: DocStore): void {
  store.subscribe((change) => {
    if (change.source !== 'load' && !state.dirty) setState({ dirty: true });
  });
}

// ───────────── 小工具 ─────────────

const SHIBA_TYPES: PickerType[] = [{ description: 'ShibaDesign', accept: { [SHIBA_MIME]: [SHIBA_EXTENSION] } }];
const PNG_TYPES: PickerType[] = [{ description: 'PNG', accept: { 'image/png': ['.png'] } }];
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp';
/** 图片长边超过这个值就在导入时缩小。解码后的图片整张放在内存和显存里，太大会拖垮整个画布 */
const MAX_IMAGE_SIDE = 4096;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function download(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([toBuffer(bytes)], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 弹出系统的文件选择框 */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

function starterDocument(): DocumentData {
  const store = DocStore.create();
  store.transact('init', (tx) =>
    tx.create(
      createNode('artboard', {
        parent: store.root.id,
        index: 'a0',
        seq: 1,
        size: [1280, 720],
        fill: solid(rgba(1, 1, 1)),
        deck: { order: 'a0', notes: '' },
      }),
    ),
  );
  return store.toJSON();
}

/** 一个只有一张空白画板的新文档 */
export function createStarterDocument(): DocumentData {
  return starterDocument();
}

/** 换文档之前，如果有没保存的修改，先问一下 */
function confirmDiscard(): boolean {
  return !state.dirty || window.confirm(t('file.discardConfirm'));
}

// ───────────── 新建、打开、保存 ─────────────

export function newDocument(editor: Editor): void {
  if (!confirmDiscard()) return;
  editor.setTool('select');
  editor.assets.replaceAll([]);
  editor.store.load(starterDocument());
  editor.zoomToFit();
  handle = null;
  setState({ name: null, dirty: false });
}

/** 把一个 .shiba 文件的内容装进编辑器。文件有问题时提示原因，当前文档不受影响 */
async function loadShiba(editor: Editor, file: File, from: SaveHandle | null): Promise<void> {
  try {
    const parsed = unpackShiba(new Uint8Array(await file.arrayBuffer()));
    editor.setTool('select');
    // 先换资源再换文档，这样文档一出现图片就已经在了
    editor.assets.replaceAll(parsed.assets);
    editor.store.load(parsed.document);
    editor.zoomToFit();
    handle = from;
    setState({ name: file.name, dirty: false });
  } catch (error) {
    const reason = error instanceof ShibaFileError ? error.reason : 'badDocument';
    if (!(error instanceof ShibaFileError)) console.error(error);
    toast(t('file.openFailed', { reason: t(`file.reason.${reason}`) }), 'error');
  }
}

export async function openDocument(editor: Editor): Promise<void> {
  if (!confirmDiscard()) return;
  try {
    if (picker.showOpenFilePicker) {
      const [picked] = await picker.showOpenFilePicker({ types: SHIBA_TYPES, multiple: false });
      if (picked) await loadShiba(editor, await picked.getFile(), picked);
      return;
    }
    const [file] = await pickFiles(SHIBA_EXTENSION, false);
    if (file) await loadShiba(editor, file, null);
  } catch (error) {
    if (!isAbort(error)) throw error;
  }
}

/** 打开一个拖进窗口的 .shiba 文件 */
export async function openDroppedDocument(editor: Editor, file: File): Promise<void> {
  if (!confirmDiscard()) return;
  await loadShiba(editor, file, null);
}

function buildFile(editor: Editor): Uint8Array {
  // 只写入文档实际引用的图片：撤销掉的、换掉的图片不占文件体积
  const referenced = referencedAssetIds(editor.store);
  return packShiba({
    document: editor.store.toJSON(),
    assets: editor.assets.all().filter((asset) => referenced.has(asset.meta.id)),
  });
}

async function writeTo(target: SaveHandle, bytes: Uint8Array): Promise<void> {
  const writable = await target.createWritable();
  await writable.write(toBuffer(bytes));
  await writable.close();
}

export async function saveDocumentAs(editor: Editor): Promise<void> {
  const suggested = state.name ?? `${t('file.untitled')}${SHIBA_EXTENSION}`;
  try {
    const bytes = buildFile(editor);
    if (picker.showSaveFilePicker) {
      const target = await picker.showSaveFilePicker({ suggestedName: suggested, types: SHIBA_TYPES });
      await writeTo(target, bytes);
      handle = target;
      setState({ name: target.name, dirty: false });
      toast(t('file.saved', { name: target.name }));
      return;
    }
    download(suggested, bytes, SHIBA_MIME);
    setState({ name: suggested, dirty: false });
    toast(t('file.downloaded', { name: suggested }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

export async function saveDocument(editor: Editor): Promise<void> {
  if (!handle) return saveDocumentAs(editor);
  try {
    await writeTo(handle, buildFile(editor));
    setState({ dirty: false });
    toast(t('file.saved', { name: handle.name }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

// ───────────── 导出 ─────────────

/** 导出 PNG：选中了一个对象就导出它，否则导出当前画板 */
export async function exportPng(editor: Editor, scale: number): Promise<void> {
  const selected = editor.selectedNodes();
  const target = selected.length === 1 ? selected[0]! : editor.activeArtboard;
  if (!target) return;
  const bytes = await editor.exportPng(target.id, scale);
  if (!bytes) {
    toast(t('file.exportFailed'), 'error');
    return;
  }
  const name = `${displayName(target, t)}${scale === 1 ? '' : `@${scale}x`}.png`;
  try {
    if (picker.showSaveFilePicker) {
      const out = await picker.showSaveFilePicker({ suggestedName: name, types: PNG_TYPES });
      await writeTo(out, bytes);
      toast(t('file.exported', { name: out.name }));
      return;
    }
    download(name, bytes, 'image/png');
    toast(t('file.exported', { name }));
  } catch (error) {
    if (isAbort(error)) return;
    console.error(error);
    toast(t('file.saveFailed'), 'error');
  }
}

// ───────────── 导入图片 ─────────────

/**
 * 用浏览器自己的解码器把图片转成 PNG。两种情况会用到：
 * 渲染引擎不认识的格式（比如 WebP、AVIF），以及需要缩小的大图。
 */
async function transcode(file: Blob, maxSide: number): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } catch {
    return null;
  }
}

/** 把一个图片文件收进资源库，返回资源 id；失败时提示并返回 null */
export async function importImageFile(editor: Editor, file: File): Promise<string | null> {
  const fail = (): null => {
    toast(t('image.unsupported', { name: file.name || t('node.image') }), 'error');
    return null;
  };
  if (file.size > MAX_IMAGE_BYTES) return fail();

  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  let mime = file.type || 'image/png';
  const size = editor.images.probe(bytes);
  const tooBig = size !== null && Math.max(size.width, size.height) > MAX_IMAGE_SIDE;
  if (!size || tooBig) {
    const converted = await transcode(file, MAX_IMAGE_SIDE);
    if (!converted) return fail();
    bytes = converted;
    mime = 'image/png';
    if (tooBig) toast(t('image.downscaled', { name: file.name, size: MAX_IMAGE_SIDE }));
  }
  const meta = await editor.importImage(bytes, { mime, name: file.name || undefined });
  return meta ? meta.id : fail();
}

/** 导入一批图片并放到画布上。at 是世界坐标；不传时放在当前画板中央 */
export async function placeImageFiles(editor: Editor, files: readonly File[], at?: Point): Promise<void> {
  let offset = 0;
  for (const file of files) {
    const assetId = await importImageFile(editor, file);
    if (!assetId) continue;
    editor.commands.run('image.place', { assetId, at: at ? { x: at.x + offset, y: at.y + offset } : undefined });
    offset += 24;
  }
}

export async function pickAndPlaceImages(editor: Editor): Promise<void> {
  await placeImageFiles(editor, await pickFiles(IMAGE_ACCEPT, true));
}

/** 选一张图片，作为选中形状的填充 */
export async function pickImageFill(editor: Editor): Promise<void> {
  const [file] = await pickFiles(IMAGE_ACCEPT, false);
  if (!file) return;
  const assetId = await importImageFile(editor, file);
  if (assetId) editor.commands.run('image.setFill', { assetId });
}

export function isShibaFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(SHIBA_EXTENSION);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}
