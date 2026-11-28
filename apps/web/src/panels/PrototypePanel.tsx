import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_TRANSITION,
  TRANSITION_EFFECTS,
  clickInteraction,
  slides,
  type Interaction,
  type SlideTransition,
  type TransitionEffect,
} from '@shiba/core';
import { displayName } from '../names';
import { NumberField } from '../ui/controls';
import type { PanelProps } from './registry';

const DIRECTIONS = ['left', 'right', 'top', 'bottom'] as const;

/**
 * 原型：点这个对象时做什么（跳到某一页、回到上一页），以及过渡效果（默认用目标页自己的切换）。
 * 演示模式和导出的网页里点着玩。几个对象一起选中时显示第一个的，改了统一成这一套
 */
export function PrototypePanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const first = nodes[0];
  if (!first) return null;
  const interaction = clickInteraction(first);
  const deck = slides(editor.store).filter((s) => !s.deck?.skip);
  const actionValue = !interaction ? '' : interaction.action.type === 'back' ? 'back' : interaction.action.target;

  const write = (next: Interaction | null): void => {
    editor.updateSelection('prototype', (node) =>
      node.type === 'artboard' ? null : { interactions: next ? [next] : undefined },
    );
    editor.store.sealHistory();
  };
  const setAction = (value: string): void => {
    if (!value) return write(null);
    const action: Interaction['action'] = value === 'back' ? { type: 'back' } : { type: 'navigate', target: value };
    write({ trigger: 'click', action, ...(interaction?.transition ? { transition: interaction.transition } : {}) });
  };
  const setTransition = (patch: Partial<SlideTransition> | null): void => {
    if (!interaction) return;
    const { transition: _old, ...rest } = interaction;
    if (!patch) return write(rest);
    write({ ...rest, transition: { ...(interaction.transition ?? DEFAULT_TRANSITION), ...patch } });
  };
  const transition = interaction?.transition;

  return (
    <div className="prototype-panel">
      <label className="field prototype-field">
        <span className="field-label">{t('prototype.onClick')}</span>
        <select className="select" value={actionValue} onChange={(event) => setAction(event.target.value)}>
          <option value="">{t('prototype.none')}</option>
          <option value="back">{t('prototype.back')}</option>
          <optgroup label={t('prototype.goTo')}>
            {deck.map((slide, i) => (
              <option key={slide.id} value={slide.id}>
                {i + 1}. {displayName(slide, t)}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {interaction && (
        <>
          <label className="field prototype-field">
            <span className="field-label">{t('prototype.transition')}</span>
            <select
              className="select"
              value={transition?.effect ?? ''}
              onChange={(event) => {
                const effect = event.target.value as TransitionEffect | '';
                setTransition(effect ? { effect } : null);
              }}
            >
              <option value="">{t('prototype.targetTransition')}</option>
              {TRANSITION_EFFECTS.map((effect) => (
                <option key={effect} value={effect}>
                  {t(`transition.${effect}`)}
                </option>
              ))}
            </select>
          </label>
          {transition && transition.effect !== 'none' && (
            <div className="field-grid">
              <NumberField
                label={t('prototype.duration')}
                value={transition.duration}
                min={0}
                max={10000}
                suffix="ms"
                onCommit={(v) => setTransition({ duration: v })}
              />
              {transition.effect === 'push' && (
                <label className="field">
                  <span className="field-label">{t('prototype.direction')}</span>
                  <select
                    className="select"
                    value={transition.direction ?? 'left'}
                    onChange={(event) =>
                      setTransition({ direction: event.target.value as SlideTransition['direction'] })
                    }
                  >
                    {DIRECTIONS.map((d) => (
                      <option key={d} value={d}>
                        {t(`direction.${d}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <p className="panel-hint">{t('prototype.hint')}</p>
        </>
      )}
    </div>
  );
}
