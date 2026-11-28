import { FontFormatError, type SfntFont } from './sfnt';

/**
 * 从 TrueType 字体里读出字形的轮廓，用于把文字转成轮廓（导出 SVG 时可以选）。
 * 渲染引擎的默认构建取不到字形的路径，所以自己读 glyf 表。
 *
 * 返回的路径以字号为 1 个单位、y 向上，编码同导入器的路径数据（0 移动、1 直线、3 二次曲线、4 闭合），
 * 和从 PDF 导入的字形库是同一种格式。
 * 字体按不可信输入处理：数据越界时抛 FontFormatError；CFF 轮廓的字体（OpenType/CFF）不支持，同样抛错。
 */
export class GlyphOutlines {
  private readonly view: DataView;
  private readonly cache = new Map<number, number[]>();
  private readonly glyf: { offset: number; length: number };
  private readonly loca: { offset: number; length: number };
  private readonly longLoca: boolean;

  constructor(private readonly font: SfntFont) {
    if (font.outlines !== 'truetype') throw new FontFormatError('only TrueType outlines are supported');
    const { bytes, tables } = font;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.glyf = tables.get('glyf')!;
    this.loca = tables.get('loca')!;
    this.longLoca = this.view.getInt16(tables.get('head')!.offset + 50) === 1;
    if (this.loca.length < (font.numGlyphs + 1) * (this.longLoca ? 4 : 2)) throw new FontFormatError('bad loca');
  }

  /** 一个字形的轮廓；编号超出范围时是空的 */
  get(glyph: number): number[] {
    let outline = this.cache.get(glyph);
    if (!outline) {
      const points: Contour[] = [];
      this.collect(glyph, IDENTITY, points, 0);
      const scale = 1 / this.font.unitsPerEm;
      outline = [];
      for (const contour of points) appendContour(outline, contour, scale);
      this.cache.set(glyph, outline);
    }
    return outline;
  }

  private range(glyph: number): [number, number] {
    const { view, loca, longLoca } = this;
    const at = (i: number): number =>
      longLoca ? view.getUint32(loca.offset + i * 4) : view.getUint16(loca.offset + i * 2) * 2;
    const start = at(glyph);
    const end = at(glyph + 1);
    if (end < start || end > this.glyf.length) throw new FontFormatError('bad glyph offset');
    return [this.glyf.offset + start, this.glyf.offset + end];
  }

  /** 把一个字形的轮廓点（按变换 m 摆好）加进 out；复合字形递归展开它的部件 */
  private collect(glyph: number, m: Affine, out: Contour[], depth: number): void {
    if (glyph < 0 || glyph >= this.font.numGlyphs || depth > 8) return;
    const [start, end] = this.range(glyph);
    if (end - start < 10) return; // 空字形（比如空格）
    const { view } = this;
    const need = (at: number, size: number): void => {
      if (at + size > end) throw new FontFormatError('glyph data out of range');
    };
    const contours = view.getInt16(start);
    if (contours >= 0) {
      let at = start + 10;
      need(at, contours * 2 + 2);
      const ends: number[] = [];
      for (let i = 0; i < contours; i++) ends.push(view.getUint16(at + i * 2));
      at += contours * 2;
      const count = contours > 0 ? ends[contours - 1]! + 1 : 0;
      at += 2 + view.getUint16(at); // 跳过提示指令
      const flags = new Uint8Array(count);
      for (let i = 0; i < count;) {
        need(at, 1);
        const flag = view.getUint8(at++);
        flags[i++] = flag;
        if (flag & 0x08) {
          need(at, 1);
          let repeat = view.getUint8(at++);
          while (repeat-- > 0 && i < count) flags[i++] = flag;
        }
      }
      const xs = new Int32Array(count);
      const ys = new Int32Array(count);
      for (const [coords, short, same] of [
        [xs, 0x02, 0x10],
        [ys, 0x04, 0x20],
      ] as const) {
        let value = 0;
        for (let i = 0; i < count; i++) {
          const flag = flags[i]!;
          if (flag & short) {
            need(at, 1);
            const delta = view.getUint8(at++);
            value += flag & same ? delta : -delta;
          } else if (!(flag & same)) {
            need(at, 2);
            value += view.getInt16(at);
            at += 2;
          }
          coords[i] = value;
        }
      }
      let first = 0;
      for (const last of ends) {
        if (last < first || last >= count) throw new FontFormatError('bad contour');
        const contour: Contour = [];
        for (let i = first; i <= last; i++) {
          const x = xs[i]!;
          const y = ys[i]!;
          contour.push({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5], on: (flags[i]! & 1) !== 0 });
        }
        out.push(contour);
        first = last + 1;
      }
      return;
    }

