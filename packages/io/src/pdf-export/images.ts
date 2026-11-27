import { pdfName, type PdfRef, type PdfWriter } from './objects';

/**
 * 往 PDF 里放图片。
 * JPEG 照片原样放进去（PDF 直接支持），不用解码再压缩，文件小、也不损失画质；
 * 其他图片解码成像素，颜色和透明度分成两张图存。
 */

/** 解码后的像素：RGBA，每像素 4 字节，透明度不预乘 */
export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
}

/**
 * 完全透明的像素换上离它最近的不透明像素的颜色（透明度不变，看不出来）。
 * PDF 阅读器缩放图片时颜色和透明度是分开插值的：透明处的颜色要是黑的，
 * 半透明的边缘就会混进黑色，出现一圈暗边。模糊过的图片、透明底的标志都会遇到。
 */
function bleedTransparent(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = Uint8Array.from(pixels);
  const count = width * height;
  const reached = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < count; i++) {
    if (out[i * 4 + 3] === 0) continue;
    reached[i] = 1;
    queue[tail++] = i;
  }
  // 从所有不透明的像素同时往外一圈圈扩散
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    const neighbors = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
    for (const n of neighbors) {
      if (n < 0 || n >= count || reached[n]) continue;
      reached[n] = 1;
      out[n * 4] = out[i * 4]!;
      out[n * 4 + 1] = out[i * 4 + 1]!;
      out[n * 4 + 2] = out[i * 4 + 2]!;
      queue[tail++] = n;
    }
  }
  return out;
}

/** 像素图片。有透明的地方时另存一张透明度蒙版；全是灰色时按灰度存，省三分之二 */
export function writeRgbaImage(writer: PdfWriter, image: RgbaImage): PdfRef {
  const { width, height } = image;
  const count = width * height;
  let opaque = true;
  let clear = false;
  for (let i = 0; i < count; i++) {
    const alpha = image.pixels[i * 4 + 3];
    if (alpha !== 255) opaque = false;
    if (alpha === 0) {
      clear = true;
      break;
    }
  }
  const pixels = clear ? bleedTransparent(image.pixels, width, height) : image.pixels;
  let gray = true;
  for (let i = 0; i < count && gray; i++) {
    const at = i * 4;
    if (pixels[at] !== pixels[at + 1] || pixels[at] !== pixels[at + 2]) gray = false;
  }

  const channels = gray ? 1 : 3;
  const color = new Uint8Array(count * channels);
  for (let i = 0; i < count; i++) {
    const at = i * 4;
    if (gray) color[i] = pixels[at]!;
    else {
      color[i * 3] = pixels[at]!;
      color[i * 3 + 1] = pixels[at + 1]!;
      color[i * 3 + 2] = pixels[at + 2]!;
    }
  }
  let mask: PdfRef | undefined;
  if (!opaque) {
    const alpha = new Uint8Array(count);
    for (let i = 0; i < count; i++) alpha[i] = pixels[i * 4 + 3]!;
    mask = writer.stream(
      {
        Type: pdfName('XObject'),
        Subtype: pdfName('Image'),
        Width: width,
        Height: height,
        ColorSpace: pdfName('DeviceGray'),
        BitsPerComponent: 8,
      },
      alpha,
    );
  }
  return writer.stream(
    {
      Type: pdfName('XObject'),
      Subtype: pdfName('Image'),
      Width: width,
      Height: height,
      ColorSpace: pdfName(gray ? 'DeviceGray' : 'DeviceRGB'),
      BitsPerComponent: 8,
      SMask: mask,
      Interpolate: true,
    },
    color,
  );
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  /** EXIF 里记的方向，1 是正常 */
  orientation: number;
}

/** 读 JPEG 的尺寸、颜色通道数和拍摄方向。不是 JPEG 或者读不懂时返回 null */
export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let orientation = 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    const length = view.getUint16(at + 2);
    const body = at + 4;
    if (marker === 0xe1 && length > 16) orientation = exifOrientation(view, body, body + length - 2) ?? orientation;
    // SOF0–SOF15 里除了 DHT(C4)、JPG(C8)、DAC(CC) 都是帧头
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (body + 6 > bytes.length) return null;
      return {
        height: view.getUint16(body + 1),
        width: view.getUint16(body + 3),
        components: bytes[body + 5]!,
        orientation,
      };
    }
    at += 2 + length;
  }
  return null;
}

function exifOrientation(view: DataView, start: number, end: number): number | null {
  // "Exif\0\0" 后面是一个 TIFF 文件头
  if (end - start < 14 || view.getUint32(start) !== 0x45786966) return null;
  const tiff = start + 6;
  const little = view.getUint16(tiff) === 0x4949;
  const u16 = (at: number): number => view.getUint16(at, little);
  const u32 = (at: number): number => view.getUint32(at, little);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

/**
 * 把 JPEG 原样放进 PDF。只处理灰度和 RGB、方向正常的：
 * CMYK 的 JPEG 各家软件存法不一致，带旋转方向的 PDF 阅读器不认，这两种返回 null，由调用方解码后再放。
 */
export function writeJpeg(writer: PdfWriter, bytes: Uint8Array): PdfRef | null {
  const info = jpegInfo(bytes);
  if (!info || info.orientation !== 1 || (info.components !== 1 && info.components !== 3)) return null;
  if (info.width < 1 || info.height < 1) return null;
  return writer.stream(
    {
      Type: pdfName('XObject'),
      Subtype: pdfName('Image'),
      Width: info.width,
      Height: info.height,
      ColorSpace: pdfName(info.components === 1 ? 'DeviceGray' : 'DeviceRGB'),
      BitsPerComponent: 8,
      Filter: pdfName('DCTDecode'),
      Interpolate: true,
    },
    bytes,
    { compress: false },
  );
}
