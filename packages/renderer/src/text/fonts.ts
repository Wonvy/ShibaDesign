import type { CanvasKit, TypefaceFontProvider } from 'canvaskit-wasm';

/**
 * 字体管理：登记可用的字体，按需加载，告诉排版引擎一段文字该用哪些字体文件。
 *
 * 中文字体很大，所以一个字体家族可以切成很多"分片"，每个分片是一个只含部分字符的字体文件。
 * 排版某段文字时只加载它用到的那几个分片。西文字体通常只有一两个分片。
 *
 * 这个类不关心字体文件从哪来：浏览器里用 fetch，Node 里读磁盘，都由 load() 决定。
 */

export interface FontFaceSource {
  /** 分片名。整个字体只有一个文件时随便起一个，比如 'all' */
  chunk: string;
  /** 字重，400 是常规，700 是粗体 */
  weight: number;
  /** 斜体。省略表示正体 */
  italic?: boolean;
  /** 这个文件覆盖的码点区间（闭区间）。省略表示不清楚覆盖范围，任何文字都会加载它 */
  ranges?: readonly (readonly [number, number])[];
  load(): Promise<ArrayBuffer>;
  /**
   * 同一个字体文件的另一种封装，用于嵌进导出的 PDF：TrueType、OpenType 或 WOFF（不能是 WOFF2）。
   * 字形编号必须和 load() 的完全一样。load() 本来就不是 WOFF2 时可以省略。
   */
  loadEmbeddable?(): Promise<ArrayBuffer>;
}

/** 一个已经加载的字体文件。导出 PDF 时用它找到排版实际用了哪个文件 */
export interface LoadedFace {
  /** 在所有字体文件里唯一，比如 "Inter#latin@400" 或 "Inter#latin@700i" */
  key: string;
  family: string;
  weight: number;
  italic: boolean;
  /** 加载时拿到的字节，交给排版引擎的就是它 */
  bytes: ArrayBuffer;
  /** 可以嵌进 PDF 的字节，见 FontFaceSource.loadEmbeddable */
  embeddable(): Promise<ArrayBuffer>;
}

export interface FontFamilySource {
  /** 家族名，文本样式里引用的就是它 */
  name: string;
  faces: readonly FontFaceSource[];
}

interface Face {
  source: FontFaceSource;
  status: 'idle' | 'loading' | 'loaded' | 'failed';
  promise: Promise<void> | null;
  bytes: ArrayBuffer | null;
  embeddable: Promise<ArrayBuffer> | null;
}

interface Chunk {
  /** 注册到 Skia 时用的内部家族名：同一分片的不同字重、正斜体共用一个名字，Skia 按样式挑选 */
  skFamily: string;
  ranges: readonly (readonly [number, number])[] | null;
  /** 键见 faceKey */
  faces: Map<string, Face>;
}

function faceKey(weight: number, italic: boolean): string {
  return `${weight}${italic ? 'i' : ''}`;
}

interface Family {
  name: string;
  /** 交给排版引擎的内部家族名 → 分片 */
  bySkFamily: Map<string, Chunk>;
  chunks: Chunk[];
  /** 按起点排序的区间表，用来二分查找某个码点在哪个分片 */
  starts: number[];
  ends: number[];
  owners: Chunk[];
  /** 没有声明区间的分片，任何文字都会用到 */
  catchAll: Chunk[];
  weights: number[];
  /** 有斜体文件 */
  italic: boolean;
}

export interface FontResolution {
  /** 交给排版引擎的家族名，按回退顺序排列 */
  names: string[];
  /** 还有需要的字体文件没加载完；加载完会触发 onChange */
  pending: boolean;
}

export class FontManager {
  readonly provider: TypefaceFontProvider;
  private families = new Map<string, Family>();
  /** 内部家族名 → 对外的家族名 */
  private chunkFamilies = new Map<string, string>();
  private listeners = new Set<() => void>();
  private notifyQueued = false;
  private _epoch = 0;

  constructor(private readonly ck: CanvasKit) {
    this.provider = ck.TypefaceFontProvider.Make();
  }

  /** 每加载完一个字体文件加一。排版结果的缓存用它判断是否过期 */
  get epoch(): number {
    return this._epoch;
  }

