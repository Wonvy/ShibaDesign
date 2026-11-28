import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NO_ADJUSTMENTS, type ImageAdjustments, type ImageFill, type SceneNode } from '@shiba/core';
import { NumberField } from '../ui/controls';
import { useEditorState } from '../editor/context';
import type { PanelProps } from './registry';

type FrameKey = 'zoom' | 'panX' | 'panY';

const COLOR: { key: keyof ImageAdjustments; min: number; max: number }[] = [
  { key: 'brightness', min: -100, max: 100 },
  { key: 'contrast', min: -100, max: 100 },
  { key: 'saturation', min: -100, max: 100 },
  { key: 'temperature', min: -100, max: 100 },
  { key: 'tint', min: -100, max: 100 },
  { key: 'hue', min: -180, max: 180 },
  { key: 'blur', min: 0, max: 100 },
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

/** 一行：名称、滑块、数值。拖滑块时连续更新，松手后才算一步撤销 */
function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number, dragging: boolean) => void;
  onCommit: () => void;
}): ReactNode {
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
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value), true)}
          onPointerUp={props.onCommit}
          onKeyUp={props.onCommit}
          onBlur={props.onCommit}
          onDoubleClick={() => {
            // 双击滑块回到默认值
            props.onChange(Math.min(props.max, Math.max(props.min, props.min > 0 ? props.min : 0)), false);
            props.onCommit();
          }}
        />
        <NumberField
          label=""
          value={props.value}
          min={props.min}
          max={props.max}
          onCommit={(v) => {
            props.onChange(Math.round(v), false);
            props.onCommit();
          }}
        />
      </div>
    </div>
  );
}

/**
 * 图片调整：调色、模糊，以及图片在形状里的缩放和位置。
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

  const setColor = (key: keyof ImageAdjustments, value: number, dragging: boolean): void =>
    update(
      'adjust image',
      (fill) => {
        const next = { ...NO_ADJUSTMENTS, ...fill.adjust, [key]: value };
        const { adjust: _previous, ...rest } = fill;
        // 所有参数都回到 0 时把整个字段去掉，文档里不留一堆没有意义的零
        return Object.values(next).every((v) => v === 0) ? rest : { ...rest, adjust: next };
      },
      dragging ? `adjust:${key}` : undefined,
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

  const changed = first.adjust !== undefined || FRAME.some(({ key }) => first[key] !== undefined);
  const onCanvas = fillEditing?.kind === 'image' && fillEditing.id === nodes[0]?.id;

  return (
    <div className="appearance">
      {COLOR.map(({ key, min, max }) => (
        <SliderRow
          key={key}
          label={t(`adjust.${key}`)}
          value={Math.round(adjust[key])}
          min={min}
          max={max}
          onChange={(value, dragging) => setColor(key, value, dragging)}
          onCommit={seal}
        />
      ))}
      <div className="appearance-divider" />
      {FRAME.map(({ key, min, max, fallback }) => (
        <SliderRow
          key={key}
          label={t(`adjust.${key}`)}
          value={Math.round((first[key] ?? fallback / 100) * 100)}
          min={min}
          max={max}
          onChange={(value, dragging) => setFrame(key, value, fallback, dragging)}
          onCommit={seal}
        />
      ))}
      <div className="button-row">
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
