import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { GifWriter, Mp4Writer } from '@shiba/io';
import { loadCanvasKit, type CanvasKit } from '../src';

const require = createRequire(import.meta.url);
let ck: CanvasKit;

beforeAll(async () => {
  ck = await loadCanvasKit(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
});

/** 用 Skia 的 GIF 解码器把每一帧读出来（合成好的整张画面）和它的停留时间 */
function decodeGif(bytes: Uint8Array): { frames: Uint8Array[]; durations: number[]; width: number; height: number } {
  const animated = ck.MakeAnimatedImageFromEncoded(bytes)!;
  expect(animated).toBeTruthy();
  const frames: Uint8Array[] = [];
  const durations: number[] = [];
  const count = animated.getFrameCount();
  for (let i = 0; i < count; i++) {
    const image = animated.makeImageAtCurrentFrame()!;
    frames.push(
      image.readPixels(0, 0, {
        width: image.width(),
        height: image.height(),
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      }) as Uint8Array,
    );
    image.delete();
    durations.push(animated.currentFrameDuration());
    animated.decodeNextFrame();
  }
  const result = { frames, durations, width: animated.width(), height: animated.height() };
  animated.delete();
  return result;
}

function frame(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      out.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return out;
}

/** 两张画面每个像素差多少（RGB 三个通道的最大差）的平均值和最大值 */
function difference(a: Uint8Array, b: Uint8Array): { mean: number; max: number } {
  let sum = 0;
  let max = 0;
  const n = a.length / 4;
  for (let i = 0; i < n; i++) {
    const d = Math.max(
      Math.abs(a[i * 4]! - b[i * 4]!),
      Math.abs(a[i * 4 + 1]! - b[i * 4 + 1]!),
      Math.abs(a[i * 4 + 2]! - b[i * 4 + 2]!),
    );
    sum += d;
    max = Math.max(max, d);
  }
  return { mean: sum / n, max };
}

/** 按 size × size 的小块取平均色，得到一张缩小的画面 */
function blockAverage(rgba: Uint8Array, width: number, height: number, size: number): Uint8Array {
  const w = Math.floor(width / size);
  const h = Math.floor(height / size);
  const out = new Uint8Array(w * h * 4);
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) sum += rgba[((by * size + y) * width + bx * size + x) * 4 + c]!;
        out[(by * w + bx) * 4 + c] = Math.round(sum / (size * size));
      }
      out[(by * w + bx) * 4 + 3] = 255;
    }
  }
  return out;
}

