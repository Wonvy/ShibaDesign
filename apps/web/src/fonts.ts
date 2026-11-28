import arimoRanges from '@fontsource/arimo/unicode.json';
import cousineRanges from '@fontsource/cousine/unicode.json';
import interRanges from '@fontsource/inter/unicode.json';
import notoRanges from '@fontsource/noto-sans-sc/unicode.json';
import notoSerifRanges from '@fontsource/noto-serif-sc/unicode.json';
import tinosRanges from '@fontsource/tinos/unicode.json';
import type { FontChoices } from '@shiba/io';
import { parseUnicodeRange, type FontFaceSource, type FontManager } from '@shiba/renderer';

/**
 * 内置字体。字体文件来自 fontsource 的 npm 包，随应用一起发布，不依赖任何外部字体服务。
 * 每个家族按 Unicode 区间切成很多小文件，用到哪些字才下载哪些文件。
 *
 * 新增内置字体：安装对应的 @fontsource 包，仿照下面再登记一个家族。
 */

const WEIGHTS = [400, 700];

// 这里只是拿到每个字体文件的地址，文件本身在用到时才下载。
// 选项必须直接写成对象字面量：Vite 在构建时静态分析这些调用，不认变量
const interFiles = import.meta.glob<string>(
  '../../../node_modules/@fontsource/inter/files/inter-*-{400,700}-{normal,italic}.woff2',
  { query: '?url', import: 'default', eager: true },
);
const notoFiles = import.meta.glob<string>(
  [
    '../../../node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-*-{400,700}-normal.woff2',
    // 包里还有一个没切片的完整简体中文文件（每个字重 1MB 多），我们用不到，别打进发布包
    '!**/noto-sans-sc-chinese-simplified-*',
  ],
  { query: '?url', import: 'default', eager: true },
);
const notoSerifFiles = import.meta.glob<string>(
  [
    '../../../node_modules/@fontsource/noto-serif-sc/files/noto-serif-sc-*-{400,700}-normal.woff2',
    '!**/noto-serif-sc-chinese-simplified-*',
  ],
  { query: '?url', import: 'default', eager: true },
);
const arimoFiles = import.meta.glob<string>(
  '../../../node_modules/@fontsource/arimo/files/arimo-*-{400,700}-{normal,italic}.woff2',
  { query: '?url', import: 'default', eager: true },
);
const tinosFiles = import.meta.glob<string>(
  '../../../node_modules/@fontsource/tinos/files/tinos-*-{400,700}-{normal,italic}.woff2',
  { query: '?url', import: 'default', eager: true },
);
const cousineFiles = import.meta.glob<string>(
  '../../../node_modules/@fontsource/cousine/files/cousine-*-{400,700}-{normal,italic}.woff2',
  { query: '?url', import: 'default', eager: true },
);

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

function buildFaces(prefix: string, ranges: Record<string, string>, files: Record<string, string>): FontFaceSource[] {
  const urls = new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
  const faces: FontFaceSource[] = [];
  for (const [key, range] of Object.entries(ranges)) {
    // fontsource 用 "[119]" 这样的键表示编号分片，文件名里是不带括号的 119
    const chunk = key.replace(/[[\]]/g, '');
    for (const weight of WEIGHTS) {
      for (const italic of [false, true]) {
        const file = `${prefix}-${chunk}-${weight}-${italic ? 'italic' : 'normal'}`;
        const url = urls.get(`${file}.woff2`);
        // 中文字体没有斜体文件，设成斜体时按正体显示
        if (!url) continue;
        faces.push({
          chunk,
          weight,
          italic,
          ranges: parseUnicodeRange(range),
          load: () => fetchBytes(url),
          // 导出 PDF 时嵌入字体要用同一个文件的 WOFF 版本，见 font-files.ts
          loadEmbeddable: async () => {
            const { embeddableUrl } = await import('./font-files');
            const embeddable = embeddableUrl(`${file}.woff`);
            if (!embeddable) throw new Error(`no embeddable font for ${file}`);
            return fetchBytes(embeddable);
          },
        });
      }
    }
  }
  return faces;
}

export const DEFAULT_FONTS = { latin: 'Inter', cjk: 'Noto Sans SC' };

/**
 * 打开 PDF 时，原文件的字体按类别换成这些。西文用和最常见的字体等宽的替代品：
 * Arimo 和 Arial / Helvetica 等宽，Tinos 和 Times 等宽，Cousine 和 Courier 等宽。
 * 字宽一样，换过去之后每行的长度不变，改字时折行也和原来一致。
 */
export const PDF_FONTS: FontChoices = {
  sans: { latin: 'Arimo', cjk: 'Noto Sans SC' },
  serif: { latin: 'Tinos', cjk: 'Noto Serif SC' },
  mono: { latin: 'Cousine', cjk: 'Noto Sans SC' },
};

export function registerFonts(fonts: FontManager): void {
  fonts.addFamily({ name: 'Inter', faces: buildFaces('inter', interRanges, interFiles) });
  fonts.addFamily({ name: 'Noto Sans SC', faces: buildFaces('noto-sans-sc', notoRanges, notoFiles) });
  fonts.addFamily({ name: 'Noto Serif SC', faces: buildFaces('noto-serif-sc', notoSerifRanges, notoSerifFiles) });
  fonts.addFamily({ name: 'Arimo', faces: buildFaces('arimo', arimoRanges, arimoFiles) });
  fonts.addFamily({ name: 'Tinos', faces: buildFaces('tinos', tinosRanges, tinosFiles) });
  fonts.addFamily({ name: 'Cousine', faces: buildFaces('cousine', cousineRanges, cousineFiles) });
}
