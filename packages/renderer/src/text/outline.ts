import type { CanvasKit, Path } from 'canvaskit-wasm';
import type { Color, NodeId, TextNode } from '@shiba/core';
import { GlyphOutlines, parseSfnt, type SfntFont } from '@shiba/io';
import { fromPathData } from '../path-data';
import type { TextAppearances } from './appearance';
import type { FontManager, LoadedFace } from './fonts';
import type { TextLayouts } from './layout';
import { TextShaper, type ShapedRun } from './shaped';

/**
 * 文字转轮廓：把文本节点画出来的字变成路径，和画布上的样子一致，之后可以当普通形状改。
 * 字形轮廓从字体文件里读（和导出 SVG 时"转成轮廓"是同一份做法），按排版结果摆好；
 * 从 PDF 导入、没改过的文字直接用原文件的字形。
 *
 * 要取字体文件、解析字形，所以单独作为 @shiba/renderer/text-outline 导出，用到时才加载。
 */

export interface TextOutlineContext {
  ck: CanvasKit;
  layouts: TextLayouts;
  fonts: FontManager;
  appearances: TextAppearances;
}

/** 同一种颜色的字转成的一条路径，节点本地坐标。由调用方 delete */
export interface TextOutlinePart {
  color: Color;
  path: Path;
}

/** 读得出字形的字体文件 */
interface PreparedFace {
  font: SfntFont;
  outlines: GlyphOutlines;
}

/**
 * 把一批文本节点转成轮廓。每个节点得到按颜色分开的几条路径，顺序是颜色第一次出现的顺序；
 * 什么都不画的文字（没有填充、全是空白）得到空数组；
 * 读不出字形的（字体文件取不到、不是 TrueType 轮廓、认不出排版用的是哪个文件）得到 null。
 * 调用之前字体要已经加载完（见 Editor.fontsReady），否则排版结果不是最终的
 */
export async function outlineTexts(
  context: TextOutlineContext,
  nodes: readonly TextNode[],
): Promise<Map<NodeId, TextOutlinePart[] | null>> {
  const { ck } = context;
  const shaper = new TextShaper(ck, context.layouts, context.fonts, context.appearances);
  const result = new Map<NodeId, TextOutlinePart[] | null>();
  try {
    const shapedNodes: { node: TextNode; runs: ShapedRun[] }[] = [];
    const needed = new Map<string, LoadedFace>();
    for (const node of nodes) {
      if (!node.fill) {
        result.set(node.id, []);
      } else if (shaper.frozen(node)) {
        result.set(node.id, frozenParts(context, node, node.fill.color));
      } else {
        const shaped = shaper.shape(node);
        if (shaped === 'raster') {
          result.set(node.id, null);
          continue;
        }
        shapedNodes.push({ node, runs: shaped.runs });
        for (const run of shaped.runs) needed.set(run.face.key, run.face);
      }
    }

    const faces = new Map<string, PreparedFace | null>();
    await Promise.all(
      [...needed.values()].map(async (face) => {
        try {
          const font = parseSfnt(new Uint8Array(await face.embeddable()));
          faces.set(face.key, { font, outlines: new GlyphOutlines(font) });
        } catch (error) {
          console.warn(`[shiba] 读不出字形，不能转成轮廓：${face.key}`, error);
          faces.set(face.key, null);
        }
      }),
    );

    for (const { node, runs } of shapedNodes) {
      if (runs.some((run) => !faces.get(run.face.key))) {
        result.set(node.id, null);
        continue;
      }
      result.set(node.id, liveParts(ck, shaper, runs, faces));
    }
    return result;
  } finally {
    shaper.dispose();
  }
}

/**
 * 一段排好的字的字形轮廓，按排版结果摆好，追加到 out 里（路径数据，节点本地坐标）。
 * 字形坐标以字号为 1、y 向上；模拟斜体时斜切让字的上半部分往右倒，和排版引擎一样
 */
