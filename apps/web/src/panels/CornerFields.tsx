import { Scan } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CORNER_STYLES,
  canRoundAnchor,
  rectCornerRadii,
  type NodePatch,
  type PathNode,
  type PolygonNode,
  type RectNode,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '@shiba/editor';
import { IconButton, NumberField } from '../ui/controls';

type Rounded = RectNode | PathNode | PolygonNode;

/** 能改圆角的：矩形，和带尖角锚点的路径 */
export function roundable(nodes: readonly SceneNode[]): Rounded[] | null {
  const list = nodes.filter(
    (n): n is Rounded =>
      n.type === 'rect' ||
      (n.type === 'path' && n.subpaths.some((s) => s.anchors.some((_, i) => canRoundAnchor(s, i)))),
  );
  return list.length === nodes.length && list.length > 0 ? list : null;
}

/** 一个对象现在的圆角半径（路径取第一个能圆的锚点） */
function radiusOf(node: Rounded): number {
  if (node.type === 'rect' || node.type === 'polygon') return node.cornerRadius;
  for (const s of node.subpaths) {
    const i = s.anchors.findIndex((_, k) => canRoundAnchor(s, k));
    if (i >= 0) return s.anchors[i]!.radius ?? 0;
  }
  return 0;
}

function radiusPatch(node: Rounded, radius: number): NodePatch {
  if (node.type === 'rect') return { cornerRadius: radius, cornerRadii: undefined };
  if (node.type === 'polygon') return { cornerRadius: radius };
  return {
    subpaths: node.subpaths.map((s) => ({
      closed: s.closed,
      anchors: s.anchors.map((a, i) => {
        if (!canRoundAnchor(s, i)) return a;
        const { radius: _old, ...rest } = a;
        return radius > 0 ? { ...rest, radius } : rest;
      }),
    })),
  };
}

const CORNER_LABELS = ['prop.cornerTopLeft', 'prop.cornerTopRight', 'prop.cornerBottomRight', 'prop.cornerBottomLeft'];

/**
 * 圆角：一个半径（几个对象不一样时显示空白），"四个角分开"展开成四个框（只对矩形），样式三选一，平滑度。
 * 画布上的圆角控件见 editor 的 corner-handles.ts
 */
export function CornerFields({ editor, nodes }: { editor: Editor; nodes: Rounded[] }): ReactNode {
  const { t } = useTranslation();
  const { store } = editor;
  const rects = nodes.filter((n): n is RectNode => n.type === 'rect');
  const separate = rects.length > 0 && rects.some((r) => r.cornerRadii);
  const [expanded, setExpanded] = useState(separate);
  const first = nodes[0]!;
  const radii = rects.length === 1 ? rectCornerRadii(rects[0]!) : null;
  const mixed = nodes.some((n) => radiusOf(n) !== radiusOf(first)) || separate;
  const style = first.cornerStyle ?? 'round';
  const styleMixed = nodes.some((n) => (n.cornerStyle ?? 'round') !== style);
  const smoothing = Math.round((first.cornerSmoothing ?? 0) * 100);

  const update = (label: string, patch: (node: Rounded) => NodePatch | null): void => {
    editor.updateSelection(label, (node) =>
      node.type === 'rect' || node.type === 'path' || node.type === 'polygon' ? patch(node) : null,
    );
    store.sealHistory();
  };

  return (
    <div className="corner-fields">
      <div className="corner-row">
        <NumberField
          label={t('prop.radius')}
          value={radiusOf(first)}
          mixed={mixed}
          min={0}
          onCommit={(v) => update('radius', (node) => radiusPatch(node, v))}
        />
        {rects.length === nodes.length && (
          <IconButton title={t('prop.cornersSeparate')} active={expanded} onClick={() => setExpanded((open) => !open)}>
            <Scan size={14} />
          </IconButton>
        )}
      </div>
      {expanded && radii && (
        <div className="corner-grid">
          {radii.map((value, index) => (
            <NumberField
              key={CORNER_LABELS[index]}
              label={t(CORNER_LABELS[index]!)}
              value={value}
              min={0}
              onCommit={(v) =>
                update('radius', (node) => {
                  if (node.type !== 'rect') return null;
                  const next = rectCornerRadii(node);
                  next[index] = v;
                  return next.every((r) => r === next[0])
                    ? { cornerRadius: next[0], cornerRadii: undefined }
                    : { cornerRadii: next };
                })
              }
            />
          ))}
        </div>
      )}
      <div className="corner-row">
        <div className="segmented segmented-small" role="radiogroup" aria-label={t('prop.cornerStyle')}>
          {CORNER_STYLES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={!styleMixed && style === s}
              className={!styleMixed && style === s ? 'is-active' : ''}
              onClick={() => update('corner style', () => ({ cornerStyle: s === 'round' ? undefined : s }))}
            >
              {t(`prop.corner_${s}`)}
            </button>
          ))}
        </div>
      </div>
      <NumberField
        label={t('prop.cornerSmoothing')}
        value={smoothing}
        min={0}
        max={100}
        suffix="%"
        onCommit={(v) =>
          update('corner smoothing', () => ({ cornerSmoothing: v > 0 ? Math.min(100, v) / 100 : undefined }))
        }
      />
    </div>
  );
}
