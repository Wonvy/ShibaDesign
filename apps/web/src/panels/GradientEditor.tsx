import { ArrowLeftRight, Trash2 } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GRADIENT_KINDS,
  RADIAL_DEFAULT,
  gradientColorAt,
  linearGradientAngle,
  linearGradientPoints,
  normalizeStops,
  reverseStops,
  toCssColor,
  type GradientFill,
  type GradientKind,
  type GradientStop,
  type Rect,
} from '@shiba/core';
import { ColorField, IconButton, NumberField } from '../ui/controls';

/** 色标位置保留的精度 */
const round = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * 渐变编辑器：类型、角度、反向，以及一条可以直接操作的色条：
 * 拖动色标改位置，点色条的空白处加一个色标，选中的色标可以改颜色、不透明度或删掉。
 *
 * @param update 对每个选中的节点算出新的渐变。bounds 是那个节点的外框，按画面角度摆渐变时要用
 * @param mergeKey 连续的修改（拖动色标、拖动取色器）合成一步撤销
 */
export function GradientEditor(props: {
  fill: GradientFill;
  bounds: Rect;
  update: (next: (fill: GradientFill, bounds: Rect) => GradientFill, mergeKey?: string) => void;
  seal: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const { fill, bounds, update, seal } = props;
  const [selected, setSelected] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const stops = fill.stops;
  const index = Math.min(selected, stops.length - 1);
  const stop = stops[index]!;

  const setStops = (next: (stops: readonly GradientStop[]) => GradientStop[], mergeKey?: string): void =>
    update((f) => ({ ...f, stops: next(f.stops) }), mergeKey);

  const offsetAt = (clientX: number): number => {
    const rect = bar.current!.getBoundingClientRect();
    return round(Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1))));
  };

  /** 拖完把色标按位置排好，选中的仍是刚才拖的那个 */
  const finishDrag = (): void => {
    const current = drag.current;
    drag.current = null;
    if (!current?.moved) return;
    const moved = stops[current.index];
    const sorted = normalizeStops(stops);
    setSelected(
      Math.max(
        0,
        sorted.findIndex((s) => s === moved || (moved && s.offset === moved.offset && s.color === moved.color)),
      ),
    );
    setStops(normalizeStops, 'gradient-stop');
    seal();
  };

  const onHandleDown = (event: ReactPointerEvent<HTMLButtonElement>, i: number): void => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(i);
    drag.current = { index: i, moved: false };
  };

  const onHandleMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (!current) return;
    current.moved = true;
    const offset = offsetAt(event.clientX);
    setStops((list) => list.map((s, i) => (i === current.index ? { ...s, offset } : s)), 'gradient-stop');
  };

  const onBarDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // 在空白处加一个色标，颜色取渐变在这里原本的颜色，加上之后看起来没有变化
    const offset = offsetAt(event.clientX);
    const color = gradientColorAt(normalizeStops(stops), offset);
    const next = normalizeStops([...stops, { offset, color }]);
    setStops(() => next);
    seal();
    setSelected(next.findIndex((s) => s.offset === offset && s.color === color));
  };

  const preview = normalizeStops(stops)
    .map((s) => `${toCssColor(s.color)} ${round(s.offset * 100)}%`)
    .join(', ');
  const angle = linearGradientAngle(fill, bounds.w, bounds.h);

  return (
    <div className="gradient-editor">
      <div className="prop-controls">
        <div className="segmented segmented-small" role="radiogroup" aria-label={t('gradient.kind')}>
          {GRADIENT_KINDS.map((kind: GradientKind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={fill.kind === kind}
              className={fill.kind === kind ? 'is-active' : ''}
              onClick={() => {
                update((f, b) => ({
                  ...f,
                  kind,
                  ...(kind === 'linear' ? linearGradientPoints(90, b.w, b.h) : RADIAL_DEFAULT),
                  aspect: undefined,
                }));
                seal();
              }}
            >
              {t(`gradient.${kind}`)}
            </button>
          ))}
        </div>
        {fill.kind === 'linear' && (
          <NumberField
            label=""
            value={angle}
            min={-360}
            max={360}
            suffix="°"
            onCommit={(v) => {
              update((f, b) => ({ ...f, ...linearGradientPoints(v, b.w, b.h) }));
              seal();
            }}
          />
        )}
        <IconButton
          title={t('gradient.reverse')}
          onClick={() => {
            setStops(reverseStops);
            seal();
          }}
        >
          <ArrowLeftRight size={14} />
        </IconButton>
      </div>

      <div className="gradient-bar" ref={bar} onPointerDown={onBarDown} title={t('gradient.addStop')}>
        <div className="gradient-bar-fill" style={{ background: `linear-gradient(to right, ${preview})` }} />
        {stops.map((s, i) => (
          <button
            key={i}
            type="button"
            className={`gradient-stop${i === index ? ' is-selected' : ''}`}
            style={{ left: `${s.offset * 100}%`, background: toCssColor({ ...s.color, a: 1 }) }}
            aria-label={`${t('gradient.stop')} ${i + 1}`}
            onPointerDown={(e) => onHandleDown(e, i)}
            onPointerMove={onHandleMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          />
        ))}
      </div>

      <div className="prop-controls">
        <ColorField
          label={t('gradient.stop')}
          value={{ ...stop.color, a: 1 }}
          onChange={(color) =>
            setStops(
              (list) => list.map((s, i) => (i === index ? { ...s, color: { ...color, a: s.color.a } } : s)),
              'gradient-color',
            )
          }
          onCommit={seal}
        />
        <NumberField
          label=""
          value={Math.round(stop.color.a * 100)}
          min={0}
          max={100}
          suffix="%"
          onCommit={(v) => {
            setStops((list) => list.map((s, i) => (i === index ? { ...s, color: { ...s.color, a: v / 100 } } : s)));
            seal();
          }}
        />
        <IconButton
          title={t('gradient.removeStop')}
          disabled={stops.length <= 2}
          onClick={() => {
            setStops((list) => list.filter((_, i) => i !== index));
            setSelected(Math.max(0, index - 1));
            seal();
          }}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
    </div>
  );
}
