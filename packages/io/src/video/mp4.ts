/**
 * 把 H.264 编码结果封装成 MP4 文件（导出视频用）。编码由浏览器自带的编码器（WebCodecs）完成，这里只负责装箱。
 *
 * 写成"快速开始"的布局：ftyp、moov（索引）在前，mdat（数据）在后，播放器不用读完整个文件就能开始播。
 * 所有帧在 mdat 里连成一整块（一个 chunk），索引表因此很短。
 * 编码器可能会重排帧（B 帧）：帧按解码顺序交进来，各自带着显示时刻，这里据此写出解码时刻和显示偏移（ctts），
 * 需要时再用编辑表（elst）把第一帧对齐到 0。
 */

export interface Mp4Sample {
  /** 编码后的数据（AVCC 格式：每个 NAL 单元前面是 4 字节长度） */
  data: Uint8Array;
  /** 显示时刻，微秒 */
  timestamp: number;
  /** 时长，微秒 */
  duration: number;
  /** 关键帧 */
  key: boolean;
}

/** 媒体时间刻度：90 kHz，24、25、30、50、60 帧每秒的帧长都是整数 */
const TIMESCALE = 90_000;
/** 影片头里的时间刻度：毫秒 */
const MOVIE_TIMESCALE = 1000;

export class Mp4Writer {
  private readonly samples: Mp4Sample[] = [];
  private avcC: Uint8Array | null = null;

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {}

  /** 编码器给的解码配置（decoderConfig.description，就是 avcC 盒子的内容） */
  setDecoderConfig(description: Uint8Array): void {
    this.avcC = description.slice();
  }

  /** 按解码顺序（编码器输出的顺序）加一帧 */
  addSample(sample: Mp4Sample): void {
    this.samples.push(sample);
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  finish(): Uint8Array {
    const { samples } = this;
    if (samples.length === 0) throw new Error('no video samples');
    if (!this.avcC) throw new Error('missing decoder config');

    // 显示时刻换成媒体时间刻度；解码时刻取显示时刻排好序以后的序列，没有重排时两者完全相同
    const pts = samples.map((s) => Math.round((s.timestamp * TIMESCALE) / 1e6));
    const sorted = [...pts].sort((a, b) => a - b);
    const base = sorted[0]!;
    const dts = sorted.map((t) => t - base);
    // 显示偏移必须 ≥ 0：解码时刻整体往前挪 shift，再用编辑表把显示的起点挪回来
    let shift = 0;
    for (let i = 0; i < samples.length; i++) shift = Math.max(shift, dts[i]! - (pts[i]! - base));
    const offsets = pts.map((t, i) => t - base - dts[i]! + shift);
    const reordered = offsets.some((o) => o !== 0);

    const lastDuration = Math.max(1, Math.round((samples[samples.length - 1]!.duration * TIMESCALE) / 1e6));
    const deltas = dts.map((t, i) => (i + 1 < dts.length ? dts[i + 1]! - t : lastDuration));
    const mediaDuration = dts[dts.length - 1]! + lastDuration;
    const movieDuration = Math.round((mediaDuration * MOVIE_TIMESCALE) / TIMESCALE);

    const payload = samples.reduce((sum, s) => sum + s.data.length, 0);
    const large = payload + 16 > 0xffffffff;
    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));

    const moov = (chunkOffset: number): Uint8Array => {
      const stbl = box(
        'stbl',
        this.stsd(),
        table('stts', runLength(deltas)),
        reordered ? table('ctts', runLength(offsets)) : new Uint8Array(0),
        samples.every((s) => s.key)
          ? new Uint8Array(0)
          : fullBox(
              'stss',
              0,
              0,
              u32(samples.filter((s) => s.key).length),
              ...samples.flatMap((s, i) => (s.key ? [u32(i + 1)] : [])),
            ),
        // 一整块：第 1 块里有全部的帧
        fullBox('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
        fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))),
        large ? fullBox('co64', 0, 0, u32(1), u64(chunkOffset)) : fullBox('stco', 0, 0, u32(1), u32(chunkOffset)),
      );
      const minf = box(
        'minf',
        fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stbl,
      );
      const mdia = box(
        'mdia',
        fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(mediaDuration), u16(0x55c4), u16(0)),
        fullBox('hdlr', 0, 0, u32(0), ascii('vide'), u32(0), u32(0), u32(0), ascii('VideoHandler\0')),
        minf,
      );
      const edts =
        shift > 0
          ? box('edts', fullBox('elst', 0, 0, u32(1), u32(movieDuration), u32(shift), u32(0x00010000)))
          : new Uint8Array(0);
      const trak = box(
        'trak',
        fullBox(
          'tkhd',
          0,
          3, // 启用、在影片里
          u32(0),
          u32(0),
          u32(1),
          u32(0),
          u32(movieDuration),
          u32(0),
          u32(0),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          MATRIX,
          u32(this.width * 65536),
          u32(this.height * 65536),
        ),
        edts,
        mdia,
      );
      const mvhd = fullBox(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(MOVIE_TIMESCALE),
        u32(movieDuration),
        u32(0x00010000),
        u16(0x0100),
        u16(0),
        u32(0),
        u32(0),
        MATRIX,
        new Uint8Array(24),
        u32(2),
      );
      return box('moov', mvhd, trak);
    };

    // moov 的大小和里面写的偏移量无关，先用 0 量出大小，再算出 mdat 数据的真实位置
    const header = large ? 16 : 8;
    const chunkOffset = ftyp.length + moov(0).length + header;
    const moovBytes = moov(chunkOffset);
    const out = new Uint8Array(chunkOffset + payload);
    out.set(ftyp, 0);
    out.set(moovBytes, ftyp.length);
    const view = new DataView(out.buffer);
    let at = ftyp.length + moovBytes.length;
    if (large) {
      view.setUint32(at, 1);
      out.set(ascii('mdat'), at + 4);
      view.setBigUint64(at + 8, BigInt(payload + 16));
    } else {
      view.setUint32(at, payload + 8);
      out.set(ascii('mdat'), at + 4);
    }
    at += header;
    for (const sample of samples) {
      out.set(sample.data, at);
      at += sample.data.length;
    }
    return out;
  }

  /** 帧的格式说明：H.264（avc1），带上编码器给的 avcC */
  private stsd(): Uint8Array {
    const name = new Uint8Array(32);
    const label = 'ShibaDesign';
    name[0] = label.length;
    name.set(ascii(label), 1);
    const avc1 = box(
      'avc1',
      new Uint8Array(6),
      u16(1), // 数据引用编号
      u16(0),
      u16(0),
      new Uint8Array(12),
      u16(this.width),
      u16(this.height),
      u32(0x00480000), // 72 dpi
      u32(0x00480000),
      u32(0),
      u16(1), // 每个样本一帧
      name,
      u16(0x0018), // 24 位色深
      u16(0xffff),
      box('avcC', this.avcC!),
    );
    return fullBox('stsd', 0, 0, u32(1), avc1);
  }
}

const MATRIX = concat(
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);

/** 一串数压成（个数，值）对，stts 和 ctts 都是这种表 */
function runLength(values: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === value) last[0]++;
    else runs.push([1, value]);
  }
  return runs;
}

function table(type: string, runs: [number, number][]): Uint8Array {
  return fullBox(type, 0, 0, u32(runs.length), ...runs.flatMap(([count, value]) => [u32(count), u32(value)]));
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(u32(body.length + 8), ascii(type), body);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...parts);
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
