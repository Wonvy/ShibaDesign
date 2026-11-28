import {
  hasBoxCorners,
  isShadow,
  type NodeId,
  type NodePatch,
  type ParagraphOverride,
  type Point,
  type Rect,
  type SceneNode,
  type Stroke,
  type Transaction,
  type DocStore,
  type Effect,
} from '@shiba/core';
import { resizeInWorld } from './resize';

/**
 * 等比缩放（缩放工具 K）：和普通的缩放不同，描边粗细、圆角、字号、字距、段距、虚线也按同一个比例变，
 * 整体放大一倍时看起来就是放大了一倍（做 UI 时常用）。几何照常用 resizeInWorld 改，
 * 参数都从拖动开始时的原样乘比例，拖动中不会越乘越大
 */

/** 把一个节点的参数乘上 k（原样取 original 的，几何已经改过的取 current） */
export function scaledParams(current: SceneNode, original: SceneNode, k: number): NodePatch | null {
  const patch: Record<string, unknown> = {};
  if ('stroke' in original && original.stroke) patch.stroke = scaleStroke(original.stroke, k);
  if (original.effects) patch.effects = original.effects.map((e) => scaleEffect(e, k));
  if (hasBoxCorners(original)) {
    patch.cornerRadius = original.cornerRadius * k;
    if (original.cornerRadii) patch.cornerRadii = original.cornerRadii.map((r) => r * k);
  }
  if (original.type === 'polygon') patch.cornerRadius = original.cornerRadius * k;
  if (original.type === 'path' && current.type === 'path') {
    patch.subpaths = current.subpaths.map((s, si) => ({
      closed: s.closed,
      anchors: s.anchors.map((a, i) => {
        const r = original.subpaths[si]?.anchors[i]?.radius;
        return r ? { ...a, radius: r * k } : a;
      }),
    }));
  }
  if (original.type === 'text') {
    patch.style = {
      ...original.style,
      fontSize: original.style.fontSize * k,
      letterSpacing: original.style.letterSpacing * k,
    };
    if (original.spans) {
      patch.spans = original.spans.map((span) => ({
        ...span,
        style: {
          ...span.style,
          ...(span.style.fontSize !== undefined ? { fontSize: span.style.fontSize * k } : {}),
          ...(span.style.letterSpacing !== undefined ? { letterSpacing: span.style.letterSpacing * k } : {}),
        },
      }));
    }
    if (original.paragraphs) patch.paragraphs = original.paragraphs.map((p) => (p ? scaleParagraph(p, k) : p));
  }
  return Object.keys(patch).length > 0 ? (patch as NodePatch) : null;
}

/** 阴影的偏移、模糊、扩展，模糊的半径都按比例变 */
function scaleEffect(effect: Effect, k: number): Effect {
  if (isShadow(effect)) {
    return { ...effect, x: effect.x * k, y: effect.y * k, blur: effect.blur * k, spread: effect.spread * k };
  }
  return { ...effect, radius: effect.radius * k };
}

function scaleStroke(stroke: Stroke, k: number): Stroke {
  return {
    ...stroke,
    width: stroke.width * k,
    ...(stroke.dash ? { dash: stroke.dash.map((d) => d * k) } : {}),
    ...(stroke.dashOffset ? { dashOffset: stroke.dashOffset * k } : {}),
  };
}

function scaleParagraph(p: ParagraphOverride, k: number): ParagraphOverride {
  const out: ParagraphOverride = { ...p };
  for (const key of ['spaceBefore', 'spaceAfter', 'indent', 'firstLine'] as const) {
    if (p[key] !== undefined) out[key] = p[key]! * k;
  }
  return out;
}

/** 把一组节点以 pivot 为中心等比缩放 k 倍（几何和参数一起）。originals 来自 captureOriginals */
export function scaleUniform(
  tx: Transaction,
  store: DocStore,
  originals: ReadonlyMap<NodeId, SceneNode>,
  ids: readonly NodeId[],
  from: Rect,
  pivot: Point,
  k: number,
): void {
  const to = {
    x: pivot.x + (from.x - pivot.x) * k,
    y: pivot.y + (from.y - pivot.y) * k,
    w: from.w * k,
    h: from.h * k,
  };
  resizeInWorld(tx, store, originals, ids, from, to, 'scale');
  for (const [id, original] of originals) {
    const current = tx.get(id);
    if (!current) continue;
    const patch = scaledParams(current, original, k);
    if (patch) tx.update(id, patch);
  }
}
