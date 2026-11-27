import type { SceneNode } from './model';
import type { DocStore } from './store';

/**
 * 资源库：文档引用的二进制资源——图片，以及从 PDF 导入的文字用到的字形库。
 *
 * 资源按内容寻址：id 是文件内容的 SHA-256，所以同一张图片导入多次只存一份，
 * 也不需要撤销重做——节点引用哪个 id 记在文档里，资源本身只增不改。
 * 保存文件时只写入文档实际引用到的资源。
 */

export interface AssetMeta {
  id: string;
  mime: string;
  width: number;
  height: number;
  /** 字节数 */
  size: number;
  /** 导入时的文件名，仅用于显示 */
  name?: string;
}

export interface Asset {
  meta: AssetMeta;
  bytes: Uint8Array;
}

export class AssetStore {
  private items = new Map<string, Asset>();
  private listeners = new Set<() => void>();

  /** 加入一个资源，返回它的元信息。内容相同的资源只保留一份 */
  async add(bytes: Uint8Array, info: Omit<AssetMeta, 'id' | 'size'>): Promise<AssetMeta> {
    const id = await hashBytes(bytes);
    const existing = this.items.get(id);
    if (existing) return existing.meta;
    const meta: AssetMeta = { ...info, id, size: bytes.byteLength };
    this.put({ meta, bytes });
    return meta;
  }

  /** 放入一个已知 id 的资源，打开文件时用 */
  put(asset: Asset): void {
    this.items.set(asset.meta.id, asset);
    for (const listener of [...this.listeners]) listener();
  }

  get(id: string): Uint8Array | undefined {
    return this.items.get(id)?.bytes;
  }

  meta(id: string): AssetMeta | undefined {
    return this.items.get(id)?.meta;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  all(): Asset[] {
    return [...this.items.values()];
  }

  /** 整体替换，打开另一个文件时用 */
  replaceAll(assets: readonly Asset[]): void {
    this.items = new Map(assets.map((a) => [a.meta.id, a]));
    for (const listener of [...this.listeners]) listener();
  }

  /** 有资源加入或被替换时通知 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** 一个节点用到的资源 id：图片填充的图片，文字保真外观的字形库 */
export function assetIdsOf(node: SceneNode): string[] {
  const ids: string[] = [];
  if ('fill' in node && node.fill?.type === 'image') ids.push(node.fill.assetId);
  if (node.type === 'text' && node.appearance) for (const run of node.appearance.runs) ids.push(run.library);
  return ids;
}

/** 文档里实际用到的资源 id */
export function referencedAssetIds(store: DocStore): Set<string> {
  const ids = new Set<string>();
  for (const node of store.all()) for (const id of assetIdsOf(node)) ids.add(id);
  return ids;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  // 拷一份，保证传给 digest 的是独立的 ArrayBuffer（传进来的可能是某个大缓冲区的一段视图）
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, 40);
}
