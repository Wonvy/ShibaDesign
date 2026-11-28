import { ImagePlus, Minus, Plus, Replace } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BLEND_MODES,
  IMAGE_FITS,
  STROKE_CAPS,
  STROKE_JOINS,
  dashKind,
  dashPreset,
  defaultGradient,
  hasShapeStyle,
  solid,
  type BlendMode,
  type Fill,
  type GradientFill,
  type ImageFit,
  type Rect,
  type SceneNode,
  type Stroke,
  type StrokeCap,
  type StrokeJoin,
} from '@shiba/core';
import { DEFAULT_FILL, DEFAULT_STROKE, type Editor } from '@shiba/editor';
import { useEditorState } from '../editor/context';
import { pickImageFill } from '../files';
import { ColorField, IconButton, NumberField } from '../ui/controls';
import { GradientEditor } from './GradientEditor';
import { ColorStyleField } from './StylePickers';
import type { PanelProps } from './registry';

/** 有填充的节点。文本的颜色可以按字设置，放在文本面板里改，这里不管 */
const hasFill = (node: SceneNode): node is Extract<SceneNode, { fill: unknown }> =>
  'fill' in node && node.type !== 'text';

/** 能用图片作填充的节点：形状类。画板和文本目前只支持纯色 */
const canHoldImage = (node: SceneNode): boolean => hasShapeStyle(node);

type FillKind = Fill['type'];

const FILL_LABELS: Record<FillKind, string> = {
  solid: 'prop.fillSolid',
  gradient: 'prop.fillGradient',
  image: 'prop.fillImage',
};

const FIT_LABELS: Record<ImageFit, string> = {
  cover: 'image.fitCover',
  contain: 'image.fitContain',
  stretch: 'image.fitStretch',
};

const DASH_KINDS = ['solid', 'dashed', 'dotted'] as const;
const CAP_LABELS: Record<StrokeCap, string> = {
  butt: 'prop.capButt',
  round: 'prop.capRound',
  square: 'prop.capSquare',
};
const JOIN_LABELS: Record<StrokeJoin, string> = {
  miter: 'prop.joinMiter',
  round: 'prop.joinRound',
  bevel: 'prop.joinBevel',
};

/** 一串用空格或逗号分开的长度；有一项不是非负数就返回 null */
function parseDash(text: string): number[] | null {
  const parts = text.split(/[\s,，]+/).filter(Boolean);
  if (parts.length === 0) return [];
  const values = parts.map(Number);
  return values.every((v) => Number.isFinite(v) && v >= 0) && values.length <= 16 ? values : null;
}

/** 虚线间隔的输入框：输入时只改草稿，回车或失焦时提交，写错了恢复原样 */
function DashField(props: { value: readonly number[]; label: string; onCommit: (dash: number[]) => void }): ReactNode {
  const shown = props.value.map((v) => String(Math.round(v * 100) / 100)).join(' ');
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string): void => {
    setDraft(null);
    const parsed = parseDash(text);
    if (parsed && parsed.join(' ') !== props.value.join(' ')) props.onCommit(parsed);
  };
  return (
    <label className="field">
      <input
        className="field-input"
        aria-label={props.label}
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/** 资源库里一张图片的小预览 */
function AssetThumb({ editor, assetId }: { editor: Editor; assetId: string }): ReactNode {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const bytes = editor.assets.get(assetId);
    if (!bytes) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: editor.assets.meta(assetId)?.mime }));
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [editor, assetId]);
  return <span className="asset-thumb" style={url ? { backgroundImage: `url("${url}")` } : undefined} />;
}

