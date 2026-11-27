import {
  referencedAssetIds,
  validateDocument,
  type Asset,
  type AssetStore,
  type DocStore,
  type DocumentData,
} from '@shiba/core';

/**
 * 本地草稿：把正在编辑的文档自动存在浏览器的 IndexedDB 里，刷新或意外关闭后能接着做。
 * 它不是"保存文件"——真正的保存是文件菜单里的 .shiba 文件。
 *
 * 文档（JSON，通常很小）每次修改后重写；图片（很大，内容不变）只在第一次出现时写一次。
 * 文档很大时（比如刚导入了一份几十页的 PDF）写一次要卡住界面零点几秒，这时自动把保存间隔拉长。
 */

export interface Draft {
  document: DocumentData;
  assets: Asset[];
}

const DB_NAME = 'shibadesign';
const DB_VERSION = 1;
const KV = 'kv';
const ASSETS = 'assets';
const DOCUMENT_KEY = 'document';
const LEGACY_KEY = 'shiba.document';
const SAVE_DELAY = 500;
/** 写一次文档花了多久，下次就至少等它的这么多倍再写：保证自动保存最多占用一小部分时间 */
const SAVE_BACKOFF = 8;
const MAX_SAVE_DELAY = 20_000;

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打不开'));
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

async function read<T>(store: string, key: string): Promise<T | undefined> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key) as IDBRequest<T | undefined>);
}

async function write(store: string, key: string, value: unknown): Promise<void> {
  const db = await open();
  await done(db.transaction(store, 'readwrite').objectStore(store).put(value, key));
}

async function remove(store: string, key: string): Promise<void> {
  const db = await open();
  await done(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

async function keys(store: string): Promise<string[]> {
  const db = await open();
  return (await done(db.transaction(store).objectStore(store).getAllKeys())).map(String);
}

/** 读出上次的草稿。没有草稿、草稿损坏或浏览器不让用存储时返回 null */
export async function loadDraft(): Promise<Draft | null> {
  try {
    let raw = await read<unknown>(KV, DOCUMENT_KEY);
    if (!raw) {
      // 早期版本把文档存在 localStorage 里，这里顺手迁移过来
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) raw = JSON.parse(legacy);
    }
    if (!raw) return null;
    // 存储里的内容也可能被别的东西改过，照样校验
    const document = validateDocument(raw);

    const wanted = new Set<string>();
    for (const node of Object.values(document.nodes)) {
      if ('fill' in node && node.fill?.type === 'image') wanted.add(node.fill.assetId);
    }
    const assets: Asset[] = [];
    for (const id of await keys(ASSETS)) {
      if (!wanted.has(id)) {
        // 文档已经不再引用的图片，趁启动时清掉
        await remove(ASSETS, id);
        continue;
      }
      const asset = await read<Asset>(ASSETS, id);
      if (asset?.meta?.id === id && asset.bytes instanceof Uint8Array) assets.push(asset);
    }
    return { document, assets };
  } catch (error) {
    console.warn('[shiba] 读取本地草稿失败，改用新文档', error);
    return null;
  }
}

/** 开启自动保存草稿 */
export function enableDraftAutosave(store: DocStore, assets: AssetStore): void {
  const persisted = new Set<string>();
  let timer = 0;
  let failed = false;
  let delay = SAVE_DELAY;

  const flush = async (): Promise<void> => {
    try {
      const referenced = referencedAssetIds(store);
      for (const asset of assets.all()) {
        if (persisted.has(asset.meta.id) || !referenced.has(asset.meta.id)) continue;
        await write(ASSETS, asset.meta.id, asset);
        persisted.add(asset.meta.id);
      }
      // 把文档交给 IndexedDB 时浏览器要在主线程上完整拷贝一遍，文档越大越慢；量一下写入花了多久，据此调整间隔
      const started = performance.now();
      await write(KV, DOCUMENT_KEY, store.toJSON());
      delay = Math.min(MAX_SAVE_DELAY, Math.max(SAVE_DELAY, (performance.now() - started) * SAVE_BACKOFF));
      localStorage.removeItem(LEGACY_KEY);
      failed = false;
    } catch (error) {
      // 隐私模式或空间不足时存不进去。只提示一次，不打断编辑
      if (!failed) console.warn('[shiba] 自动保存草稿失败', error);
      failed = true;
    }
  };

  const schedule = (): void => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), delay);
  };
  store.subscribe(schedule);
  assets.subscribe(() => {
    // 资源库被整体替换（打开了另一个文件）时，之前"已存过"的记录不再可靠
    for (const id of [...persisted]) if (!assets.has(id)) persisted.delete(id);
    schedule();
  });
}
