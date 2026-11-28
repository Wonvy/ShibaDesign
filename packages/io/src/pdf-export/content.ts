import type { Color, Matrix } from '@shiba/core';
import { CLOSE, CUBIC, LINE, MOVE, QUAD, type PathData } from '../pdf/ir';
import { formatNumber, latin1 } from './objects';

const n = formatNumber;

/**
 * 页面内容流：一串绘图指令。方法名对应 PDF 的指令，参数用我们自己的类型（矩阵、颜色、路径）。
 * 资源（字体、图片、透明度设置）只按名字引用，名字由调用方统一分配。
 */
export class ContentStream {
  private readonly parts: string[] = [];

  /** 写一条原样的指令 */
  raw(text: string): this {
    this.parts.push(text);
    return this;
  }

  save(): this {
    return this.raw('q');
  }

  restore(): this {
    return this.raw('Q');
  }

  /** 把矩阵乘到当前坐标变换上。单位矩阵不写 */
  transform(m: Matrix): this {
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0) return this;
    return this.raw(`${m.map(n).join(' ')} cm`);
  }

  /** 路径。PDF 没有二次曲线，换成等价的三次曲线 */
  path(data: PathData | ArrayLike<number>, scale = 1): this {
    const out: string[] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < data.length;) {
      const command = data[i++]!;
      if (command === MOVE || command === LINE) {
        x = data[i++]! * scale;
        y = data[i++]! * scale;
        out.push(`${n(x)} ${n(y)} ${command === MOVE ? 'm' : 'l'}`);
      } else if (command === CUBIC) {
        const v = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!, data[i + 4]!, data[i + 5]!].map(
          (c) => c * scale,
        );
        i += 6;
        out.push(`${v.map(n).join(' ')} c`);
        x = v[4]!;
        y = v[5]!;
      } else if (command === QUAD) {
        const cx = data[i++]! * scale;
        const cy = data[i++]! * scale;
        const ex = data[i++]! * scale;
        const ey = data[i++]! * scale;
        const c1x = x + ((cx - x) * 2) / 3;
        const c1y = y + ((cy - y) * 2) / 3;
        const c2x = ex + ((cx - ex) * 2) / 3;
        const c2y = ey + ((cy - ey) * 2) / 3;
        out.push(`${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(ex)} ${n(ey)} c`);
        x = ex;
        y = ey;
      } else if (command === CLOSE) {
        out.push('h');
      } else {
        break;
      }
    }
    if (out.length > 0) this.parts.push(out.join('\n'));
    return this;
  }

  rect(x: number, y: number, w: number, h: number): this {
    return this.raw(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re`);
  }

  fill(evenOdd = false): this {
    return this.raw(evenOdd ? 'f*' : 'f');
  }

  stroke(): this {
    return this.raw('S');
  }

  /** 用当前路径裁剪，然后丢掉路径 */
  clip(evenOdd = false): this {
    return this.raw(evenOdd ? 'W* n' : 'W n');
  }

  fillColor(c: Color): this {
    return this.raw(`${n(c.r)} ${n(c.g)} ${n(c.b)} rg`);
  }

  strokeColor(c: Color): this {
    return this.raw(`${n(c.r)} ${n(c.g)} ${n(c.b)} RG`);
  }

  lineWidth(width: number): this {
    return this.raw(`${n(width)} w`);
  }

  miterLimit(limit: number): this {
    return this.raw(`${n(limit)} M`);
  }

  /** 虚线：实线段和空白交替的长度、起始偏移。空数组是实线 */
  dash(lengths: readonly number[], phase = 0): this {
    return this.raw(`[${lengths.map(n).join(' ')}] ${n(phase)} d`);
  }

  /** 端点：0 平头、1 圆头、2 方头 */
  lineCap(style: 0 | 1 | 2): this {
    return this.raw(`${style} J`);
  }

  /** 拐角：0 尖角、1 圆角、2 斜角 */
  lineJoin(style: 0 | 1 | 2): this {
    return this.raw(`${style} j`);
  }

  /** 应用一组图形状态（透明度、混合模式） */
  graphicsState(name: string): this {
    return this.raw(`/${name} gs`);
  }

  /** 画一个外部对象（图片或表单） */
  xobject(name: string): this {
    return this.raw(`/${name} Do`);
  }

  beginText(): this {
    return this.raw('BT');
  }

  endText(): this {
    return this.raw('ET');
  }

  font(name: string, size: number): this {
    return this.raw(`/${name} ${n(size)} Tf`);
  }

  textMatrix(m: Matrix): this {
    return this.raw(`${m.map(n).join(' ')} Tm`);
  }

  /**
   * 显示一串字形。items 里的字符串是已经编码好的字形代码（十六进制），
   * 数字是两个字之间的额外调整，单位是千分之一字号，正数往回退。
   */
  showText(items: readonly (string | number)[]): this {
    if (items.length === 1 && typeof items[0] === 'string') return this.raw(`<${items[0]}> Tj`);
    const body = items.map((item) => (typeof item === 'string' ? `<${item}>` : n(item))).join('');
    return this.raw(`[${body}] TJ`);
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  toBytes(): Uint8Array {
    return latin1(this.parts.join('\n'));
  }
}