/** 外观：填充、描边、不透明度、混合模式。多选时显示第一个对象的值，修改作用于全部 */
export function AppearancePanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const { store } = editor;
  const seal = useCallback(() => store.sealHistory(), [store]);

  const fillable = nodes.filter(hasFill);
  const strokable = nodes.filter(hasShapeStyle);
  const fill: Fill | null = fillable[0]?.fill ?? null;
  const stroke = strokable[0]?.stroke ?? null;
  const first = nodes[0]!;
  const imageAllowed = nodes.some(canHoldImage);

  const setFill = (next: Fill | null, mergeKey?: string): void =>
    editor.updateSelection(
      'fill',
      (node) => {
        if (!hasFill(node)) return null;
        // 图片填充只给形状；选区里的画板和文本保持原样
        if (next?.type === 'image' && !canHoldImage(node)) return null;
        return { fill: next } as { fill: Fill | null };
      },
      mergeKey,
    );

  const setStroke = (next: Stroke | null, mergeKey?: string): void =>
    editor.updateSelection('stroke', (node) => (hasShapeStyle(node) ? { stroke: next } : null), mergeKey);
  /** 改每个对象自己描边的某几项，其余保持原样 */
  const patchStroke = (patch: Partial<Stroke>, mergeKey?: string): void => {
    editor.updateSelection(
      'stroke',
      (node) => (hasShapeStyle(node) && node.stroke ? { stroke: { ...node.stroke, ...patch } } : null),
      mergeKey,
    );
    if (!mergeKey) seal();
  };
  const kind = stroke ? dashKind(stroke) : 'solid';
  const fillEditing = useEditorState((s) => s.fillEditing);

  const removeFill = (
    <IconButton
      title={t('prop.remove')}
      onClick={() => {
        setFill(null);
        seal();
      }}
    >
      <Minus size={14} />
    </IconButton>
  );
  const chooseImage = (title: string, icon: ReactNode): ReactNode =>
    imageAllowed && (
      <IconButton title={title} onClick={() => void pickImageFill(editor)}>
        {icon}
      </IconButton>
    );

  /** 选中的每个节点按自己的外框算出新的渐变 */
  const updateGradient = (next: (fill: GradientFill, bounds: Rect) => GradientFill, mergeKey?: string): void =>
    editor.updateSelection(
      'fill',
      (node) =>
        hasFill(node) && node.fill?.type === 'gradient'
          ? ({ fill: next(node.fill, editor.geometry.localBounds(node)) } as { fill: Fill })
          : null,
      mergeKey,
    );

  /** 换填充的种类：纯色和渐变之间互换时保留颜色，换成图片时先选图片 */
  const switchFill = (kind: FillKind): void => {
    if (kind === fill?.type) return;
    if (kind === 'image') {
      void pickImageFill(editor);
      return;
    }
    editor.updateSelection('fill', (node) => {
      if (!hasFill(node)) return null;
      const current = node.fill;
      const color =
        current?.type === 'solid'
          ? current.color
          : current?.type === 'gradient'
            ? current.stops[0]!.color
            : DEFAULT_FILL;
      if (kind === 'solid') return { fill: solid(color) } as { fill: Fill };
      const bounds = editor.geometry.localBounds(node);
      return { fill: defaultGradient(color, 'linear', bounds.w, bounds.h) } as { fill: Fill };
    });
    seal();
  };
  const kinds: FillKind[] = imageAllowed ? ['solid', 'gradient', 'image'] : ['solid', 'gradient'];

  return (
    <div className="appearance">
      {fillable.length > 0 && (
        <div className="prop-row">
          <span className="prop-label">{t('prop.fill')}</span>
          <div className="prop-controls">
            {fill ? (
              <>
                <div className="segmented segmented-small" role="radiogroup" aria-label={t('prop.fill')}>
                  {kinds.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={fill.type === kind}
                      className={fill.type === kind ? 'is-active' : ''}
                      onClick={() => switchFill(kind)}
                    >
                      {t(FILL_LABELS[kind])}
                    </button>
                  ))}
                </div>
                {removeFill}
              </>
            ) : (
              <>
                <IconButton
                  title={t('prop.add')}
                  onClick={() => {
                    setFill(solid(DEFAULT_FILL));
                    seal();
                  }}
                >
                  <Plus size={14} />
                </IconButton>
                {chooseImage(t('image.useAsFill'), <ImagePlus size={14} />)}
              </>
            )}
          </div>
        </div>
      )}

      {fill?.type === 'solid' && (
        <div className="prop-row">
          <span className="prop-label" />
          <div className="prop-controls">
            <ColorStyleField
              editor={editor}
              target="fill"
              label={t('prop.fill')}
              value={fill.color}
              linked={fill.colorStyle}
              onChange={(color) => setFill(solid(color), 'fill-color')}
              onCommit={seal}
            />
          </div>
        </div>
      )}

      {fill?.type === 'gradient' && fillable[0] && (
        <div className="prop-row">
          <span className="prop-label" />
          <GradientEditor
            fill={fill}
            bounds={editor.geometry.localBounds(fillable[0])}
            update={updateGradient}
            seal={seal}
            onCanvas={
              nodes.length === 1
                ? {
                    active: fillEditing?.id === first.id && fillEditing.kind === 'gradient',
                    toggle: () =>
                      editor.setFillEditing(fillEditing?.id === first.id ? null : { id: first.id, kind: 'gradient' }),
                  }
                : undefined
            }
          />
        </div>
      )}

      {fill?.type === 'image' && (
        <div className="prop-row">
          <span className="prop-label" />
          <div className="prop-controls">
            <AssetThumb editor={editor} assetId={fill.assetId} />
            <select
              className="select"
              aria-label={t('image.fit')}
              value={fill.fit}
              onChange={(e) => {
                setFill({ ...fill, fit: e.target.value as ImageFit });
                seal();
              }}
            >
              {IMAGE_FITS.map((fit) => (
                <option key={fit} value={fit}>
                  {t(FIT_LABELS[fit])}
                </option>
              ))}
            </select>
            {chooseImage(t('image.replace'), <Replace size={14} />)}
          </div>
        </div>
      )}

      {strokable.length > 0 && (
        <div className="prop-row">
          <span className="prop-label">{t('prop.stroke')}</span>
          <div className="prop-controls">
            {stroke ? (
              <>
                <ColorStyleField
                  editor={editor}
                  target="stroke"
                  label={t('prop.stroke')}
                  value={stroke.color}
                  linked={stroke.colorStyle}
                  onChange={(c) => patchStroke({ color: c }, 'stroke-color')}
                  onCommit={seal}
                />
                <IconButton
                  title={t('prop.remove')}
                  onClick={() => {
                    setStroke(null);
                    seal();
                  }}
                >
                  <Minus size={14} />
                </IconButton>
              </>
            ) : (
              <IconButton
                title={t('prop.add')}
                onClick={() => {
                  setStroke({ color: DEFAULT_STROKE, width: 1 });
                  seal();
                }}
              >
                <Plus size={14} />
              </IconButton>
            )}
          </div>
        </div>
      )}

      {stroke && (
        <div className="prop-row">
          <span className="prop-label">{t('prop.strokeWidth')}</span>
          <div className="prop-controls">
            <NumberField
              label=""
              value={stroke.width}
              min={0}
              max={1000}
              onCommit={(v) => {
                // 用的是虚线、点线预设时，间隔跟着线宽一起变
                patchStroke(
                  kind === 'dashed' || kind === 'dotted' ? { width: v, ...dashPreset(kind, v) } : { width: v },
                );
              }}
            />
          </div>
        </div>
      )}

      {stroke && (
        <div className="prop-row">
          <span className="prop-label">{t('prop.strokeStyle')}</span>
          <div className="prop-controls">
            <div className="segmented segmented-small" role="radiogroup" aria-label={t('prop.strokeStyle')}>
              {DASH_KINDS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={kind === option}
                  className={kind === option ? 'is-active' : ''}
                  onClick={() => patchStroke(dashPreset(option, stroke.width))}
                >
                  {t(`prop.${option}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {stroke && kind !== 'solid' && (
        <div className="prop-row">
          <span className="prop-label">{t('prop.dashPattern')}</span>
          <div className="prop-controls field-grid">
            <DashField
              label={t('prop.dashPattern')}
              value={stroke.dash ?? []}
              onCommit={(dash) => patchStroke({ dash: dash.length > 0 ? dash : undefined })}
            />
            <NumberField
              label={t('prop.dashOffset')}
              value={stroke.dashOffset ?? 0}
              min={-100000}
              max={100000}
              onCommit={(v) => patchStroke({ dashOffset: v === 0 ? undefined : v })}
            />
          </div>
        </div>
      )}

      {stroke && (
        <div className="prop-row">
          <span className="prop-label">{t('prop.cap')}</span>
          <div className="prop-controls">
            <div className="segmented segmented-small" role="radiogroup" aria-label={t('prop.cap')}>
              {STROKE_CAPS.map((cap) => (
                <button
                  key={cap}
                  type="button"
                  role="radio"
                  aria-checked={(stroke.cap ?? 'butt') === cap}
                  className={(stroke.cap ?? 'butt') === cap ? 'is-active' : ''}
                  onClick={() => patchStroke({ cap: cap === 'butt' ? undefined : cap })}
                >
                  {t(CAP_LABELS[cap])}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {stroke && (
        <div className="prop-row">
          <span className="prop-label">{t('prop.join')}</span>
          <div className="prop-controls">
            <div className="segmented segmented-small" role="radiogroup" aria-label={t('prop.join')}>
              {STROKE_JOINS.map((join) => (
                <button
                  key={join}
                  type="button"
                  role="radio"
                  aria-checked={(stroke.join ?? 'miter') === join}
                  className={(stroke.join ?? 'miter') === join ? 'is-active' : ''}
                  onClick={() => patchStroke({ join: join === 'miter' ? undefined : join })}
                >
                  {t(JOIN_LABELS[join])}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="prop-row">
        <span className="prop-label">{t('prop.opacity')}</span>
        <div className="prop-controls">
          <input
            type="range"
            className="slider"
            aria-label={t('prop.opacity')}
            min={0}
            max={100}
            value={Math.round(first.opacity * 100)}
            onChange={(e) =>
              editor.updateSelection('opacity', () => ({ opacity: Number(e.target.value) / 100 }), 'opacity')
            }
            onPointerUp={seal}
            onKeyUp={seal}
            onBlur={seal}
          />
          <NumberField
            label=""
            value={Math.round(first.opacity * 100)}
            min={0}
            max={100}
            suffix="%"
            onCommit={(v) => {
              editor.updateSelection('opacity', () => ({ opacity: v / 100 }));
              seal();
            }}
          />
        </div>
      </div>

      <div className="prop-row">
        <span className="prop-label">{t('prop.blendMode')}</span>
        <div className="prop-controls">
          <select
            className="select"
            aria-label={t('prop.blendMode')}
            value={first.blendMode}
            onChange={(e) => {
              editor.updateSelection('blend', () => ({ blendMode: e.target.value as BlendMode }));
              seal();
            }}
          >
            {BLEND_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`blend.${mode}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
