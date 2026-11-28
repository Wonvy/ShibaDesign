import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CURVE_CHANNELS,
  IDENTITY_CURVE,
  curveFunction,
  isIdentityCurve,
  normalizeCurve,
  normalizeCurves,
  type CurveChannel,
  type CurvePoint,
  type ImageCurves,
} from '@shiba/core';

/** 曲线区域的边长（SVG 用户单位），实际显示时铺满面板宽度 */
const SIZE = 200;
/** 四周留出的空白，两端的控制点画在角上，不留的话会被切掉一半 */
const PAD = 6;
const FULL = SIZE + PAD * 2;
/** 点中控制点的范围，SVG 用户单位 */
const HIT = 10;
/** 相邻两个控制点在 x 上至少隔多远，拖动时不会越过邻居 */
const GAP = 0.01;

const CHANNEL_COLORS: Record<CurveChannel, string> = {
  rgb: 'var(--text)',
  red: '#e5484d',
  green: '#30a46c',
  blue: '#3e7bfa',
};

const toSvg = (point: CurvePoint): [number, number] => [point.x * SIZE, (1 - point.y) * SIZE];

/** 曲线画成折线：取 65 个点，足够平滑 */
function curvePath(points: readonly CurvePoint[] | undefined): string {
  const f = curveFunction(points);
  const parts: string[] = [];
  for (let i = 0; i <= 64; i++) {
    const x = i / 64;
    const [sx, sy] = toSvg({ x, y: f(x) });
    parts.push(`${i === 0 ? 'M' : 'L'}${sx.toFixed(2)} ${sy.toFixed(2)}`);
  }
  return parts.join('');
}

/**
 * 曲线编辑器：上面选通道（RGB 是总曲线），下面是曲线。
 * 在空白处按下添加一个控制点并接着拖；拖控制点改它的位置（不会越过左右的邻居）；双击控制点删掉它（两端的点删不掉）。
 * 拖动时连续调用 onChange(…, true)，松手后调用 onCommit，整个拖动是一步撤销。
 * 曲线变回直线时那个通道从文档里去掉，全都是直线时整个字段去掉
 */
export function CurveEditor(props: {
  curves: ImageCurves | undefined;
  onChange: (curves: ImageCurves | undefined, dragging: boolean) => void;
  onCommit: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const { curves, onChange, onCommit } = props;
  const [channel, setChannel] = useState<CurveChannel>('rgb');
  const svgRef = useRef<SVGSVGElement>(null);
  /** 正在拖的控制点；拖动过程中文档会变，所以在按下时记下整条曲线，按它来改 */
  const drag = useRef<{ index: number; points: CurvePoint[] } | null>(null);

  const points = normalizeCurve(curves?.[channel]) ?? [...IDENTITY_CURVE];

  const position = (event: MouseEvent): CurvePoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * (FULL / SIZE) - PAD / SIZE;
    const y = 1 - (((event.clientY - rect.top) / rect.height) * (FULL / SIZE) - PAD / SIZE);
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  };

  const write = (next: CurvePoint[], dragging: boolean): void => {
    onChange(normalizeCurves({ ...curves, [channel]: next }), dragging);
  };

  /** 这个位置附近的控制点；SVG 显示得比 SIZE 小时，按屏幕上的距离放宽 */
  const nearest = (at: CurvePoint): number => {
    const scale = FULL / svgRef.current!.getBoundingClientRect().width;
    return points.findIndex((p) => Math.hypot((p.x - at.x) * SIZE, (p.y - at.y) * SIZE) <= HIT * Math.max(1, scale));
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    const at = position(event);
    let index = nearest(at);
    let next = points;
    if (index < 0) {
      // 在空白处按下：在这里加一个点，接着拖它
      next = [...points, at].sort((a, b) => a.x - b.x);
      index = next.indexOf(at);
      // 太挤（和邻居几乎重合）时不加
      const prev = next[index - 1];
      const after = next[index + 1];
      if ((prev && at.x - prev.x < GAP) || (after && after.x - at.x < GAP)) return;
      write(next, true);
    }
    drag.current = { index, points: next };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    const current = drag.current;
    if (!current) return;
    const at = position(event);
    const { index, points: base } = current;
    const prev = base[index - 1];
    const after = base[index + 1];
    const x = Math.max(prev ? prev.x + GAP : 0, Math.min(after ? after.x - GAP : 1, at.x));
    const next = base.map((p, i) => (i === index ? { x, y: at.y } : p));
    drag.current = { index, points: next };
    write(next, true);
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>): void => {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit();
  };

  const remove = (index: number): void => {
    if (index <= 0 || index >= points.length - 1) return;
    write(
      points.filter((_, i) => i !== index),
      false,
    );
    onCommit();
  };

  const others = CURVE_CHANNELS.filter((c) => c !== channel && !isIdentityCurve(curves?.[c]));

  return (
    <div className="curve-editor">
      <div className="curve-toolbar">
        <div className="segmented segmented-small" role="radiogroup" aria-label={t('curves.channel')}>
          {CURVE_CHANNELS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={channel === c}
              className={channel === c ? 'is-active' : ''}
              onClick={() => setChannel(c)}
            >
              {t(`curves.${c}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-btn text-btn-small"
          disabled={!normalizeCurves(curves)}
          onClick={() => {
            onChange(undefined, false);
            onCommit();
          }}
        >
          {t('curves.reset')}
        </button>
      </div>
      <svg
        ref={svgRef}
        className="curve-canvas"
        viewBox={`${-PAD} ${-PAD} ${FULL} ${FULL}`}
        role="img"
        aria-label={t('curves.label', { channel: t(`curves.${channel}`) })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => remove(nearest(position(event)))}
      >
        <rect className="curve-area" x={0} y={0} width={SIZE} height={SIZE} />
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v} className="curve-grid">
            <line x1={v * SIZE} y1={0} x2={v * SIZE} y2={SIZE} />
            <line x1={0} y1={v * SIZE} x2={SIZE} y2={v * SIZE} />
          </g>
        ))}
        <line className="curve-diagonal" x1={0} y1={SIZE} x2={SIZE} y2={0} />
        {others.map((c) => (
          <path key={c} className="curve-other" d={curvePath(curves?.[c])} stroke={CHANNEL_COLORS[c]} />
        ))}
        <path className="curve-line" d={curvePath(points)} stroke={CHANNEL_COLORS[channel]} />
        {points.map((point, i) => {
          const [x, y] = toSvg(point);
          return <circle key={i} className="curve-point" cx={x} cy={y} r={4} />;
        })}
      </svg>
      <p className="menu-hint">{t('curves.hint')}</p>
    </div>
  );
}
