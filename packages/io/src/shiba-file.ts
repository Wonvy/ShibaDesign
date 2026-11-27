import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  DocumentError,
  GLYPH_LIBRARY_MIME,
  validateDocument,
  type Asset,
  type AssetMeta,
  type DocumentData,
} from '@shiba/core';

/**
 * .shiba 文件格式。
 *
 * 一个 .shiba 文件是一个 ZIP 包：
 *
 *   manifest.json    格式标识、格式版本、资源清单
 *   document.json    文档数据（节点表）
 *   assets/<id>.png  文档引用的图片，文件名是内容的哈希
 *
 * 用 ZIP 是因为图片本身已经压缩过，原样存进去最快；
 * 用户把扩展名改成 .zip 也能直接解开，拿回自己的图片。
 *
 * 打开文件时所有内容都按不可信输入处理：只读取认识的条目，限制总大小，文档结构要过校验。
 */

export const SHIBA_EXTENSION = '.shiba';
export const SHIBA_MIME = 'application/vnd.shibadesign';

const FORMAT = 'shibadesign';
const FORMAT_VERSION = 1;
/** 解压后的总大小上限，防止恶意构造的压缩包把内存撑爆 */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
  // 从 PDF 导入的文字用到的字形库
  [GLYPH_LIBRARY_MIME]: 'json',
};

export interface ShibaFile {
  document: DocumentData;
  assets: Asset[];
}

export type ShibaFileErrorReason = 'notZip' | 'noManifest' | 'notShiba' | 'newerVersion' | 'badDocument' | 'tooLarge';

export class ShibaFileError extends Error {
  constructor(
    readonly reason: ShibaFileErrorReason,
    detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

interface Manifest {
  format: string;
  formatVersion: number;
  savedAt: string;
  assets: AssetMeta[];
}

function assetPath(meta: AssetMeta): string {
  return `assets/${meta.id}.${EXTENSIONS[meta.mime] ?? 'bin'}`;
}

/** 把文档和资源打成 .shiba 文件的字节 */
export function packShiba(file: ShibaFile, savedAt: Date = new Date()): Uint8Array {
  const manifest: Manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    savedAt: savedAt.toISOString(),
    assets: file.assets.map((a) => a.meta),
  };
  const entries: Zippable = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'document.json': strToU8(JSON.stringify(file.document)),
  };
  // 图片已经是压缩格式，再压一遍几乎没有收益，只存不压
  for (const asset of file.assets) entries[assetPath(asset.meta)] = [asset.bytes, { level: 0 }];
  return zipSync(entries, { level: 6 });
}

/** 解开一个 .shiba 文件并校验。文件不合格时抛出 ShibaFileError */
export function unpackShiba(bytes: Uint8Array): ShibaFile {
  let total = 0;
  let oversized = false;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(entry) {
        const known =
          entry.name === 'manifest.json' ||
          entry.name === 'document.json' ||
          /^assets\/[a-f0-9]{8,64}\.[a-z0-9]{1,5}$/.test(entry.name);
        if (!known) return false;
        total += entry.originalSize;
        if (total > MAX_UNPACKED_BYTES) oversized = true;
        if (entry.name.endsWith('.json') && entry.originalSize > MAX_JSON_BYTES) oversized = true;
        return !oversized;
      },
    });
  } catch {
    throw new ShibaFileError('notZip');
  }
  if (oversized) throw new ShibaFileError('tooLarge');

  const manifestBytes = entries['manifest.json'];
  const documentBytes = entries['document.json'];
  if (!manifestBytes || !documentBytes) throw new ShibaFileError('noManifest');

  const manifest = parseJson(manifestBytes);
  if (!isObject(manifest) || manifest.format !== FORMAT) throw new ShibaFileError('notShiba');
  if (typeof manifest.formatVersion !== 'number') throw new ShibaFileError('notShiba');
  if (manifest.formatVersion > FORMAT_VERSION) throw new ShibaFileError('newerVersion', String(manifest.formatVersion));

  let document: DocumentData;
  try {
    document = validateDocument(parseJson(documentBytes));
  } catch (error) {
    if (error instanceof DocumentError && error.reason === 'newerVersion') {
      throw new ShibaFileError('newerVersion', error.message);
    }
    throw new ShibaFileError('badDocument', error instanceof Error ? error.message : '');
  }

  const assets: Asset[] = [];
  for (const raw of Array.isArray(manifest.assets) ? manifest.assets : []) {
    const meta = parseAssetMeta(raw);
    if (!meta) continue;
    // 清单里有但包里没有的图片就跳过，画布上会显示占位，不影响打开文件
    const data = entries[assetPath(meta)];
    if (data) assets.push({ meta: { ...meta, size: data.byteLength }, bytes: data });
  }
  return { document, assets };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new ShibaFileError('badDocument', 'invalid JSON');
  }
}

function parseAssetMeta(raw: unknown): AssetMeta | null {
  if (!isObject(raw)) return null;
  const { id, mime, width, height, name } = raw;
  if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/.test(id)) return null;
  if (typeof mime !== 'string' || !(mime in EXTENSIONS)) return null;
  // 图片要有尺寸；字形库这类非图片资源的尺寸是 0
  const image = mime.startsWith('image/');
  if (image ? !isPositive(width) || !isPositive(height) : width !== 0 || height !== 0) return null;
  return {
    id,
    mime,
    width: width as number,
    height: height as number,
    size: 0,
    ...(typeof name === 'string' ? { name: name.slice(0, 255) } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
