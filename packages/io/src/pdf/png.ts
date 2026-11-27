import { zlibSync } from 'fflate';

/**
 * 一个最小的 PNG 编码器。
 *
 * PDF 里的图片解码出来是裸像素，要存进资源库得先编码成一种图片格式。
 * 自己编码而不借用浏览器的画布，是为了让导入器不依赖运行环境——在测试和命令行里也能跑。
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** PNG 的颜色类型：灰度、RGB、RGBA */
const COLOR_TYPES = { 1: 0, 3: 2, 4: 6 } as const;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 把像素编码成 PNG。pixels 按行从上到下排列，每像素 channels 个字节：
 * 1 是灰度，3 是 RGB，4 是 RGBA（透明度不预乘）。
 */
export function encodePng(
  width: number,
  height: number,
  pixels: Uint8Array | Uint8ClampedArray,
  channels: 1 | 3 | 4,
): Uint8Array {
  const stride = width * channels;
  if (width < 1 || height < 1 || pixels.length < stride * height) throw new Error('bad image size');

  // 每行前面加一个滤波类型字节。用"上"滤波（每个字节减去正上方的字节）：
  // 一趟就能算完，对照片和大片纯色都比不滤波压得小
  const raw = new Uint8Array((stride + 1) * height);
  let out = 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[out++] = 2;
    if (y === 0) {
      raw.set(pixels.subarray(0, stride), out);
      out += stride;
    } else {
      for (let i = 0; i < stride; i++) raw[out++] = pixels[row + i]! - pixels[row - stride + i]!;
    }
  }
  // 大图用低一档的压缩级别，换来快好几倍的速度
  const data = zlibSync(raw, { level: raw.length > 16_000_000 ? 3 : 6 });

  const png = new Uint8Array(8 + 25 + 12 + data.length + 12);
  const view = new DataView(png.buffer);
  png.set(SIGNATURE, 0);
  let at = 8;
  const chunk = (type: string, length: number, write: (offset: number) => void): void => {
    view.setUint32(at, length);
    for (let i = 0; i < 4; i++) png[at + 4 + i] = type.charCodeAt(i);
    write(at + 8);
    view.setUint32(at + 8 + length, crc32(png, at + 4, at + 8 + length));
    at += 12 + length;
  };
  chunk('IHDR', 13, (offset) => {
    view.setUint32(offset, width);
    view.setUint32(offset + 4, height);
    png[offset + 8] = 8; // 每个通道 8 位
    png[offset + 9] = COLOR_TYPES[channels];
  });
  chunk('IDAT', data.length, (offset) => png.set(data, offset));
  chunk('IEND', 0, () => {});
  return png;
}