  addFamily(source: FontFamilySource): void {
    const chunks = new Map<string, Chunk>();
    for (const face of source.faces) {
      let chunk = chunks.get(face.chunk);
      if (!chunk) {
        chunk = { skFamily: `${source.name}#${face.chunk}`, ranges: face.ranges ?? null, faces: new Map() };
        chunks.set(face.chunk, chunk);
      }
      chunk.faces.set(faceKey(face.weight, !!face.italic), {
        source: face,
        status: 'idle',
        promise: null,
        bytes: null,
        embeddable: null,
      });
    }

    const spans: { start: number; end: number; owner: Chunk }[] = [];
    const catchAll: Chunk[] = [];
    for (const chunk of chunks.values()) {
      if (!chunk.ranges) catchAll.push(chunk);
      else for (const [start, end] of chunk.ranges) spans.push({ start, end, owner: chunk });
    }
    spans.sort((a, b) => a.start - b.start);

    const bySkFamily = new Map([...chunks.values()].map((chunk) => [chunk.skFamily, chunk]));
    for (const skFamily of bySkFamily.keys()) this.chunkFamilies.set(skFamily, source.name);
    this.families.set(source.name, {
      name: source.name,
      bySkFamily,
      chunks: [...chunks.values()],
      starts: spans.map((s) => s.start),
      ends: spans.map((s) => s.end),
      owners: spans.map((s) => s.owner),
      catchAll,
      weights: [...new Set(source.faces.filter((f) => !f.italic).map((f) => f.weight))].sort((a, b) => a - b),
      italic: source.faces.some((f) => f.italic),
    });
  }

  familyNames(): string[] {
    return [...this.families.keys()];
  }

  /** 某个家族有哪些字重可选 */
  weightsOf(family: string): number[] {
    return this.families.get(family)?.weights ?? [];
  }

  /** 某个家族有没有斜体。没有时设成斜体也按正体显示（中文字体通常都没有斜体） */
  hasItalic(family: string): boolean {
    return this.families.get(family)?.italic ?? false;
  }

  /**
   * 算出排版一段文字需要哪些字体文件，并开始加载还没加载的。
   * 每个字符由 families 里第一个包含它的家族负责，所以排在前面的家族优先。
   */
  resolve(families: readonly string[], text: string, weight: number, italic = false): FontResolution {
    const { chunks } = this.plan(families, text);
    let pending = false;
    for (const chunk of chunks) {
      const face = pickFace(chunk, weight, italic);
      if (!face) continue;
      if (face.status === 'idle') this.load(chunk, face);
      if (face.status === 'loading') pending = true;
    }
    return { names: chunks.map((c) => c.skFamily), pending };
  }

  /** 等一段文字需要的字体全部加载完。导出和测试用 */
  async ensure(families: readonly string[], text: string, weight: number, italic = false): Promise<void> {
    const { chunks } = this.plan(families, text);
    const waits: Promise<void>[] = [];
    for (const chunk of chunks) {
      const face = pickFace(chunk, weight, italic);
      if (!face) continue;
      if (face.status === 'idle') this.load(chunk, face);
      if (face.promise) waits.push(face.promise);
    }
    await Promise.all(waits);
  }

  /**
   * 排版时某个内部家族名（resolve 返回的 names 之一）在这个字重下实际用的是哪个文件。
   * 排版引擎在同一个家族的几个字重里挑最接近的，这里用同样的规则。还没加载时返回 null。
   */
  loadedFace(skFamily: string, weight: number, italic = false): LoadedFace | null {
    const familyName = this.chunkFamilies.get(skFamily);
    const chunk = familyName ? this.families.get(familyName)?.bySkFamily.get(skFamily) : undefined;
    if (!chunk || !familyName) return null;
    const loaded = new Map([...chunk.faces].filter(([, face]) => face.status === 'loaded'));
    const face = pickFace({ ...chunk, faces: loaded }, weight, italic);
    if (!face?.bytes) return null;
    const bytes = face.bytes;
    return {
      key: `${skFamily}@${faceKey(face.source.weight, !!face.source.italic)}`,
      family: familyName,
      weight: face.source.weight,
      italic: !!face.source.italic,
      bytes,
      embeddable: () => {
        face.embeddable ??= face.source.loadEmbeddable?.() ?? Promise.resolve(bytes);
        // 失败了下次重试，不要把失败缓存起来
        face.embeddable.catch(() => (face.embeddable = null));
        return face.embeddable;
      },
    };
  }

