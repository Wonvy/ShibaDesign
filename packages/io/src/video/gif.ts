/**
 * GIF 动图编码（导出视频时可选）。输入一帧帧的 RGBA 像素，输出 GIF89a 文件。
 *
 * 幻灯片的画面大部分时间是静止的，所以：
 * - 和上一帧完全一样的帧不另写，把上一帧的停留时间加长；
 * - 之后的每一帧只写变了的那个矩形，矩形里没变的像素写成透明，露出上一帧——静止的部分永远不会重新量化，不会闪；
 * - 每一帧有自己的调色板（中位切分，最多 255 色，留一个给透明），用误差扩散抖动，渐变不会出现明显的色带。
 *   帧里不超过 255 种颜色时直接用这些颜色，不抖动，纯色的画面保持干净。
 */

export interface GifOptions {
  /** 循环次数，0 表示无限循环（默认） */
  loop?: number;
}

interface EncodedFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 本地调色板（RGB），长度是 2 的幂 × 3 */
  palette: Uint8Array;
  /** 透明色的序号，没有时为 -1 */
  transparent: number;
  /** LZW 压缩后的数据（不含分块） */
  data: Uint8Array;
  minCodeSize: number;
  /** 开始时刻，毫秒 */
  start: number;
}

export class GifWriter {
  private readonly frames: EncodedFrame[] = [];
  private previous: Uint8Array | null = null;
  /** 已经加进来的总时长，毫秒 */
  private time = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly options: GifOptions = {},
  ) {
    if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('bad GIF size');
  }

  /**
   * 加一帧
   * @param rgba 整个画面的像素，width × height × 4（透明度忽略，按不透明处理）
   * @param duration 这一帧显示多久，毫秒
   */
  addFrame(rgba: Uint8Array | Uint8ClampedArray, duration: number): void {
    const { width, height } = this;
    if (rgba.length < width * height * 4) throw new Error('frame too small');
    const start = this.time;
    this.time += duration;
    const previous = this.previous;
    let x0 = 0;
    let y0 = 0;
    let x1 = width - 1;
    let y1 = height - 1;
    if (previous) {
      // 变了的像素的外框；完全没变就只是让上一帧多停一会儿
      x0 = width;
      y0 = height;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < height; y++) {
        let row = y * width * 4;
        for (let x = 0; x < width; x++, row += 4) {
          if (
            rgba[row] !== previous[row] ||
            rgba[row + 1] !== previous[row + 1] ||
            rgba[row + 2] !== previous[row + 2]
          ) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
          }
        }
      }
      if (x1 < 0) return;
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    // 矩形里的像素，没变的标成透明
    const pixels = new Uint8Array(w * h * 3);
    const changed = new Uint8Array(w * h);
    let transparentNeeded = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = ((y + y0) * width + x + x0) * 4;
        const dst = y * w + x;
        pixels[dst * 3] = rgba[src]!;
        pixels[dst * 3 + 1] = rgba[src + 1]!;
        pixels[dst * 3 + 2] = rgba[src + 2]!;
        const same =
          previous !== null &&
          rgba[src] === previous[src] &&
          rgba[src + 1] === previous[src + 1] &&
          rgba[src + 2] === previous[src + 2];
        changed[dst] = same ? 0 : 1;
        if (same) transparentNeeded = true;
      }
    }
    this.previous = rgba.slice() as Uint8Array;

    const { palette, indices, transparent } = quantize(pixels, changed, w, h, transparentNeeded);
    const bits = Math.max(1, Math.ceil(Math.log2(palette.length / 3)));
    const table = new Uint8Array((1 << bits) * 3);
    table.set(palette);
    const minCodeSize = Math.max(2, bits);
    this.frames.push({
      x: x0,
      y: y0,
      width: w,
      height: h,
      palette: table,
      transparent,
      data: lzw(indices, minCodeSize),
      minCodeSize,
      start,
    });
  }

  finish(): Uint8Array {
    if (this.frames.length === 0) throw new Error('no GIF frames');
    const out = new ByteWriter();
    out.ascii('GIF89a');
    out.u16(this.width);
    out.u16(this.height);
    out.bytes([0, 0, 0]); // 没有全局调色板
    // 循环播放（NETSCAPE2.0 扩展）
    out.bytes([0x21, 0xff, 0x0b]);
    out.ascii('NETSCAPE2.0');
    out.bytes([0x03, 0x01]);
    out.u16(this.options.loop ?? 0);
    out.bytes([0x00]);

    // 停留时间以百分之一秒为单位；按累计时刻取整再相减，不会越积越偏
    const centis = (ms: number): number => Math.round(ms / 10);
    this.frames.forEach((frame, i) => {
      const end = i + 1 < this.frames.length ? this.frames[i + 1]!.start : this.time;
      const delay = Math.min(65535, Math.max(1, centis(end) - centis(frame.start)));
      // 图形控制扩展：处理方式 1（留着这一帧，下一帧画在上面）、透明色
      out.bytes([0x21, 0xf9, 0x04, (1 << 2) | (frame.transparent >= 0 ? 1 : 0)]);
      out.u16(delay);
      out.bytes([Math.max(0, frame.transparent), 0x00]);
      out.bytes([0x2c]);
      out.u16(frame.x);
      out.u16(frame.y);
      out.u16(frame.width);
      out.u16(frame.height);
      const bits = Math.log2(frame.palette.length / 3);
      out.bytes([0x80 | (bits - 1)]);
      out.bytes(frame.palette);
      out.bytes([frame.minCodeSize]);
      for (let at = 0; at < frame.data.length; at += 255) {
        const block = frame.data.subarray(at, at + 255);
        out.bytes([block.length]);
        out.bytes(block);
      }
      out.bytes([0x00]);
    });
    out.bytes([0x3b]);
    return out.result();
  }
}

