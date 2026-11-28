import { ArrowDown, ArrowRight, Scan } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_ITEM_SIZING,
  LAYOUT_ALIGN,
  type AutoLayout,
  type FrameNode,
  type ItemLayoutSizing,
  type LayoutAlign,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from '@shiba/editor';
import { IconButton, NumberField } from '../ui/controls';

type LayoutFrame = FrameNode & { layout: AutoLayout };

/**
 * 画框的自动布局：方向、间距、内边距（左右、上下，可以四边分开）、3 × 3 的对齐小图和两端对齐、宽高的尺寸方式。
 * 几个画框一起选中时显示第一个的，改的是改动的那一项
 */
export function FrameLayoutFields({ editor, frames }: { editor: Editor; frames: readonly LayoutFrame[] }): ReactNode {
  const { t } = useTranslation();
  const first = frames[0]!;
  const layout = first.layout;
  const [separate, setSeparate] = useState(() => {
    const [top, right, bottom, left] = layout.padding;
    return top !== bottom || left !== right;
  });
  const update = (label: string, patch: (layout: AutoLayout) => Partial<AutoLayout>): void => {
    editor.updateSelection(label, (node) =>
      node.type === 'frame' && node.layout ? { layout: { ...node.layout, ...patch(node.layout) } } : null,
    );
    editor.store.sealHistory();
  };
  const [top, right, bottom, left] = layout.padding;
  const horizontal = layout.direction === 'horizontal';
  // 对齐小图：横排时列是主轴，竖排时行是主轴
  const cellOf = (col: LayoutAlign, row: LayoutAlign) =>
    horizontal ? { justify: col, align: row } : { justify: row, align: col };
  const isOn = (col: LayoutAlign, row: LayoutAlign) => {
    const cell = cellOf(col, row);
    const main = layout.justify === 'spaceBetween' ? null : layout.justify;
    return cell.align === layout.align && (main === null || cell.justify === main);
  };

  return (
    <div className="layout-fields">
      <div className="layout-row">
        <div className="segmented segmented-small" role="radiogroup" aria-label={t('layout.direction')}>
          {(['horizontal', 'vertical'] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={layout.direction === d}
              className={layout.direction === d ? 'is-active' : ''}
              title={t(`layout.${d}`)}
              onClick={() => update('layout direction', () => ({ direction: d }))}
            >
              {d === 'horizontal' ? <ArrowRight size={14} /> : <ArrowDown size={14} />}
            </button>
          ))}
        </div>
        <NumberField
          label={t('layout.gap')}
          value={layout.gap}
          min={0}
          onCommit={(v) => update('layout gap', () => ({ gap: v }))}
        />
      </div>
      <div className="layout-row">
        <div className="layout-align" role="group" aria-label={t('layout.align')}>
          {LAYOUT_ALIGN.map((row) =>
            LAYOUT_ALIGN.map((col) => (
              <button
                key={`${col}-${row}`}
                type="button"
                className={`layout-cell${isOn(col, row) ? ' is-on' : ''}`}
                title={t('layout.alignCell', { pos: t(`layout.pos_${col}_${row}`) })}
                onClick={() =>
                  update('layout align', (current) => {
                    const cell = cellOf(col, row);
                    return current.justify === 'spaceBetween' ? { align: cell.align } : cell;
                  })
                }
              />
            )),
          )}
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={layout.justify === 'spaceBetween'}
            onChange={(event) =>
              update('layout justify', () => ({ justify: event.target.checked ? 'spaceBetween' : 'start' }))
            }
          />
          {t('layout.spaceBetween')}
        </label>
      </div>
      <div className="layout-row">
        {separate ? (
          <div className="corner-grid">
            {(['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const).map((key, i) => (
              <NumberField
                key={key}
                label={t(`layout.${key}`)}
                value={layout.padding[i]!}
                min={0}
                onCommit={(v) =>
                  update('layout padding', (current) => {
                    const next = [...current.padding] as [number, number, number, number];
                    next[i] = v;
                    return { padding: next };
                  })
                }
              />
            ))}
          </div>
        ) : (
          <>
            <NumberField
              label={t('layout.paddingH')}
              value={left}
              mixed={left !== right}
              min={0}
              onCommit={(v) => update('layout padding', (c) => ({ padding: [c.padding[0], v, c.padding[2], v] }))}
            />
            <NumberField
              label={t('layout.paddingV')}
              value={top}
              mixed={top !== bottom}
              min={0}
              onCommit={(v) => update('layout padding', (c) => ({ padding: [v, c.padding[1], v, c.padding[3]] }))}
            />
          </>
        )}
        <IconButton title={t('layout.paddingSeparate')} active={separate} onClick={() => setSeparate((on) => !on)}>
          <Scan size={14} />
        </IconButton>
      </div>
      <div className="layout-row">
        {(['h', 'v'] as const).map((axis) => (
          <label className="field layout-sizing" key={axis}>
            <span className="field-label">{t(axis === 'h' ? 'layout.width' : 'layout.height')}</span>
            <select
              className="select"
              value={layout.sizing[axis]}
              onChange={(event) =>
                update('layout sizing', (c) => ({
                  sizing: { ...c.sizing, [axis]: event.target.value as 'fixed' | 'hug' },
                }))
              }
            >
              <option value="fixed">{t('layout.fixed')}</option>
              <option value="hug">{t('layout.hug')}</option>
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

/** 选中的对象都直接放在自动布局画框里 */
export function inAutoLayout(editor: Editor, nodes: readonly SceneNode[]): boolean {
  return (
    nodes.length > 0 &&
    nodes.every((n) => {
      const parent = n.parent ? editor.store.get(n.parent) : undefined;
      return parent?.type === 'frame' && !!parent.layout;
    })
  );
}

/** 自动布局画框里的子对象：宽高固定还是填满，参不参与排列 */
export function ItemLayoutFields({ editor, nodes }: { editor: Editor; nodes: readonly SceneNode[] }): ReactNode {
  const { t } = useTranslation();
  const first = nodes[0]!;
  const sizing = first.layoutSizing ?? DEFAULT_ITEM_SIZING;
  const ignored = nodes.every((n) => n.layoutIgnore);
  const set = (label: string, patch: (node: SceneNode) => Partial<SceneNode>): void => {
    editor.updateSelection(label, (node) => patch(node));
    editor.store.sealHistory();
  };
  const setSizing = (axis: 'h' | 'v', value: 'fixed' | 'fill'): void =>
    set('layout sizing', (node) => {
      const next: ItemLayoutSizing = { ...(node.layoutSizing ?? DEFAULT_ITEM_SIZING), [axis]: value };
      return { layoutSizing: next.h === 'fixed' && next.v === 'fixed' ? undefined : next };
    });

  return (
    <div className="layout-fields">
      {!ignored && (
        <div className="layout-row">
          {(['h', 'v'] as const).map((axis) => (
            <label className="field layout-sizing" key={axis}>
              <span className="field-label">{t(axis === 'h' ? 'layout.width' : 'layout.height')}</span>
              <select
                className="select"
                value={
                  nodes.some((n) => (n.layoutSizing ?? DEFAULT_ITEM_SIZING)[axis] !== sizing[axis]) ? '' : sizing[axis]
                }
                onChange={(event) => setSizing(axis, event.target.value as 'fixed' | 'fill')}
              >
                <option value="fixed">{t('layout.fixed')}</option>
                <option value="fill">{t('layout.fill')}</option>
              </select>
            </label>
          ))}
        </div>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={ignored}
          onChange={(event) => set('layout ignore', () => ({ layoutIgnore: event.target.checked ? true : undefined }))}
        />
        {t('layout.ignore')}
      </label>
    </div>
  );
}
