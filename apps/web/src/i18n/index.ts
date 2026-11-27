import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enPack from './locales/en.json';
import zhPack from './locales/zh-CN.json';
import { flatten, parsePack, serializePack, unflatten, type LocalePack, type StringTree } from './packs';

/**
 * 语言管理：内置语言 + 用户导入的语言包。
 *
 * 新增一种内置语言：在 locales/ 下加一个 JSON 文件，并加进下面的 BUILTIN 数组。
 * 用户自己翻译：导出任意一种语言 → 翻译 → 导入，不需要改代码。
 */

const BUILTIN: LocalePack[] = [zhPack, enPack];
const FALLBACK = 'en';
const NAMESPACE = 'translation';
const LOCALE_KEY = 'shiba.locale';
const CUSTOM_KEY = 'shiba.locales.custom';

export interface LocaleInfo {
  code: string;
  name: string;
  /** 是否包含用户导入的内容（新语言，或对内置语言的覆盖） */
  custom: boolean;
  /** 是否有内置版本；有的话移除自定义包后会恢复成内置版本 */
  builtin: boolean;
}

export interface ImportResult {
  code: string;
  name: string;
  missing: number;
}

let customPacks: LocalePack[] = [];
const listeners = new Set<() => void>();
let snapshot: LocaleInfo[] = [];

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式或存储已满时忽略；语言设置只是不会被记住
  }
}

const baseStrings = (): StringTree => (BUILTIN.find((p) => p.meta.code === FALLBACK) ?? BUILTIN[0]!).strings;

function loadCustomPacks(): LocalePack[] {
  const raw = readStorage(CUSTOM_KEY);
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // 存储里的内容同样当作不可信数据，重新走一遍校验
    return list.flatMap((item) => {
      try {
        return [parsePack(JSON.stringify(item), baseStrings()).pack];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** 某个语言当前生效的全部文字：内置版本打底，自定义包覆盖其上 */
function effectiveStrings(code: string): StringTree {
  const merged = new Map<string, string>();
  const builtin = BUILTIN.find((p) => p.meta.code === code);
  const custom = customPacks.find((p) => p.meta.code === code);
  if (builtin) for (const [k, v] of flatten(builtin.strings)) merged.set(k, v);
  if (custom) for (const [k, v] of flatten(custom.strings)) merged.set(k, v);
  return unflatten(merged);
}

function syncBundles(): void {
  const codes = new Set([...BUILTIN, ...customPacks].map((p) => p.meta.code));
  for (const code of codes) {
    i18n.addResourceBundle(code, NAMESPACE, effectiveStrings(code), false, true);
  }
  snapshot = [...codes].map((code) => {
    const builtin = BUILTIN.find((p) => p.meta.code === code);
    const custom = customPacks.find((p) => p.meta.code === code);
    return {
      code,
      name: custom?.meta.name ?? builtin!.meta.name,
      custom: custom !== undefined,
      builtin: builtin !== undefined,
    };
  });
  for (const listener of [...listeners]) listener();
}

function detectLocale(): string {
  const saved = readStorage(LOCALE_KEY);
  const known = new Set([...BUILTIN, ...customPacks].map((p) => p.meta.code));
  if (saved && known.has(saved)) return saved;
  const system = typeof navigator === 'undefined' ? FALLBACK : navigator.language;
  if (known.has(system)) return system;
  return system.toLowerCase().startsWith('zh') ? 'zh-CN' : FALLBACK;
}

export async function initI18n(): Promise<void> {
  customPacks = loadCustomPacks();
  await i18n.use(initReactI18next).init({
    resources: {},
    lng: FALLBACK,
    fallbackLng: FALLBACK,
    defaultNS: NAMESPACE,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  syncBundles();
  await setLocale(detectLocale());
}

export function listLocales(): LocaleInfo[] {
  return snapshot;
}

export function subscribeLocales(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentLocale(): string {
  return i18n.language;
}

export async function setLocale(code: string): Promise<void> {
  await i18n.changeLanguage(code);
  writeStorage(LOCALE_KEY, code);
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}

/** 导出某个语言当前生效的全部文字，作为翻译的起点 */
export function exportLocale(code: string): { filename: string; content: string } {
  const info = snapshot.find((l) => l.code === code);
  const pack: LocalePack = {
    meta: { app: 'ShibaDesign', format: 1, code, name: info?.name ?? code },
    strings: effectiveStrings(code),
  };
  return { filename: `shibadesign-${code}.json`, content: serializePack(pack) };
}

/**
 * 导入一个语言包文件的文本。校验失败时抛出 PackError。
 * 语言代码与已有语言相同时，覆盖该语言里对应的文字。
 */
export async function importLocale(text: string): Promise<ImportResult> {
  const { pack, missing } = parsePack(text, baseStrings());
  customPacks = [...customPacks.filter((p) => p.meta.code !== pack.meta.code), pack];
  writeStorage(CUSTOM_KEY, JSON.stringify(customPacks));
  syncBundles();
  await setLocale(pack.meta.code);
  // 覆盖内置语言时，没翻译的条目由内置版本补上，所以不算缺失
  const hasBuiltin = BUILTIN.some((p) => p.meta.code === pack.meta.code);
  return { code: pack.meta.code, name: pack.meta.name, missing: hasBuiltin ? 0 : missing.length };
}

export async function removeCustomLocale(code: string): Promise<void> {
  customPacks = customPacks.filter((p) => p.meta.code !== code);
  writeStorage(CUSTOM_KEY, JSON.stringify(customPacks));
  const stillExists = BUILTIN.some((p) => p.meta.code === code);
  if (!stillExists) i18n.removeResourceBundle(code, NAMESPACE);
  syncBundles();
  if (i18n.language === code && !stillExists) await setLocale(detectLocale());
  else if (i18n.language === code) await i18n.changeLanguage(code);
}

export { i18n };
export { PackError } from './packs';
