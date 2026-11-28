import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_SIDES, MIN_SIDES, type PolygonNode } from '@shiba/core';
import { NumberField } from '../ui/controls';
import type { PanelProps } from './registry';

/** 新改成星形时的内径比例 */
const DEFAULT_RATIO = 0.382;

/** 多边形和星形：边数（角数）、是不是星形、星形内顶点的位置 */
export function PolygonPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const polygons = nodes.filter((n): n is PolygonNode => n.type === 'polygon');
  const first = polygons[0];
  if (!first) return null;
  const star = first.innerRatio !== undefined;
  const update = (label: string, patch: (node: PolygonNode) => Partial<PolygonNode>): void => {
    editor.updateSelection(label, (node) => (node.type === 'polygon' ? patch(node) : null));
    editor.store.sealHistory();
  };

  return (
    <div className="polygon-panel">
      <div className="segmented segmented-small" role="radiogroup" aria-label={t('panel.polygon')}>
        {[false, true].map((isStar) => (
          <button
            key={String(isStar)}
            type="button"
            role="radio"
            aria-checked={star === isStar}
            className={star === isStar ? 'is-active' : ''}
            onClick={() => update('polygon kind', () => ({ innerRatio: isStar ? DEFAULT_RATIO : undefined }))}
          >
            {t(isStar ? 'node.star' : 'node.polygon')}
          </button>
        ))}
      </div>
      <div className="prop-grid">
        <NumberField
          label={t(star ? 'prop.points' : 'prop.sides')}
          value={first.sides}
          mixed={polygons.some((p) => p.sides !== first.sides)}
          min={MIN_SIDES}
          max={MAX_SIDES}
          onCommit={(v) => update('polygon sides', () => ({ sides: Math.round(v) }))}
        />
        {star && (
          <NumberField
            label={t('prop.innerRatio')}
            value={Math.round((first.innerRatio ?? DEFAULT_RATIO) * 100)}
            min={1}
            max={100}
            suffix="%"
            onCommit={(v) => update('star ratio', () => ({ innerRatio: Math.min(100, Math.max(1, v)) / 100 }))}
          />
        )}
      </div>
    </div>
  );
}
