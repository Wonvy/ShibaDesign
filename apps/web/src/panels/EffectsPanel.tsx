import { Eye, EyeOff, Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EFFECT_TYPES, defaultEffect, isShadow, type Effect, type EffectType, type SceneNode } from '@shiba/core';
import { ColorField, IconButton, NumberField } from '../ui/controls';
import type { PanelProps } from './registry';

/** 画板不画效果 */
function targetsOf(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.filter((n) => n.type !== 'artboard');
}

/** 几个对象的效果是不是一样（只比较内容） */
function sameEffects(a: readonly Effect[] | undefined, b: readonly Effect[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * 效果：投影、内阴影、图层模糊、背景模糊，可以叠好几个。每一项可以换类型、暂时关掉、删掉；
 * 阴影有颜色（含透明度）、X、Y、模糊、扩展，模糊有半径。选中的几个对象效果不一样时显示第一个的，改了就统一成这一套
 */
export function EffectsPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const targets = targetsOf(nodes);
  const first = targets[0];
  if (!first) return null;
  const effects = first.effects ?? [];
  const mixed = targets.some((n) => !sameEffects(n.effects, first.effects));

  const write = (next: readonly Effect[], mergeKey?: string): void =>
    editor.updateSelection(
      'effects',
      (node) => (node.type === 'artboard' ? null : { effects: next.length > 0 ? next : undefined }),
      mergeKey,
    );
  const seal = (): void => editor.store.sealHistory();
  const replace = (index: number, effect: Effect, mergeKey?: string): void =>
    write(
      effects.map((e, i) => (i === index ? effect : e)),
      mergeKey,
    );
  const commit = (index: number, effect: Effect): void => {
    replace(index, effect);
    seal();
  };

  const changeType = (index: number, type: EffectType): void => {
    const current = effects[index]!;
    // 投影和内阴影之间换，参数留着；换成另一种模糊也留着半径；阴影和模糊之间换用默认值
    let next: Effect;
    if (isShadow(current) && (type === 'dropShadow' || type === 'innerShadow')) next = { ...current, type };
    else if (!isShadow(current) && (type === 'layerBlur' || type === 'backgroundBlur')) next = { ...current, type };
    else next = { ...defaultEffect(type), ...(current.hidden ? { hidden: true } : {}) };
    commit(index, next);
  };

  return (
    <div className="effects">
      {mixed && <p className="panel-hint">{t('effects.mixed')}</p>}
      {effects.map((effect, index) => (
        <div className="effect" key={index}>
          <div className="effect-head">
            <select
              className="select"
              aria-label={t('effects.type')}
              value={effect.type}
              onChange={(event) => changeType(index, event.target.value as EffectType)}
            >
              {EFFECT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`effects.${type}`)}
                </option>
              ))}
            </select>
            <IconButton
              title={t(effect.hidden ? 'effects.show' : 'effects.hide')}
              onClick={() => commit(index, { ...effect, hidden: effect.hidden ? undefined : true })}
            >
              {effect.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
            <IconButton
              title={t('prop.remove')}
              onClick={() => {
                write(effects.filter((_, i) => i !== index));
                seal();
              }}
            >
              <Minus size={14} />
            </IconButton>
          </div>
          {isShadow(effect) ? (
            <>
              <div className="effect-color">
                <ColorField
                  label={t('effects.color')}
                  value={effect.color}
                  onChange={(color) => replace(index, { ...effect, color }, `effect-color-${index}`)}
                  onCommit={seal}
                />
                <NumberField
                  label="%"
                  value={Math.round(effect.color.a * 100)}
                  min={0}
                  max={100}
                  onCommit={(v) => commit(index, { ...effect, color: { ...effect.color, a: v / 100 } })}
                />
              </div>
              <div className="field-grid">
                <NumberField label="X" value={effect.x} onCommit={(v) => commit(index, { ...effect, x: v })} />
                <NumberField label="Y" value={effect.y} onCommit={(v) => commit(index, { ...effect, y: v })} />
                <NumberField
                  label={t('effects.blur')}
                  value={effect.blur}
                  min={0}
                  onCommit={(v) => commit(index, { ...effect, blur: v })}
                />
                <NumberField
                  label={t('effects.spread')}
                  value={effect.spread}
                  onCommit={(v) => commit(index, { ...effect, spread: v })}
                />
              </div>
            </>
          ) : (
            <div className="field-grid">
              <NumberField
                label={t('effects.radius')}
                value={effect.radius}
                min={0}
                onCommit={(v) => commit(index, { ...effect, radius: v })}
              />
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        className="effect-add"
        onClick={() => {
          write([...effects, defaultEffect('dropShadow')]);
          seal();
        }}
      >
        <Plus size={14} />
        {t('effects.add')}
      </button>
    </div>
  );
}
