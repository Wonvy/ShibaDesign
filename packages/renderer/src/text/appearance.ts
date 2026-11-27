import type { CanvasKit, Path } from 'canvaskit-wasm';
import {
  GLYPH_PATH_ARITY,
  decodeGlyphLibrary,
  type AssetStore,
  type GlyphLibrary,
  type DocStore,
  type NodeId,
  type TextAppearance,
  type TextNode,
} from '@shiba/core';

/**
 * 文字保真外观的绘制：把字形库里的字形轮廓按记录的位置拼成一条路径。
 * 拼好的路径按节点缓存；字形库解开后也缓存，同一个字体的所有文字共用。
 */

/** 我们的路径命令码 → Skia 的路径动词：移动 0、直线 1、二次曲线 2、三次曲线 4、闭合 5 */
const SK_VERB = [0, 1, 4, 2, 5];
/** 每条命令带几个点 */
const POINTS = GLYPH_PATH_ARITY.map((n) => n / 2);

interface Entry {
  appearance: TextAppearance;
  path: Path | null;
}

export class TextAppearances {
  private readonly libraries = new Map<string, GlyphLibrary | null>();
  private readonly entries = new Map<NodeId, Entry>();
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly ck: CanvasKit,
    store: DocStore,
    private readonly assets: AssetStore,
  ) {
    this.unsubscribe = [
      store.subscribe((change) => {
        for (const patch of change.patches) if (!patch.after) this.drop(patch.id);
      }),
      // 资源库整体替换（打开了另一个文件）后，之前解开的字形库可能已经对不上了
      assets.subscribe(() => this.clear()),
    ];
  }

  /** 节点保真外观的路径（本地坐标）。字形库缺失或损坏时返回 null，调用方改用正常排版 */
  path(node: TextNode): Path | null {
    const appearance = node.appearance;
    if (!appearance) return null;
    const cached = this.entries.get(node.id);
    if (cached?.appearance === appearance) return cached.path;
    cached?.path?.delete();
    const path = this.build(appearance);
    this.entries.set(node.id, { appearance, path });
    return path;
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.path?.delete();
    this.entries.clear();
    this.libraries.clear();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.clear();
  }

  private drop(id: NodeId): void {
    this.entries.get(id)?.path?.delete();
    this.entries.delete(id);
  }

  /** 解开的字形库，缓存起来，同一个字体的所有文字共用。资源缺失或损坏时返回 null */
  library(id: string): GlyphLibrary | null {
    if (!this.libraries.has(id)) {
      const bytes = this.assets.get(id);
      this.libraries.set(id, bytes ? decodeGlyphLibrary(bytes) : null);
    }
    return this.libraries.get(id) ?? null;
  }

  private build(appearance: TextAppearance): Path | null {
    // 先数一遍需要多少空间，再一次性把所有字形写进两个数组，最后整体交给 Skia：
    // 一页文字有几千个字，逐条命令调用 Skia 会慢很多
    let verbCount = 0;
    let pointCount = 0;
    for (const run of appearance.runs) {
      const library = this.library(run.library)?.glyphs;
      if (!library) return null;
      for (let i = 0; i < run.glyphs.length; i += 3) {
        const outline = library[run.glyphs[i]!];
        if (!outline) return null;
        for (let k = 0; k < outline.length; k += 1 + GLYPH_PATH_ARITY[outline[k]!]!) {
          verbCount++;
          pointCount += POINTS[outline[k]!]!;
        }
      }
    }

    const verbs = new Uint8Array(verbCount);
    const points = new Float32Array(pointCount * 2);
    let v = 0;
    let p = 0;
    for (const run of appearance.runs) {
      const library = this.library(run.library)!.glyphs;
      const [a, b, c, d] = run.matrix;
      for (let i = 0; i < run.glyphs.length; i += 3) {
        const outline = library[run.glyphs[i]!]!;
        const e = run.glyphs[i + 1]!;
        const f = run.glyphs[i + 2]!;
        for (let k = 0; k < outline.length;) {
          const command = outline[k++]!;
          verbs[v++] = SK_VERB[command]!;
          for (let n = POINTS[command]!; n > 0; n--) {
            const x = outline[k++]!;
            const y = outline[k++]!;
            points[p++] = a * x + c * y + e;
            points[p++] = b * x + d * y + f;
          }
        }
      }
    }

    const builder = new this.ck.PathBuilder();
    if (verbCount > 0) builder.addVerbsPointsWeights(verbs, points);
    const path = builder.detach();
    builder.delete();
    return path;
  }
}
