import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NO_ADJUSTMENTS, type ImageAdjustments, type ImageCurves, type ImageFill, type SceneNode } from '@shiba/core';
import { NumberField } from '../ui/controls';
import { useEditorState } from '../editor/context';
import { CurveEditor } from './CurveEditor';
import { FilterPresets } from './FilterPresets';
import type { PanelProps } from './registry';

type FrameKey = 'zoom' | 'panX' | 'panY';
type SliderKey = keyof ImageAdjustments;

interface SliderSpec {
  key: SliderKey;
  min: number;
  max: number;
  /** 默认值（双击滑块回到它；等于它的可选项不存进文档） */
  fallback: number;
  step?: number;
}

const COLOR: SliderSpec[] = [
  { key: 'brightness', min: -100, max: 100, fallback: 0 },
  { key: 'contrast', min: -100, max: 100, fallback: 0 },
  { key: 'saturation', min: -100, max: 100, fallback: 0 },
  { key: 'temperature', min: -100, max: 100, fallback: 0 },
  { key: 'tint', min: -100, max: 100, fallback: 0 },
  { key: 'hue', min: -180, max: 180, fallback: 0 },
];

const DETAIL: SliderSpec[] = [
  { key: 'sharpen', min: 0, max: 200, fallback: 0 },
  { key: 'sharpenRadius', min: 0.1, max: 10, fallback: 1, step: 0.1 },
  { key: 'blur', min: 0, max: 100, fallback: 0 },
];

/** 画面内的缩放和位置。界面上用百分比，文档里存的是倍数和 -1 到 1 的比例 */
const FRAME: { key: FrameKey; min: number; max: number; fallback: number }[] = [
  { key: 'zoom', min: 100, max: 400, fallback: 100 },
  { key: 'panX', min: -100, max: 100, fallback: 0 },
  { key: 'panY', min: -100, max: 100, fallback: 0 },
];

function imageFillOf(node: SceneNode): ImageFill | null {
  return 'fill' in node && node.fill?.type === 'image' ? node.fill : null;
}

/**
 * 整理调整参数，存进文档之前用：可选的锐化在不锐化时去掉（连同半径），半径是默认的 1 时去掉；
 * 全都是默认值时返回 undefined，文档里不留一堆没有意义的零
 */
function cleanAdjustments(adjust: ImageAdjustments): ImageAdjustments | undefined {
  const { sharpen, sharpenRadius, ...base } = adjust;
  const next: ImageAdjustments = { ...base };
  if (sharpen) {
    next.sharpen = sharpen;
    if (sharpenRadius !== undefined && sharpenRadius !== 1) next.sharpenRadius = sharpenRadius;
  }
  return Object.values(next).every((v) => v === 0) ? undefined : next;
}

/** 一行：名称、滑块、数值。拖滑块时连续更新，松手后才算一步撤销 */
function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  fallback: number;
  disabled?: boolean;
  onChange: (value: number, dragging: boolean) => void;
  onCommit: () => void;
}): ReactNode {
  const step = props.step ?? 1;
  const round = (v: number): number => Math.round(v / step) * step;
  return (
    <div className="prop-row">
      <span className="prop-label">{props.label}</span>
      <div className="prop-controls">
        <input
          type="range"
          className="slider"
          aria-label={props.label}
          min={props.min}
          max={props.max}
          step={step}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(Number(e.target.value), true)}
          onPointerUp={props.onCommit}
          onKeyUp={props.onCommit}
          onBlur={props.onCommit}
          onDoubleClick={() => {
            // 双击滑块回到默认值
            props.onChange(props.fallback, false);
            props.onCommit();
          }}
        />
        <NumberField
          label=""
          value={props.value}
          min={props.min}
          max={props.max}
          disabled={props.disabled}
          onCommit={(v) => {
            props.onChange(round(v), false);
            props.onCommit();
          }}
        />
      </div>
    </div>
  );
}

/**
 * 图片调整：滤镜预设、调色、曲线、锐化和模糊，以及图片在形状里的缩放和位置。
 * 全部是非破坏性的——改的只是一组参数，原图不动。多选时显示第一张图片的值，修改作用于全部图片。
 */