    // 复合字形：由别的字形经过平移、缩放拼成
    let at = start + 10;
    for (;;) {
      need(at, 4);
      const flags = view.getUint16(at);
      const component = view.getUint16(at + 2);
      at += 4;
      let dx = 0;
      let dy = 0;
      if (flags & 0x0001) {
        need(at, 4);
        dx = flags & 0x0002 ? view.getInt16(at) : 0;
        dy = flags & 0x0002 ? view.getInt16(at + 2) : 0;
        at += 4;
      } else {
        need(at, 2);
        dx = flags & 0x0002 ? view.getInt8(at) : 0;
        dy = flags & 0x0002 ? view.getInt8(at + 1) : 0;
        at += 2;
      }
      // 没有 ARGS_ARE_XY_VALUES 时两个参数是对齐用的点号，极少见，按不平移处理
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      const f2dot14 = (offset: number): number => view.getInt16(offset) / 16384;
      if (flags & 0x0008) {
        need(at, 2);
        a = d = f2dot14(at);
        at += 2;
      } else if (flags & 0x0040) {
        need(at, 4);
        a = f2dot14(at);
        d = f2dot14(at + 2);
        at += 4;
      } else if (flags & 0x0080) {
        need(at, 8);
        a = f2dot14(at);
        b = f2dot14(at + 2);
        c = f2dot14(at + 4);
        d = f2dot14(at + 6);
        at += 8;
      }
      // 部件的变换：先按自己的矩阵缩放，再平移（偏移量不缩放，和 Windows、FreeType 的默认做法一致），最后套上外层的变换
      const local: Affine = [a, b, c, d, dx, dy];
      this.collect(component, compose(m, local), out, depth + 1);
      if (!(flags & 0x0020)) break;
    }
  }
}

type Affine = readonly [number, number, number, number, number, number];
type Contour = { x: number; y: number; on: boolean }[];

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

function compose(outer: Affine, inner: Affine): Affine {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

/**
 * 一圈 TrueType 轮廓点 → 路径。TrueType 的曲线都是二次的：两个相邻的控制点（不在曲线上的点）之间
 * 隐含一个在曲线上的点，就是它们的中点
 */
function appendContour(out: number[], contour: Contour, scale: number): void {
  const n = contour.length;
  if (n === 0) return;
  // 起点要在曲线上：第一个点在曲线上就从它开始，否则看最后一个点，都不在就取两者的中点
  const first = contour[0]!;
  const last = contour[n - 1]!;
  let start: { x: number; y: number };
  let from: number;
  if (first.on) {
    start = first;
    from = 1;
  } else if (last.on) {
    start = last;
    from = 0;
  } else {
    start = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
    from = 0;
  }
  out.push(0, start.x * scale, start.y * scale);
  let control: { x: number; y: number } | null = null;
  // 起点是最后一个点时，它不用再走一遍
  const end = !first.on && last.on ? n - 1 : n;
  for (let k = from; k < end; k++) {
    const point = contour[k]!;
    if (point.on) {
      if (control) out.push(3, control.x * scale, control.y * scale, point.x * scale, point.y * scale);
      else out.push(1, point.x * scale, point.y * scale);
      control = null;
    } else {
      if (control) {
        const mid = { x: (control.x + point.x) / 2, y: (control.y + point.y) / 2 };
        out.push(3, control.x * scale, control.y * scale, mid.x * scale, mid.y * scale);
      }
      control = point;
    }
  }
  // 回到起点
  if (control) out.push(3, control.x * scale, control.y * scale, start.x * scale, start.y * scale);
  out.push(4);
}
