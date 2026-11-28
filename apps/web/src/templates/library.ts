import { createId } from '@shiba/core';

/**
 * 我的模板：用户存下来的模板，放在浏览器的 IndexedDB 里（和草稿分开的一个库）。
 * 每个模板是一个打包好的 .shiba 文件（文档加用到的图片）和一张缩略图；打开时照 .shiba 文件一样解包、校验，
 * 所以导出、导入模板就是导出、导入 .shiba 文件。存在浏览器里的东西清理网站数据时会丢，界面上提示用户导出备份。
 */

export interface TemplateMeta {
  id: string;
  name: string;
  /** 存下来的时间，毫秒 */
  created: number;
  /** 第一张画板的缩略图（PNG）。画不出来时为 null */
  thumbnail: Blob | null;
  /** 有几页幻灯片：大于 0 的打开后进幻灯片视图 */
  slides: number;
}

interface TemplateRecord extends TemplateMeta {
  /** 打包好的 .shiba 文件 */
  file: Blob;
}

const DB_NAME = 'shibadesign-templates';
const DB_VERSION = 1;
const STORE = 'templates';
/** 模板名最长几个字 */
export const MAX_TEMPLATE_NAME = 100;

let opening: Promise<IDBDatabase> | null = null;
const listeners = new Set<() => void>();

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打不开'));
  });
  // 打不开（比如隐私模式禁用了 IndexedDB）时下次再试，不要一直拿着失败的结果
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

async function transaction(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await open();
  return db.transaction(STORE, mode).objectStore(STORE);
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/** 模板库变了（存了、删了、改名）时通知 */
export function subscribeTemplates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 所有模板，新存的在前。不含文件本身 */
export async function listTemplates(): Promise<TemplateMeta[]> {
  const all = (await done((await transaction('readonly')).getAll())) as TemplateRecord[];
  return all.map(({ file: _file, ...meta }) => meta).sort((a, b) => b.created - a.created);
}

export async function addTemplate(entry: {
  name: string;
  file: Uint8Array;
  thumbnail: Blob | null;
  slides: number;
}): Promise<TemplateMeta> {
  const record: TemplateRecord = {
    id: createId(),
    name: entry.name.trim().slice(0, MAX_TEMPLATE_NAME),
    created: Date.now(),
    thumbnail: entry.thumbnail,
    slides: entry.slides,
    file: new Blob([new Uint8Array(entry.file)], { type: 'application/zip' }),
  };
  await done((await transaction('readwrite')).put(record));
  changed();
  const { file: _file, ...meta } = record;
  return meta;
}

/** 模板的 .shiba 文件内容；模板不存在时返回 null */
export async function templateFile(id: string): Promise<Uint8Array | null> {
  const record = (await done((await transaction('readonly')).get(id))) as TemplateRecord | undefined;
  return record ? new Uint8Array(await record.file.arrayBuffer()) : null;
}

export async function renameTemplate(id: string, name: string): Promise<void> {
  const store = await transaction('readwrite');
  const record = (await done(store.get(id))) as TemplateRecord | undefined;
  if (!record) return;
  await done(store.put({ ...record, name: name.trim().slice(0, MAX_TEMPLATE_NAME) }));
  changed();
}

export async function deleteTemplate(id: string): Promise<void> {
  await done((await transaction('readwrite')).delete(id));
  changed();
}
