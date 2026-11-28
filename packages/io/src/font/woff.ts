import { zlibSync } from 'fflate';
import { FontFormatError } from './sfnt';

/**
 * 把 TrueType / OpenType 字体文件封装成 WOFF（1.0）：每张表单独用 zlib 压缩，内容和原文件一模一样。
 * 导出 SVG、网页时用它内嵌字体，比原样内嵌小一半左右。
 * 浏览器都认 WOFF2，但 WOFF2 的压缩要带一个很大的编码器，WOFF 用现成的 zlib 就行。
 */
export function toWoff(sfnt: Uint8Array): Uint8Array {
  if (sfnt.length < 12) throw new FontFormatError('font too short');
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const flavor = view.getUint32(0);
  const count = view.getUint16(4);
  const tables: { tag: number; checksum: number; original: number; data: Uint8Array }[] = [];
  let sfntSize = 12 + count * 16;
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > sfnt.length) throw new FontFormatError('bad table directory');
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > sfnt.length) throw new FontFormatError('table out of range');
    const raw = sfnt.subarray(offset, offset + length);
    const packed = zlibSync(raw, { level: 9 });
    // 压缩后反而更大时原样存，这是 WOFF 规定的写法
    tables.push({
      tag: view.getUint32(at),
      checksum: view.getUint32(at + 4),
      original: length,
      data: packed.length < length ? packed : raw,
    });
    sfntSize += (length + 3) & ~3;
  }
  // 表目录按标签排序
  tables.sort((a, b) => a.tag - b.tag);

  let total = 44 + count * 20;
  for (const table of tables) total += (table.data.length + 3) & ~3;
  const out = new Uint8Array(total);
  const w = new DataView(out.buffer);
  w.setUint32(0, 0x774f4646); // 'wOFF'
  w.setUint32(4, flavor);
  w.setUint32(8, total);
  w.setUint16(12, count);
  w.setUint32(16, sfntSize);
  w.setUint16(20, 1); // 版本号随便填，阅读器不看
  let offset = 44 + count * 20;
  tables.forEach((table, i) => {
    const at = 44 + i * 20;
    w.setUint32(at, table.tag);
    w.setUint32(at + 4, offset);
    w.setUint32(at + 8, table.data.length);
    w.setUint32(at + 12, table.original);
    w.setUint32(at + 16, table.checksum);
    out.set(table.data, offset);
    offset += (table.data.length + 3) & ~3;
  });
  return out;
}
