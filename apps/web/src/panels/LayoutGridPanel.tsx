import { Eye, EyeOff, Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LAYOUT_GRID_TYPES, defaultLayoutGrid, type LayoutGrid, type SceneNode } from '@shiba/core';
import { ColorField, IconButton, NumberField } from '../ui/controls';
import type { PanelProps } from './registry';

const gridsOf = (node: SceneNode): readonly LayoutGrid[] =>
  node.type === 'frame' || node.type === 'artboard' ? (node.layoutGrids ?? []) : [];

/**
 * 版面网格：列、行、方格，可以叠好几个。列（行）有数量、间隔、边距，宽度可以拉伸或固定（固定时选放在哪），
 * 方格有格子大小；都有颜色、开关、删除。几个画框（画板）一起选中时显示第一个的，改了统一成这一套
 */
export function LayoutGridPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const first = nodes[0];
  if (!first) return null;
  const grids = gridsOf(first);
  const write = (next: readonly LayoutGrid[], mergeKey?: string): void =>
    editor.updateSelection(
      'layout grids',
      (node) =>
        node.type === 'frame' || node.type === 'artboard' ? { layoutGrids: next.length > 0 ? next : undefined } : null,
      mergeKey,
    );
  const seal = (): void => editor.store.sealHistory();
  const commit = (index: number, grid: LayoutGrid): void => {
    write(grids.map((g, i) => (i === index ? grid : g)));
    seal();
  };

  return (
    <div className="effects">
      {grids.map((grid, index) => (
        <div className="effect" key={index}>
          <div className="effect-head">
            <select
              className="select"
              aria-label={t('grids.type')}
              value={grid.type}
              onChange={(event) => {
                const type = event.target.value as LayoutGrid['type'];
                const next = defaultLayoutGrid(type);
                commit(index, { ...next, color: grid.color, ...(grid.hidden ? { hidden: true } : {}) } as LayoutGrid);
              }}
            >
              {LAYOUT_GRID_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`grids.${type}`)}
                </option>
              ))}
            </select>
            <IconButton
              title={t(grid.hidden ? 'grids.show' : 'grids.hide')}
              onClick={() => commit(index, { ...grid, hidden: grid.hidden ? undefined : true })}
            >
              {grid.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
            <IconButton
              title={t('prop.remove')}
              onClick={() => {
                write(grids.filter((_, i) => i !== index));
                seal();
              }}
            >
              <Minus size={14} />
            </IconButton>
          </div>
          {grid.type === 'grid' ? (
            <div className="field-grid">
              <NumberField
                label={t('grids.cellSize')}
                value={grid.size}
                min={1}
                onCommit={(v) => commit(index, { ...grid, size: v })}
              />
            </div>
          ) : (
            <>
              <div className="field-grid">
                <NumberField
                  label={t('grids.count')}
                  value={grid.count}
                  min={1}
                  max={200}
                  onCommit={(v) => commit(index, { ...grid, count: Math.round(v) })}
                />
                <NumberField
                  label={t('grids.gutter')}
                  value={grid.gutter}
                  min={0}
                  onCommit={(v) => commit(index, { ...grid, gutter: v })}
                />
                <NumberField
                  label={t('grids.margin')}
                  value={grid.margin}
                  min={0}
                  onCommit={(v) => commit(index, { ...grid, margin: v })}
                />
                <label className="field" title={t('grids.sizeHint')}>
                  <span className="field-label">{t('grids.size')}</span>
                  <input
                    className="field-input"
                    inputMode="decimal"
                    placeholder="—"
                    defaultValue={grid.size ?? ''}
                    key={`${index}-${grid.size ?? ''}`}
                    onBlur={(event) => {
                      const text = event.target.value.trim();
                      const value = Number(text);
                      const { size: _old, align: _align, ...rest } = grid;
                      if (text === '') commit(index, rest);
                      else if (Number.isFinite(value) && value >= 0) commit(index, { ...grid, size: value });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                </label>
              </div>
              {grid.size !== undefined && (
                <div className="segmented segmented-small" role="radiogroup" aria-label={t('grids.align')}>
                  {(['start', 'center', 'end'] as const).map((align) => (
                    <button
                      key={align}
                      type="button"
                      role="radio"
                      aria-checked={(grid.align ?? 'start') === align}
                      className={(grid.align ?? 'start') === align ? 'is-active' : ''}
                      onClick={() => commit(index, { ...grid, align: align === 'start' ? undefined : align })}
                    >
                      {t(`grids.align_${align}`)}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="effect-color">
            <ColorField
              label={t('grids.color')}
              value={grid.color}
              onChange={(color) =>
                write(
                  grids.map((g, i) => (i === index ? { ...g, color } : g)),
                  `grid-color-${index}`,
                )
              }
              onCommit={seal}
            />
            <NumberField
              label="%"
              value={Math.round(grid.color.a * 100)}
              min={0}
              max={100}
              onCommit={(v) => commit(index, { ...grid, color: { ...grid.color, a: v / 100 } })}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        className="effect-add"
        onClick={() => {
          write([...grids, defaultLayoutGrid('columns')]);
          seal();
        }}
      >
        <Plus size={14} />
        {t('grids.add')}
      </button>
    </div>
  );
}