export function ImagePanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const { store } = editor;
  const seal = useCallback(() => store.sealHistory(), [store]);
  const fillEditing = useEditorState((s) => s.fillEditing);
  const first = nodes.map(imageFillOf).find((fill) => fill !== null);
  if (!first) return null;
  const adjust = first.adjust ?? NO_ADJUSTMENTS;

  const update = (label: string, change: (fill: ImageFill) => ImageFill, mergeKey?: string): void =>
    editor.updateSelection(
      label,
      (node) => {
        const fill = imageFillOf(node);
        return fill ? { fill: change(fill) } : null;
      },
      mergeKey,
    );

  /** 把 fill 上的一个可选字段设成 value；value 是 undefined 时去掉这个字段 */
  const withField = <K extends 'adjust' | 'curves' | 'filter'>(
    fill: ImageFill,
    key: K,
    value: ImageFill[K] | undefined,
  ): ImageFill => {
    const { [key]: _previous, ...rest } = fill;
    return (value === undefined ? rest : { ...rest, [key]: value }) as ImageFill;
  };

  const setAdjust = (key: SliderKey, value: number, dragging: boolean): void =>
    update(
      'adjust image',
      (fill) => withField(fill, 'adjust', cleanAdjustments({ ...NO_ADJUSTMENTS, ...fill.adjust, [key]: value })),
      dragging ? `adjust:${key}` : undefined,
    );

  const setCurves = (curves: ImageCurves | undefined, dragging: boolean): void =>
    update('image curves', (fill) => withField(fill, 'curves', curves), dragging ? 'curves' : undefined);

  const setFilter = (preset: string | null): void => {
    // 换预设时沿用现在的强度，第一次选时是 100
    const amount = first.filter?.amount ?? 100;
    update('image filter', (fill) => withField(fill, 'filter', preset ? { preset, amount } : undefined));
    seal();
  };

  const setFilterAmount = (amount: number, dragging: boolean): void =>
    update(
      'image filter',
      (fill) => (fill.filter ? withField(fill, 'filter', { ...fill.filter, amount }) : fill),
      dragging ? 'filter:amount' : undefined,
    );

  const setFrame = (key: FrameKey, percent: number, fallback: number, dragging: boolean): void =>
    update(
      'frame image',
      (fill) => {
        const { [key]: _previous, ...rest } = fill;
        return percent === fallback ? rest : { ...rest, [key]: percent / 100 };
      },
      dragging ? `frame:${key}` : undefined,
    );

  const reset = (): void => {
    update('reset image', ({ type, assetId, fit }) => ({ type, assetId, fit }));
    seal();
  };

  const changed =
    first.adjust !== undefined ||
    first.curves !== undefined ||
    first.filter !== undefined ||
    FRAME.some(({ key }) => first[key] !== undefined);
  const onCanvas = fillEditing?.kind === 'image' && fillEditing.id === nodes[0]?.id;

  const slider = ({ key, min, max, fallback, step }: SliderSpec, disabled = false): ReactNode => (
    <SliderRow
      key={key}
      label={t(`adjust.${key}`)}
      value={adjust[key] ?? fallback}
      min={min}
      max={max}
      step={step}
      fallback={fallback}
      disabled={disabled}
      onChange={(value, dragging) => setAdjust(key, value, dragging)}
      onCommit={seal}
    />
  );

  return (
    <div className="image-panel">
      <h4 className="image-subtitle">{t('adjust.filter')}</h4>
      <FilterPresets editor={editor} fill={first} onSelect={setFilter} />
      {first.filter && (
        <div className="appearance">
          <SliderRow
            label={t('adjust.filterAmount')}
            value={first.filter.amount}
            min={0}
            max={100}
            fallback={100}
            onChange={setFilterAmount}
            onCommit={seal}
          />
        </div>
      )}

      <h4 className="image-subtitle">{t('adjust.color')}</h4>
      <div className="appearance">{COLOR.map((spec) => slider(spec))}</div>

      <h4 className="image-subtitle">{t('adjust.curves')}</h4>
      <CurveEditor curves={first.curves} onChange={setCurves} onCommit={seal} />

      <h4 className="image-subtitle">{t('adjust.detail')}</h4>
      <div className="appearance">
        {DETAIL.map((spec) => slider(spec, spec.key === 'sharpenRadius' && !adjust.sharpen))}
      </div>

      <h4 className="image-subtitle">{t('adjust.frame')}</h4>
      <div className="appearance">
        {FRAME.map(({ key, min, max, fallback }) => (
          <SliderRow
            key={key}
            label={t(`adjust.${key}`)}
            value={Math.round((first[key] ?? fallback / 100) * 100)}
            min={min}
            max={max}
            fallback={fallback}
            onChange={(value, dragging) => setFrame(key, value, fallback, dragging)}
            onCommit={seal}
          />
        ))}
      </div>
      <div className="button-row image-actions">
        {nodes.length === 1 && (
          <button
            type="button"
            className={`text-btn reset-btn${onCanvas ? ' is-primary' : ''}`}
            onClick={() => editor.setFillEditing(onCanvas ? null : { id: nodes[0]!.id, kind: 'image' })}
          >
            {t('adjust.onCanvas')}
          </button>
        )}
        <button type="button" className="text-btn reset-btn" disabled={!changed} onClick={reset}>
          {t('adjust.reset')}
        </button>
      </div>
    </div>
  );
}