describe('GIF 编码', () => {
  it('纯色画面原样保留；和上一帧一样的帧并进上一帧；之后只写变了的部分，其余透出上一帧', () => {
    const [w, h] = [40, 30];
    const flat = frame(w, h, (x) => (x < 20 ? [255, 0, 0] : [0, 0, 255]));
    const moved = frame(w, h, (x, y) =>
      x >= 5 && x < 10 && y >= 5 && y < 10 ? [0, 200, 0] : x < 20 ? [255, 0, 0] : [0, 0, 255],
    );
    const writer = new GifWriter(w, h);
    writer.addFrame(flat, 100);
    writer.addFrame(flat, 100);
    writer.addFrame(moved, 150);
    const bytes = writer.finish();
    const decoded = decodeGif(bytes);
    expect([decoded.width, decoded.height]).toEqual([w, h]);
    expect(decoded.frames).toHaveLength(2);
    expect(decoded.durations).toEqual([200, 150]);
    expect(difference(decoded.frames[0]!, flat).max).toBe(0);
    expect(difference(decoded.frames[1]!, moved).max).toBe(0);
    // 第二帧只有 5 × 5 的方块，文件很小
    expect(bytes.length).toBeLessThan(300);
  });

  it('颜色多的画面（渐变）用中位切分的调色板加抖动，和原图很接近', () => {
    const [w, h] = [96, 64];
    const gradient = frame(w, h, (x, y) => [Math.round((x / (w - 1)) * 255), Math.round((y / (h - 1)) * 255), 128]);
    const writer = new GifWriter(w, h);
    writer.addFrame(gradient, 66.7);
    writer.addFrame(gradient, 66.7);
    writer.addFrame(gradient, 66.6);
    const decoded = decodeGif(writer.finish());
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.durations[0]).toBe(200);
    // 抖动让单个像素有偏差，但局部的平均颜色和原图一致：按 8 × 8 的小块比平均色（最边上的纯色调色板够不到，差得多一点）
    const { max } = difference(decoded.frames[0]!, gradient);
    expect(max).toBeLessThan(40);
    expect(difference(blockAverage(decoded.frames[0]!, w, h, 8), blockAverage(gradient, w, h, 8)).max).toBeLessThan(5);
  });

  it('停留时间按累计时刻取整，15 帧每秒不会越积越偏', () => {
    const [w, h] = [8, 8];
    const writer = new GifWriter(w, h);
    for (let i = 0; i < 15; i++)
      writer.addFrame(
        frame(w, h, () => [i * 10, 0, 0]),
        1000 / 15,
      );
    const decoded = decodeGif(writer.finish());
    expect(decoded.frames).toHaveLength(15);
    expect(decoded.durations.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

/** 读 MP4 的盒子结构：类型 → 内容（容器盒子递归展开） */
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): { type: string; start: number; size: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { type: string; start: number; size: number }[] = [];
  for (let at = start; at < end;) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size === 1) size = Number(view.getBigUint64(at + 8));
    out.push({ type, start: at, size });
    at += size;
  }
  return out;
}

function find(bytes: Uint8Array, path: string[]): { start: number; size: number } {
  let start = 0;
  let end = bytes.length;
  let found = { start: 0, size: bytes.length };
  for (const [i, type] of path.entries()) {
    const box = boxes(bytes, start, end).find((b) => b.type === type);
    if (!box) throw new Error(`missing ${path.slice(0, i + 1).join('/')}`);
    found = box;
    // stsd 的子盒子前面有 4 字节的版本和 4 字节的个数；avc1 前面是 78 字节的固定字段
    const skip = type === 'stsd' ? 16 : type === 'avc1' ? 86 : type === 'dref' ? 16 : 8;
    start = box.start + skip;
    end = box.start + box.size;
  }
  return found;
}

describe('MP4 封装', () => {
  const avcC = new Uint8Array([
    1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80,
  ]);
  const sample = (i: number, timestamp: number, key: boolean) => ({
    data: new Uint8Array([0, 0, 0, 2, 0x65 + i, i]),
    timestamp,
    duration: 33_333,
    key,
  });

  it('索引在前、数据在后，所有帧连成一块，偏移量指向数据的开头', () => {
    const writer = new Mp4Writer(1920, 1080);
    writer.setDecoderConfig(avcC);
    for (let i = 0; i < 90; i++) writer.addSample(sample(i, Math.round((i * 1e6) / 30), i % 60 === 0));
    const bytes = writer.finish();
    const view = new DataView(bytes.buffer);
    expect(boxes(bytes).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);

    const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl'];
    const stco = find(bytes, [...stbl, 'stco']);
    const mdat = find(bytes, ['mdat']);
    expect(view.getUint32(stco.start + 16)).toBe(mdat.start + 8);
    // 第一帧的数据
    expect([...bytes.subarray(mdat.start + 8, mdat.start + 14)]).toEqual([0, 0, 0, 2, 0x65, 0]);

    const stsz = find(bytes, [...stbl, 'stsz']);
    expect(view.getUint32(stsz.start + 16)).toBe(90);
    // 关键帧是第 1、61 帧
    const stss = find(bytes, [...stbl, 'stss']);
    expect([view.getUint32(stss.start + 12), view.getUint32(stss.start + 16), view.getUint32(stss.start + 20)]).toEqual(
      [2, 1, 61],
    );
    // 恒定帧率：每帧 3000（90 kHz）
    const stts = find(bytes, [...stbl, 'stts']);
    expect(view.getUint32(stts.start + 12)).toBe(1);
    expect([view.getUint32(stts.start + 16), view.getUint32(stts.start + 20)]).toEqual([90, 3000]);
    expect(() => find(bytes, [...stbl, 'ctts'])).toThrow();
    // 时长 3 秒；画面大小写在 tkhd 和 avc1 里，avcC 原样放进去
    const mvhd = find(bytes, ['moov', 'mvhd']);
    expect(view.getUint32(mvhd.start + 24)).toBe(3000);
    const tkhd = find(bytes, ['moov', 'trak', 'tkhd']);
    expect([view.getUint32(tkhd.start + 84) / 65536, view.getUint32(tkhd.start + 88) / 65536]).toEqual([1920, 1080]);
    const avcCBox = find(bytes, [...stbl, 'stsd', 'avc1', 'avcC']);
    expect([...bytes.subarray(avcCBox.start + 8, avcCBox.start + avcCBox.size)]).toEqual([...avcC]);
  });

  it('编码器重排了帧（B 帧）时写出显示偏移，用编辑表把第一帧对齐到 0', () => {
    const writer = new Mp4Writer(640, 360);
    writer.setDecoderConfig(avcC);
    // 解码顺序 I0 P3 B1 B2
    const frame = 1e6 / 30;
    [0, 3, 1, 2].forEach((n, i) => writer.addSample(sample(i, Math.round(n * frame), i === 0)));
    const bytes = writer.finish();
    const view = new DataView(bytes.buffer);
    const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl'];
    const ctts = find(bytes, [...stbl, 'ctts']);
    const entries: number[] = [];
    for (let i = 0; i < view.getUint32(ctts.start + 12); i++) {
      const count = view.getUint32(ctts.start + 16 + i * 8);
      const offset = view.getUint32(ctts.start + 20 + i * 8);
      for (let k = 0; k < count; k++) entries.push(offset);
    }
    // 解码时刻 0、3000、6000、9000，加上偏移以后的显示时刻都往后挪了 3000
    expect(entries).toEqual([3000, 9000, 0, 0]);
    const elst = find(bytes, ['moov', 'trak', 'edts', 'elst']);
    expect(view.getUint32(elst.start + 20)).toBe(3000);
  });
});
