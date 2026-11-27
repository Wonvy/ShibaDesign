import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { artboardOf, topLevelOnly, type Rect } from '@shiba/core';
import { captureOriginals, scaleNodes, translateNode } from '@shiba/editor';
import { NumberField } from '../ui/controls';
import type { PanelProps } from './registry';

/**
 * 位置与大小。显示的是选区整体的外接矩形；
 * 画板里的对象，坐标相对所在画板的左上角，和幻灯片软件的习惯一致。
 */
export function TransformPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const { store } = editor;
  const bounds = editor.selectionBounds();
  if (!bounds) return null;

  const first = nodes[0]!;
  const board = first.type === 'artboard' ? null : artboardOf(store, first.id);
  const origin = board ? editor.geometry.worldBounds(board) : { x: 0, y: 0 };
  const ids = topLevelOnly(store, editor.selection);

  const moveBy = (dx: number, dy: number): void => {
    store.transact('move', (tx) => ids.forEach((id) => translateNode(tx, store, id, dx, dy)));
    store.sealHistory();
  };

  const resizeTo = (to: Rect): void => {
    const originals = captureOriginals(store, ids, (node) => editor.textLayouts.get(node).width);
    store.transact('resize', (tx) => scaleNodes(tx, store, ids, originals, bounds, to));
    store.sealHistory();
  };

  const rects = nodes.filter((n) => n.type === 'rect');
  const allRects = rects.length === nodes.length;

  return (
    <div className="field-grid">
      <NumberField
        label={t('prop.x')}
        value={bounds.x - origin.x}
        onCommit={(v) => moveBy(v - (bounds.x - origin.x), 0)}
      />
      <NumberField
        label={t('prop.y')}
        value={bounds.y - origin.y}
        onCommit={(v) => moveBy(0, v - (bounds.y - origin.y))}
      />
      <NumberField
        label={t('prop.width')}
        value={bounds.w}
        min={1}
        disabled={bounds.w === 0}
        onCommit={(v) => resizeTo({ ...bounds, w: v })}
      />
      <NumberField
        label={t('prop.height')}
        value={bounds.h}
        min={1}
        disabled={bounds.h === 0}
        onCommit={(v) => resizeTo({ ...bounds, h: v })}
      />
      {allRects && (
        <NumberField
          label={t('prop.radius')}
          value={rects[0]!.cornerRadius}
          min={0}
          onCommit={(v) => {
            editor.updateSelection('radius', (node) => (node.type === 'rect' ? { cornerRadius: v } : null));
            store.sealHistory();
          }}
        />
      )}
    </div>
  );
}