// ───────────── 调色板 ─────────────

/**
 * 给一块像素挑调色板并换成序号。changed 为 0 的像素写成透明色（序号放在最后）。
 * 颜色不超过 255 种时原样用；否则中位切分出 255 色，用误差扩散抖动
 */
function quantize(
  pixels: Uint8Array,
  changed: Uint8Array,
  width: number,
  height: number,
  transparentNeeded: boolean,
): { palette: Uint8Array; indices: Uint8Array; transparent: number } {
  const count = width * height;
  const indices = new Uint8Array(count);

  // 先看颜色够不够少
  const exact = new Map<number, number>();
  for (let i = 0; i < count && exact.size <= 255; i++) {
    if (!changed[i]) continue;
    const key = (pixels[i * 3]! << 16) | (pixels[i * 3 + 1]! << 8) | pixels[i * 3 + 2]!;
    if (!exact.has(key)) exact.set(key, exact.size);
  }
  if (exact.size <= 255) {
    const colors = exact.size;
    const transparent = transparentNeeded ? colors : -1;
    const palette = new Uint8Array(Math.max(2, colors + (transparentNeeded ? 1 : 0)) * 3);
    for (const [key, index] of exact) {
      palette[index * 3] = key >> 16;
      palette[index * 3 + 1] = (key >> 8) & 0xff;
      palette[index * 3 + 2] = key & 0xff;
    }
    for (let i = 0; i < count; i++) {
      if (!changed[i]) indices[i] = transparent;
      else indices[i] = exact.get((pixels[i * 3]! << 16) | (pixels[i * 3 + 1]! << 8) | pixels[i * 3 + 2]!)!;
    }
    return { palette, indices, transparent };
  }

  const palette = medianCut(pixels, changed, 255);
  const colors = palette.length / 3;
  const transparent = transparentNeeded ? colors : -1;
  const full = new Uint8Array((colors + (transparentNeeded ? 1 : 0)) * 3);
  full.set(palette);

  // 最近色按 15 位颜色缓存
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r: number, g: number, b: number): number => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let found = cache[key]!;
    if (found >= 0) return found;
    let best = Infinity;
    for (let p = 0; p < colors; p++) {
      const dr = palette[p * 3]! - r;
      const dg = palette[p * 3 + 1]! - g;
      const db = palette[p * 3 + 2]! - b;
      const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
      if (d < best) {
        best = d;
        found = p;
      }
    }
    cache[key] = found;
    return found;
  };

  // Floyd–Steinberg 误差扩散，只在变了的像素之间传递
  const error = new Float32Array((width + 2) * 2 * 3);
  const row = (y: number): number => (y & 1) * (width + 2) * 3;
  for (let y = 0; y < height; y++) {
    const current = row(y);
    const next = row(y + 1);
    error.fill(0, next, next + (width + 2) * 3);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!changed[i]) {
        indices[i] = transparent;
        continue;
      }
      const e = current + (x + 1) * 3;
      const r = clamp(pixels[i * 3]! + error[e]!);
      const g = clamp(pixels[i * 3 + 1]! + error[e + 1]!);
      const b = clamp(pixels[i * 3 + 2]! + error[e + 2]!);
      const index = nearest(r, g, b);
      indices[i] = index;
      const er = r - palette[index * 3]!;
      const eg = g - palette[index * 3 + 1]!;
      const eb = b - palette[index * 3 + 2]!;
      const spread = (at: number, weight: number): void => {
        error[at] = error[at]! + er * weight;
        error[at + 1] = error[at + 1]! + eg * weight;
        error[at + 2] = error[at + 2]! + eb * weight;
      };
      spread(e + 3, 7 / 16);
      spread(next + x * 3, 3 / 16);
      spread(next + (x + 1) * 3, 5 / 16);
      spread(next + (x + 2) * 3, 1 / 16);
    }
  }
  return { palette: full, indices, transparent };
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** 中位切分：在 15 位颜色的直方图上反复把颜色最分散的那一盒从中位数处切开，每盒取平均色 */
function medianCut(pixels: Uint8Array, changed: Uint8Array, maxColors: number): Uint8Array {
  const counts = new Uint32Array(32768);
  const sums = new Float64Array(32768 * 3);
  for (let i = 0; i < changed.length; i++) {
    if (!changed[i]) continue;
    const r = pixels[i * 3]!;
    const g = pixels[i * 3 + 1]!;
    const b = pixels[i * 3 + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    counts[key]!++;
    sums[key * 3] = sums[key * 3]! + r;
    sums[key * 3 + 1] = sums[key * 3 + 1]! + g;
    sums[key * 3 + 2] = sums[key * 3 + 2]! + b;
  }
  const bins: number[] = [];
  for (let key = 0; key < 32768; key++) if (counts[key]) bins.push(key);
  const channel = (key: number, c: number): number => (key >> (10 - c * 5)) & 31;

  interface Box {
    bins: number[];
    population: number;
    /** 最分散的通道和它的跨度 */
    axis: number;
    range: number;
  }
  const makeBox = (list: number[]): Box => {
    let population = 0;
    const min = [31, 31, 31];
    const max = [0, 0, 0];
    for (const key of list) {
      population += counts[key]!;
      for (let c = 0; c < 3; c++) {
        const v = channel(key, c);
        if (v < min[c]!) min[c] = v;
        if (v > max[c]!) max[c] = v;
      }
    }
    // 人眼对绿色最敏感，跨度按亮度权重放大
    const weights = [3, 4, 2];
    let axis = 0;
    let range = -1;
    for (let c = 0; c < 3; c++) {
      const r = (max[c]! - min[c]!) * weights[c]!;
      if (r > range) {
        range = r;
        axis = c;
      }
    }
    return { bins: list, population, axis, range };
  };

  const boxes: Box[] = [makeBox(bins)];
  while (boxes.length < maxColors) {
    // 优先切人多又分散的盒子
    let pick = -1;
    let score = 0;
    boxes.forEach((box, i) => {
      if (box.bins.length < 2 || box.range <= 0) return;
      const s = box.range * Math.sqrt(box.population);
      if (s > score) {
        score = s;
        pick = i;
      }
    });
    if (pick < 0) break;
    const box = boxes[pick]!;
    const sorted = [...box.bins].sort((a, b) => channel(a, box.axis) - channel(b, box.axis));
    let half = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      half += counts[sorted[i]!]!;
      cut = i + 1;
      if (half * 2 >= box.population) break;
    }
    boxes.splice(pick, 1, makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut)));
  }

  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const key of box.bins) {
      r += sums[key * 3]!;
      g += sums[key * 3 + 1]!;
      b += sums[key * 3 + 2]!;
    }
    const n = Math.max(1, box.population);
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(b / n);
  });
  return palette;
}

