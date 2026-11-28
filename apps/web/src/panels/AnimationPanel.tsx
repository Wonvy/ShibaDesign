import { ArrowDown, ArrowUp, Repeat, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ANIMATION_KINDS,
  ANIMATION_STARTS,
  CUSTOM_MOTION_EFFECT,
  DEFAULT_TRANSITION,
  DIRECTIONS,
  TRANSITION_EFFECTS,
  getEffect,
  listEffects,
  type AnimationStart,
  type ArtboardNode,
  type Direction,
  type NodeId,
  type SlideAnimation,
  type SlideTransition,
  type TransitionEffect,
} from '@shiba/core';
import { setSlideNotes, slideLayerOf, type Editor } from '@shiba/editor';
import { displayName } from '../names';
import { IconButton, NumberField, Section } from '../ui/controls';
import { toast } from '../ui/toast';
import type { PanelProps } from './registry';

const seconds = (ms: number): number => Math.round(ms / 10) / 100;
const millis = (s: number): number => Math.round(Math.max(0, s) * 1000);

/**
 * 下拉框：选一个效果，给选中的对象加一条动画。效果列表直接来自效果注册表。
 * "自定义路径"不是马上加，而是换成画路径的工具，在画布上从对象中心画出来
 */
function AddAnimation({ editor }: { editor: Editor }): ReactNode {
  const { t } = useTranslation();
  const choose = (effect: string): void => {
    if (effect !== CUSTOM_MOTION_EFFECT) {
      editor.commands.run('animation.add', { effect });
      return;
    }
    if (editor.commands.run('animation.drawPath')) toast(t('animation.drawPathHint'));
    else toast(t('animation.drawPathNeedsOne'), 'error');
  };
  return (
    <select
      className="select add-animation"
      aria-label={t('animation.add')}
      value=""
      onChange={(e) => {
        if (e.target.value) choose(e.target.value);
      }}
    >
      <option value="">{t('animation.add')}</option>
      {ANIMATION_KINDS.map((kind) => (
        <optgroup key={kind} label={t(`kind.${kind}`)}>
          {listEffects(kind).map((def) => (
            <option key={def.id} value={def.id}>
              {/* 自定义路径选了之后还要在画布上画，名字后面加省略号 */}
              {t(`effect.${def.id}`)}
              {def.id === CUSTOM_MOTION_EFFECT ? '…' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * 一页幻灯片的动画列表，相当于 PPT 的动画窗格：按播放顺序排列，点一条展开它的设置。
 * 左边的数字是"第几次单击时播放"；没有数字的和上面那条属于同一次单击。
 */
export function AnimationList(props: {
  editor: Editor;
  slide: ArtboardNode;
  /** 这些对象的动画会被标出来 */
  highlight: ReadonlySet<NodeId>;
}): ReactNode {
  const { editor, slide } = props;
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  const animations = slide.deck?.animations ?? [];
  if (animations.length === 0) return <p className="empty-note anim-empty">{t('animation.none')}</p>;

  const update = (id: string, patch: Partial<SlideAnimation>): void => {
    editor.commands.run('animation.update', { slideId: slide.id, id, patch });
  };

  let click = 0;
  return (
    <ol className="anim-list">
      {animations.map((animation, index) => {
        if (animation.start === 'onClick') click += 1;
        const def = getEffect(animation.effect);
        const target = editor.store.get(animation.target);
        const active =
          target !== undefined && slideLayerOf(editor.store, animation.target)?.layer.id === animation.target;
        const open = openId === animation.id;
        return (
          <li
            key={animation.id}
            className={`anim-item${props.highlight.has(animation.target) ? ' is-related' : ''}${active ? '' : ' is-inactive'}`}
          >
            <button
              type="button"
              className="anim-row"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : animation.id)}
            >
              <span className="anim-step">{animation.start === 'onClick' ? click : ''}</span>
              <span className={`anim-dot kind-${def?.kind ?? 'unknown'}`} aria-hidden="true" />
              <span className="anim-name">{t(`effect.${animation.effect}`)}</span>
              <span className="anim-target">{active && target ? displayName(target, t) : t('animation.missing')}</span>
            </button>
            {open && (
              <div className="anim-detail appearance">
                <div className="prop-row">
                  <span className="prop-label">{t('animation.start')}</span>
                  <div className="prop-controls">
                    <select
                      className="select"
                      aria-label={t('animation.start')}
                      value={animation.start}
                      onChange={(e) => update(animation.id, { start: e.target.value as AnimationStart })}
                    >
                      {ANIMATION_STARTS.map((start) => (
                        <option key={start} value={start}>
                          {t(`start.${start}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {!def?.instant && (
                  <div className="prop-row">
                    <span className="prop-label">{t('animation.duration')}</span>
                    <div className="prop-controls">
                      <NumberField
                        label=""
                        value={seconds(animation.duration)}
                        min={0}
                        max={60}
                        onCommit={(v) => update(animation.id, { duration: millis(v) })}
                      />
                    </div>
                  </div>
                )}
                <div className="prop-row">
                  <span className="prop-label">{t('animation.delay')}</span>
                  <div className="prop-controls">
                    <NumberField
                      label=""
                      value={seconds(animation.delay)}
                      min={0}
                      max={60}
                      onCommit={(v) => update(animation.id, { delay: millis(v) })}
                    />
                  </div>
                </div>
                {def?.directional && (
                  <div className="prop-row">
                    <span className="prop-label">{t('animation.direction')}</span>
                    <div className="prop-controls">
                      <select
                        className="select"
                        aria-label={t('animation.direction')}
                        value={animation.direction ?? 'left'}
                        onChange={(e) => update(animation.id, { direction: e.target.value as Direction })}
                      >
                        {DIRECTIONS.map((direction) => (
                          <option key={direction} value={direction}>
                            {t(`direction.${direction}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                {def?.kind === 'motion' && <p className="menu-hint anim-hint">{t('animation.pathHint')}</p>}
                <div className="button-row anim-actions">
                  <IconButton
                    title={t('animation.moveUp')}
                    disabled={index === 0}
                    onClick={() =>
                      editor.commands.run('animation.move', { slideId: slide.id, id: animation.id, delta: -1 })
                    }
                  >
                    <ArrowUp size={15} />
                  </IconButton>
                  <IconButton
                    title={t('animation.moveDown')}
                    disabled={index === animations.length - 1}
                    onClick={() =>
                      editor.commands.run('animation.move', { slideId: slide.id, id: animation.id, delta: 1 })
                    }
                  >
                    <ArrowDown size={15} />
                  </IconButton>
                  {def?.kind === 'motion' && animation.path && (
                    <IconButton
                      title={t('animation.reversePath')}
                      onClick={() =>
                        editor.commands.run('animation.reversePath', { slideId: slide.id, id: animation.id })
                      }
                    >
                      <Repeat size={15} />
                    </IconButton>
                  )}
                  <IconButton
                    title={t('animation.remove')}
                    onClick={() => editor.commands.run('animation.remove', { slideId: slide.id, id: animation.id })}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 选中对象时的动画面板：给它加动画，并显示所在幻灯片的动画列表 */
export function AnimationPanel({ editor, nodes }: PanelProps): ReactNode {
  const found = nodes.map((node) => slideLayerOf(editor.store, node.id)).filter((x) => x !== null);
  const slide = found[0]?.slide;
  if (!slide) return null;
  const highlight = new Set(found.filter((f) => f.slide.id === slide.id).map((f) => f.layer.id));
  return (
    <>
      <AddAnimation editor={editor} />
      <AnimationList editor={editor} slide={slide} highlight={highlight} />
    </>
  );
}

/**
 * 这一页的演讲者备注：演示时显示在演讲者视图里。打字时直接写进文档，一次编辑（从点进去到离开）是一步撤销
 */
export function SlideNotes({ editor, slide }: { editor: Editor; slide: ArtboardNode }): ReactNode {
  const { t } = useTranslation();
  const mergeKey = useRef<string | null>(null);
  const finish = (): void => {
    if (!mergeKey.current) return;
    mergeKey.current = null;
    editor.store.sealHistory();
  };
  return (
    <textarea
      className="slide-notes"
      aria-label={t('presenterView.notes')}
      placeholder={t('presenterView.notesPlaceholder')}
      value={slide.deck?.notes ?? ''}
      onFocus={() => {
        mergeKey.current = editor.newMergeKey('notes');
      }}
      onChange={(e) => setSlideNotes(editor, slide.id, e.target.value, mergeKey.current ?? undefined)}
      onBlur={finish}
    />
  );
}

/** 没有选中任何对象时显示的幻灯片设置：这一页的切换效果、演讲者备注，以及完整的动画列表 */
export function SlidePanel({ editor, slide }: { editor: Editor; slide: ArtboardNode }): ReactNode {
  const { t } = useTranslation();
  const transition = slide.deck?.transition ?? DEFAULT_TRANSITION;
  const set = (patch: Partial<SlideTransition>): void => {
    editor.commands.run('slide.setTransition', { slideId: slide.id, transition: { ...transition, ...patch } });
  };

  return (
    <>
      <div className="inspector-header">{displayName(slide, t)}</div>
      <Section title={t('transition.label')}>
        <div className="appearance">
          <div className="prop-row">
            <span className="prop-label">{t('transition.effect')}</span>
            <div className="prop-controls">
              <select
                className="select"
                aria-label={t('transition.effect')}
                value={transition.effect}
                onChange={(e) => set({ effect: e.target.value as TransitionEffect })}
              >
                {TRANSITION_EFFECTS.map((effect) => (
                  <option key={effect} value={effect}>
                    {t(`transition.${effect}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {transition.effect !== 'none' && (
            <div className="prop-row">
              <span className="prop-label">{t('animation.duration')}</span>
              <div className="prop-controls">
                <NumberField
                  label=""
                  value={seconds(transition.duration)}
                  min={0}
                  max={10}
                  onCommit={(v) => set({ duration: millis(v) })}
                />
              </div>
            </div>
          )}
          {transition.effect === 'push' && (
            <div className="prop-row">
              <span className="prop-label">{t('animation.direction')}</span>
              <div className="prop-controls">
                <select
                  className="select"
                  aria-label={t('animation.direction')}
                  value={transition.direction ?? 'right'}
                  onChange={(e) => set({ direction: e.target.value as Direction })}
                >
                  {DIRECTIONS.map((direction) => (
                    <option key={direction} value={direction}>
                      {t(`direction.${direction}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
        {transition.effect === 'smooth' && <p className="menu-hint smooth-hint">{t('transition.smoothHint')}</p>}
      </Section>
      <Section title={t('presenterView.notes')}>
        <SlideNotes key={slide.id} editor={editor} slide={slide} />
      </Section>
      <Section title={t('panel.animation')}>
        <AnimationList editor={editor} slide={slide} highlight={new Set()} />
      </Section>
    </>
  );
}
