import { zipSync, type Zippable } from 'fflate';

/**
 * 把几个文件打包成一个 ZIP，比如一次导出好几个画板的 SVG。
 * 重名的文件在扩展名前面加上序号（"封面.svg"、"封面 2.svg"），不会互相覆盖。
 */
export function zipFiles(files: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  const entries: Zippable = {};
  const used = new Set<string>();
  for (const { name, bytes } of files) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let unique = name;
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${stem} ${n}${extension}`;
    used.add(unique.toLowerCase());
    entries[unique] = bytes;
  }
  return zipSync(entries, { level: 6 });
}