// ───────────── LZW ─────────────

/** GIF 的变长 LZW 压缩 */
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const out = new ByteWriter();
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  // 字典：(前缀码 << 8 | 字符) → 码，开放寻址的散列表
  const SIZE = 5003 * 2;
  const keys = new Int32Array(SIZE).fill(-1);
  const values = new Int16Array(SIZE);
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.byte(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  const reset = (): void => {
    keys.fill(-1);
    codeSize = minCodeSize + 1;
    next = end + 1;
  };

  emit(clear);
  if (indices.length === 0) {
    emit(end);
    if (bitCount > 0) out.byte(bitBuffer & 0xff);
    return out.result();
  }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const char = indices[i]!;
    const key = (prefix << 8) | char;
    let slot = (key * 2654435761) >>> 0;
    slot %= SIZE;
    let found = -1;
    while (keys[slot] !== -1) {
      if (keys[slot] === key) {
        found = values[slot]!;
        break;
      }
      slot = (slot + 1) % SIZE;
    }
    if (found >= 0) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      keys[slot] = key;
      values[slot] = next;
      // 码长在下一个码用到新长度之前加一
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
      next++;
    } else {
      emit(clear);
      reset();
    }
    prefix = char;
  }
  emit(prefix);
  emit(end);
  if (bitCount > 0) out.byte(bitBuffer & 0xff);
  return out.result();
}

class ByteWriter {
  private buffer = new Uint8Array(4096);
  private length = 0;

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  byte(value: number): void {
    this.reserve(1);
    this.buffer[this.length++] = value;
  }

  bytes(values: ArrayLike<number>): void {
    this.reserve(values.length);
    this.buffer.set(values, this.length);
    this.length += values.length;
  }

  u16(value: number): void {
    this.byte(value & 0xff);
    this.byte((value >> 8) & 0xff);
  }

  ascii(text: string): void {
    for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i));
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}