export function appendRunGlyphs(run: ShapedRun, outlines: GlyphOutlines, out: number[]): void {
  const { size, skew } = run;
  const ARITY = [2, 2, 6, 4, 0];
  for (let i = 0; i < run.glyphs.length; i++) {
    const outline = outlines.get(run.glyphs[i]!);
    if (outline.length === 0) continue;
    const x = run.positions[i * 2]!;
    const y = run.positions[i * 2 + 1]!;
    for (let k = 0; k < outline.length;) {
      const command = outline[k++]!;
      const count = ARITY[command];
      if (count === undefined) break;
      out.push(command);
      for (let n = 0; n < count; n += 2) {
        const u = outline[k++]!;
        const v = outline[k++]!;
        out.push(x + size * (u + skew * v), y - size * v);
      }
    }
  }
}

/** 一种颜色的字：普通的字形放在一起，还有需要合并进来的（模拟粗体的字、下划线和删除线） */
interface ColorGroup {
  color: Color;
  glyphs: number[];
  extras: Path[];
}

function liveParts(
  ck: CanvasKit,
  shaper: TextShaper,
  runs: readonly ShapedRun[],
  faces: ReadonlyMap<string, PreparedFace | null>,
): TextOutlinePart[] {
  const groups = new Map<string, ColorGroup>();
  const groupOf = (color: Color): ColorGroup => {
    const key = `${color.r},${color.g},${color.b},${color.a}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { color, glyphs: [], extras: [] }));
    return group;
  };

  for (const run of runs) {
    if (!run.color) continue;
    const prepared = faces.get(run.face.key)!;
    // 排版用的字体和读轮廓用的字体文件字形编号可能不一样，按字符对一遍（见 TextShaper.remapToEmbedded）
    shaper.remapToEmbedded(run, prepared.font.bytes);
    const group = groupOf(run.color);
    if (run.embolden > 0) {
      // 字体没有粗体文件时排版引擎把字形描粗：轮廓再加上同色、这么宽的一圈描边
      const data: number[] = [];
      appendRunGlyphs(run, prepared.outlines, data);
      const glyphs = fromPathData(ck, data);
      const stroked = glyphs.makeStroked({ width: run.embolden, join: ck.StrokeJoin.Miter, miter_limit: 4 });
      group.extras.push(glyphs);
      if (stroked) group.extras.push(stroked);
    } else {
      appendRunGlyphs(run, prepared.outlines, group.glyphs);
    }
    for (const line of run.lines) {
      const builder = new ck.PathBuilder();
      builder.addRect(ck.XYWHRect(line.x0, line.y - line.thickness / 2, line.x1 - line.x0, line.thickness));
      group.extras.push(builder.detach());
      builder.delete();
    }
  }

  const parts: TextOutlinePart[] = [];
  for (const group of groups.values()) {
    let path = fromPathData(ck, group.glyphs);
    // 下划线、模拟粗体和字形叠在一起：字形的外轮廓和后加的矩形方向可能相反，按非零规则重叠处会变成洞，
    // 所以用布尔运算合并成一个整体（结果按奇偶规则填充，见 pathGeometry）
    for (const extra of group.extras) {
      const merged: Path | null = ck.Path.MakeFromOp(path, extra, ck.PathOp.Union);
      extra.delete();
      if (!merged) continue;
      path.delete();
      path = merged;
    }
    if (path.isEmpty()) path.delete();
    else parts.push({ color: group.color, path });
  }
  return parts;
}

/** 从 PDF 导入、没改过的文字：直接用保真外观里原文件的字形 */
function frozenParts(context: TextOutlineContext, node: TextNode, fallback: Color): TextOutlinePart[] | null {
  const paths = context.appearances.paths(node);
  if (!paths) return null;
  return paths
    .filter(({ path }) => !path.isEmpty())
    .map(({ color, path }) => ({ color: color ?? fallback, path: path.copy() }));
}