  /**
   * 几个家族里所有已经加载的字体文件（每个分片按字重挑一个），按家族的顺序排列。
   * 导出时认字体文件用：有的字不在分片声明的区间里，排版引擎却从别的分片里找到了它
   */
  loadedFaces(families: readonly string[], weight: number, italic = false): LoadedFace[] {
    const out: LoadedFace[] = [];
    for (const name of families) {
      for (const chunk of this.families.get(name)?.chunks ?? []) {
        const face = this.loadedFace(chunk.skFamily, weight, italic);
        if (face) out.push(face);
      }
    }
    return out;
  }

  /** 字体文件加载完成时通知。同一时刻完成的多个文件只通知一次 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private plan(families: readonly string[], text: string): { chunks: Chunk[] } {
    const remaining = new Set<number>();
    for (const char of text) {
      const cp = char.codePointAt(0)!;
      if (cp > 0x20) remaining.add(cp);
    }
    // 空格总是需要：即使文字为空，也要靠第一个家族确定行高
    remaining.add(0x20);

    const chunks: Chunk[] = [];
    const seen = new Set<Chunk>();
    const add = (chunk: Chunk): void => {
      if (seen.has(chunk)) return;
      seen.add(chunk);
      chunks.push(chunk);
    };

    for (const name of families) {
      const family = this.families.get(name);
      if (!family) continue;
      // 没声明区间的字体文件不知道到底覆盖哪些字符：总是带上它，但不把任何字符算作"已解决"，
      // 这样后面的家族仍会为这些字符准备回退
      family.catchAll.forEach(add);
      for (const cp of [...remaining]) {
        const owner = lookup(family, cp);
        if (!owner) continue;
        add(owner);
        remaining.delete(cp);
      }
    }
    return { chunks };
  }

  private load(chunk: Chunk, face: Face): void {
    face.status = 'loading';
    face.promise = face.source
      .load()
      .then((bytes) => {
        this.provider.registerFont(bytes, chunk.skFamily);
        face.bytes = bytes;
        face.status = 'loaded';
        this._epoch += 1;
        this.notify();
      })
      .catch((error: unknown) => {
        face.status = 'failed';
        console.warn(
          `[shiba] 字体加载失败：${chunk.skFamily} ${faceKey(face.source.weight, !!face.source.italic)}`,
          error,
        );
      });
  }

  private notify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of [...this.listeners]) listener();
    });
  }
}

/**
 * 取请求的字重和正斜体；没有就取最接近的：先保证正斜体一致（没有斜体文件时只好用正体），再挑字重最近的。
 * 排版引擎在同一个家族的几个文件里也是这样挑的。
 */
function pickFace(chunk: Chunk, weight: number, italic: boolean): Face | undefined {
  const exact = chunk.faces.get(faceKey(weight, italic));
  if (exact) return exact;
  let best: Face | undefined;
  let bestDistance = Infinity;
  for (const face of chunk.faces.values()) {
    const distance = Math.abs(face.source.weight - weight) + (!!face.source.italic === italic ? 0 : 10_000);
    if (distance < bestDistance) {
      best = face;
      bestDistance = distance;
    }
  }
  return best;
}

function lookup(family: Family, cp: number): Chunk | null {
  let lo = 0;
  let hi = family.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < family.starts[mid]!) hi = mid - 1;
    else if (cp > family.ends[mid]!) lo = mid + 1;
    else return family.owners[mid]!;
  }
  return null;
}

/** 解析 CSS unicode-range 的写法，例如 "U+0000-00FF,U+0131" */
export function parseUnicodeRange(value: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of value.split(',')) {
    const [from, to] = part.trim().replace(/^U\+/i, '').split('-');
    const start = parseInt(from ?? '', 16);
    const end = parseInt(to ?? from ?? '', 16);
    if (Number.isFinite(start) && Number.isFinite(end)) out.push([start, end]);
  }
  return out;
}
