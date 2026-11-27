import interRanges from '@fontsource/inter/unicode.json';
import notoRanges from '@fontsource/noto-sans-sc/unicode.json';
import { parseUnicodeRange, type FontFaceSource, type FontManager } from '@shiba/renderer';

/**
 * 内置字体。字体文件来自 fontsource 的 npm 包，随应用一起发布，不依赖任何外部字体服务。
 * 每个家族按 Unicode 区间切成很多小文件，用到哪些字才下载哪些文件。
 *
 * 新增内置字体：安装对应的 @fontsource 包，仿照下面再登记一个家族。
 */

const WEIGHTS = [400, 700];

// 这里只是拿到每个字体文件的地址，文件本身在用到时才下载
const interFiles = import.meta.glob<string>(
  '../../../node_modules/@fontsource/inter/files/inter-*-{400,700}-normal.woff2',
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

function buildFaces(prefix: string, ranges: Record<string, string>, files: Record<string, string>): FontFaceSource[] {
  const urls = new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
  const faces: FontFaceSource[] = [];
  for (const [key, range] of Object.entries(ranges)) {
    // fontsource 用 "[119]" 这样的键表示编号分片，文件名里是不带括号的 119
    const chunk = key.replace(/[[\]]/g, '');
    for (const weight of WEIGHTS) {
      const url = urls.get(`${prefix}-${chunk}-${weight}-normal.woff2`);
      if (!url) continue;
      faces.push({
        chunk,
        weight,
        ranges: parseUnicodeRange(range),
        load: async () => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        },
      });
    }
  }
  return faces;
}

export const DEFAULT_FONTS = { latin: 'Inter', cjk: 'Noto Sans SC' };

export function registerFonts(fonts: FontManager): void {
  fonts.addFamily({ name: 'Inter', faces: buildFaces('inter', interRanges, interFiles) });
  fonts.addFamily({ name: 'Noto Sans SC', faces: buildFaces('noto-sans-sc', notoRanges, notoFiles) });
}
