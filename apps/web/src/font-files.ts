/**
 * 内置字体的 WOFF 版本，导出 PDF 时嵌进文件用。
 *
 * 画布上用的是更小的 WOFF2；但 WOFF2 的解压要带一个很大的解码器，WOFF 用现成的 zlib 就能解开。
 * 两个版本是同一份字体，字形编号完全一样。
 * 这个模块只在导出 PDF 时才加载：几百个文件的地址表本身就有几十 KB，不该占首屏。
 */

// 选项必须直接写成对象字面量：Vite 在构建时静态分析这些调用，不认变量
const files = import.meta.glob<string>(
  [
    '../../../node_modules/@fontsource/{inter,arimo,tinos,cousine}/files/*-{400,700}-{normal,italic}.woff',
    '../../../node_modules/@fontsource/{noto-sans-sc,noto-serif-sc}/files/*-{400,700}-normal.woff',
    '!**/*-chinese-simplified-*',
  ],
  { query: '?url', import: 'default', eager: true },
);

const urls = new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

/** 某个字体文件（比如 "inter-latin-400-normal.woff"）的下载地址 */
export function embeddableUrl(name: string): string | undefined {
  return urls.get(name);
}
