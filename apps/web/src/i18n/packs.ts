/**
 * 语言包的数据格式与校验。内置语言文件和用户导出 / 导入的文件是同一种格式：
 *
 *   { "meta": { "app": "ShibaDesign", "format": 1, "code": "ja", "name": "日本語" },
 *     "strings": { "tool": { "select": "選択", ... }, ... } }
 *
 * 这个模块是纯函数，不碰 i18next，也不碰存储。
 */

export interface LocaleMeta {
  /** 固定为 'ShibaDesign' */
  app: string;
  /** 语言包格式版本，目前是 1 */
  format: number;
  code: string;
  name: string;
}

export interface StringTree {
  [key: string]: string | StringTree;
}

export interface LocalePack {
  meta: LocaleMeta;
  strings: StringTree;
}

export type PackErrorReason = 'notJson' | 'noMeta' | 'badCode' | 'noStrings' | 'tooLarge';

export class PackError extends Error {
  constructor(readonly reason: PackErrorReason) {
    super(reason);
  }
}

export interface ParsedPack {
  pack: LocalePack;
  /** 基准语言里有、这个包里没有的键 */
  missing: string[];
  /** 这个包里多出来的键，已被丢弃 */
  unknown: string[];
}

const MAX_FILE_CHARS = 512 * 1024;
const MAX_STRING_CHARS = 2000;
const CODE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/;

/** 把嵌套的文字表摊平成 'a.b.c' → 文字 */
export function flatten(tree: StringTree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (value && typeof value === 'object') for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

export function unflatten(entries: Iterable<[string, string]>): StringTree {
  const root: StringTree = {};
  for (const [path, value] of entries) {
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (typeof next === 'object') node = next;
      else node = node[part] = {};
    }
    node[parts[parts.length - 1]!] = value;
  }
  return root;
}

/**
 * 解析并校验一个语言包文件。
 * 只保留基准语言里存在的键，值必须是不太长的字符串；其他内容一律丢弃。
 * 文件不合格时抛出 PackError。
 */
export function parsePack(text: string, base: StringTree): ParsedPack {
  if (text.length > MAX_FILE_CHARS) throw new PackError('tooLarge');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PackError('notJson');
  }
  if (!isObject(raw)) throw new PackError('notJson');

  const meta = raw.meta;
  if (!isObject(meta) || typeof meta.code !== 'string' || typeof meta.name !== 'string') {
    throw new PackError('noMeta');
  }
  const code = meta.code.trim();
  const name = meta.name.trim().slice(0, 40);
  if (!CODE_PATTERN.test(code)) throw new PackError('badCode');
  if (!name) throw new PackError('noMeta');
  if (!isObject(raw.strings)) throw new PackError('noStrings');

  const baseKeys = flatten(base);
  const given = flatten(raw.strings as StringTree);
  const kept: [string, string][] = [];
  const unknown: string[] = [];
  for (const [key, value] of given) {
    if (!baseKeys.has(key)) unknown.push(key);
    else if (value.length > 0 && value.length <= MAX_STRING_CHARS) kept.push([key, value]);
  }
  if (kept.length === 0) throw new PackError('noStrings');

  const keptKeys = new Set(kept.map(([key]) => key));
  const missing = [...baseKeys.keys()].filter((key) => !keptKeys.has(key));
  return {
    pack: { meta: { app: 'ShibaDesign', format: 1, code, name }, strings: unflatten(kept) },
    missing,
    unknown,
  };
}

/** 序列化成给用户下载的文件内容 */
export function serializePack(pack: LocalePack): string {
  return JSON.stringify(pack, null, 2) + '\n';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
