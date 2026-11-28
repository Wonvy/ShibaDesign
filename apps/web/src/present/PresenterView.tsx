import { ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeId } from '@shiba/core';
import { runPlayer, settlePlayer, type PlayerHandle, type PlayerState, type PresentationData } from '@shiba/player';
import { useEditor, useEditorState } from '../editor/context';

/** 备注的字号：默认、最小、最大，单位像素。上次的设置记在浏览器里 */
const NOTES_SIZE_KEY = 'shiba.presenterNotesSize';
const NOTES_SIZE = { initial: 22, min: 14, max: 48, step: 2 };

function loadNotesSize(): number {
  try {
    const saved = Number(localStorage.getItem(NOTES_SIZE_KEY));
    if (Number.isFinite(saved) && saved >= NOTES_SIZE.min && saved <= NOTES_SIZE.max) return saved;
  } catch {
    // 隐私模式下读不了，用默认值
  }
  return NOTES_SIZE.initial;
}

function saveNotesSize(size: number): void {
  try {
    localStorage.setItem(NOTES_SIZE_KEY, String(size));
  } catch {
    // 隐私模式下存不了
  }
}

/** 毫秒 → 分:秒，超过一小时是 时:分:秒 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/**
 * 计时：从演示开始算起，可以暂停、清零。running 是这一段开始走的时刻，base 是之前几段攒下的时间
 */
function useStopwatch(startedAt: number): {
  elapsed: number;
  running: boolean;
  toggle: () => void;
  reset: () => void;
} {
  const [timer, setTimer] = useState<{ base: number; running: number | null }>({ base: 0, running: startedAt });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = timer.base + (timer.running !== null ? now - timer.running : 0);
  return {
    elapsed,
    running: timer.running !== null,
    toggle: () =>
      setTimer((t) =>
        t.running !== null
          ? { base: t.base + Date.now() - t.running, running: null }
          : { base: t.base, running: Date.now() },
      ),
    reset: () => setTimer((t) => ({ base: 0, running: t.running !== null ? Date.now() : null })),
  };
}

/**
 * 一个只用来看的播放器：停在指定的页和步骤上（这一步播完的样子），自己不响应点击和按键。
 * 演讲者视图里的"当前页"和"下一页"各是一个
 */
function MirrorPlayer(props: { data: PresentationData; slide: number; step: number; win: Window }): ReactNode {
  const { data, slide, step, win } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const target = useRef({ slide, step });
  target.current = { slide, step };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handle = runPlayer(root, data, { startSlide: target.current.slide });
    handleRef.current = handle;
    settlePlayer(handle, target.current.slide, target.current.step);
    // 窗口大小变了：重新进这一页让幻灯片按新的大小摆，再播到原来的步骤
    const refit = (): void => {
      handle.goTo(target.current.slide);
      settlePlayer(handle, target.current.slide, target.current.step);
    };
    win.addEventListener('resize', refit);
    return () => {
      win.removeEventListener('resize', refit);
      handle.destroy();
      handleRef.current = null;
    };
  }, [data, win]);

  useEffect(() => {
    if (handleRef.current) settlePlayer(handleRef.current, slide, step);
  }, [slide, step]);

  return <div className="pv-player" ref={rootRef} />;
}

/**
 * 演讲者视图：开在单独的窗口里（见 popup.ts），观众看的是主窗口里的演示。
 * 左边是观众此刻看到的这一页（这一步播完的样子），右边是下一页和这一页的备注，上面是计时和时钟。
 * 翻页都交给主窗口的播放器（onNext 等），这边跟着它的状态走，所以两边总是同步的。
 * 窗口里的按键：→ ↓ 空格 回车 PageDown 前进，← ↑ PageUp 退格 后退，Home、End 到第一页、最后一页，Esc 结束演示
 */
export function PresenterView(props: {
  win: Window;
  data: PresentationData;
  slideIds: readonly NodeId[];
  state: PlayerState;
  startedAt: number;
  onNext: () => void;
  onPrevious: () => void;
  onGoTo: (slide: number) => void;
  onExit: () => void;
}): ReactNode {
  const { win, data, slideIds, state, startedAt, onNext, onPrevious, onGoTo, onExit } = props;
  const { t } = useTranslation();
  const editor = useEditor();
  // 备注直接从文档里读：演示的时候在主窗口改了备注，这边也跟着变
  useEditorState((s) => s.docVersion);
  const [notesSize, setNotesSize] = useState(loadNotesSize);
  const stopwatch = useStopwatch(startedAt);

  const slideNode = editor.store.get(slideIds[state.slide] ?? '');
  const notes = slideNode?.type === 'artboard' ? (slideNode.deck?.notes ?? '') : '';
  const hasNext = state.slide + 1 < data.slides.length;
  const atEnd = !hasNext && state.step + 1 >= state.steps && !state.busy;

  // 按键挂在这个窗口的文档上，捕获阶段处理：不能让里面播放器的舞台收到，否则它会自己翻页，和观众那边对不上
  const actions = useRef({ onNext, onPrevious, onGoTo, onExit, last: data.slides.length - 1 });
  actions.current = { onNext, onPrevious, onGoTo, onExit, last: data.slides.length - 1 };
  useEffect(() => {
    const doc = win.document;
    const onKeyDown = (event: KeyboardEvent): void => {
      const a = actions.current;
      const target = event.target as HTMLElement | null;
      // 焦点在按钮上时，空格和回车留给按钮自己
      if ((event.key === ' ' || event.key === 'Enter') && target?.tagName === 'BUTTON') return;
      const key = event.key;
      if (key === 'ArrowRight' || key === 'ArrowDown' || key === ' ' || key === 'Enter' || key === 'PageDown')
        a.onNext();
      else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || key === 'Backspace') a.onPrevious();
      else if (key === 'Home') a.onGoTo(0);
      else if (key === 'End') a.onGoTo(a.last);
      else if (key === 'Escape') a.onExit();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    doc.addEventListener('keydown', onKeyDown, true);
    return () => doc.removeEventListener('keydown', onKeyDown, true);
  }, [win]);

  const changeNotesSize = (delta: number): void =>
    setNotesSize((size) => {
      const next = Math.max(NOTES_SIZE.min, Math.min(NOTES_SIZE.max, size + delta));
      saveNotesSize(next);
      return next;
    });

  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="pv">
      <header className="pv-header">
        <div className="pv-timer" aria-label={t('presenterView.elapsed')}>
          <span className={`pv-elapsed${stopwatch.running ? '' : ' is-paused'}`}>
            {formatElapsed(stopwatch.elapsed)}
          </span>
          <button
            type="button"
            className="pv-icon"
            title={stopwatch.running ? t('presenterView.pause') : t('presenterView.resume')}
            aria-label={stopwatch.running ? t('presenterView.pause') : t('presenterView.resume')}
            onClick={stopwatch.toggle}
          >
            {stopwatch.running ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            type="button"
            className="pv-icon"
            title={t('presenterView.reset')}
            aria-label={t('presenterView.reset')}
            onClick={stopwatch.reset}
          >
            <RotateCcw size={16} />
          </button>
        </div>
        <div className="pv-clock">{clock}</div>
        <button type="button" className="pv-exit" onClick={onExit}>
          {t('presenterView.exit')}
        </button>
      </header>

      <main className="pv-main">
        <section className="pv-current" aria-label={t('presenterView.current')}>
          <div className="pv-label">
            {t('presenterView.slideOf', { current: state.slide + 1, total: data.slides.length })}
            {state.steps > 1 && (
              <span className="pv-steps">
                {t('presenterView.stepOf', { current: state.step, total: state.steps - 1 })}
              </span>
            )}
          </div>
          {/* 点当前页前进，和在主窗口里点一样 */}
          <div className="pv-frame is-clickable" onClick={onNext}>
            <MirrorPlayer data={data} slide={state.slide} step={state.step} win={win} />
          </div>
        </section>

        <aside className="pv-side">
          <section className="pv-next" aria-label={t('presenterView.next')}>
            <div className="pv-label">{t('presenterView.next')}</div>
            <div className="pv-frame">
              {hasNext ? (
                <MirrorPlayer data={data} slide={state.slide + 1} step={0} win={win} />
              ) : (
                <div className="pv-end">{t(atEnd ? 'presenterView.ended' : 'presenterView.lastSlide')}</div>
              )}
            </div>
          </section>

          <section className="pv-notes" aria-label={t('presenterView.notes')}>
            <div className="pv-label">
              {t('presenterView.notes')}
              <span className="pv-notes-size">
                <button
                  type="button"
                  className="pv-icon"
                  title={t('presenterView.smaller')}
                  aria-label={t('presenterView.smaller')}
                  disabled={notesSize <= NOTES_SIZE.min}
                  onClick={() => changeNotesSize(-NOTES_SIZE.step)}
                >
                  <Minus size={14} />
                </button>
                <button
                  type="button"
                  className="pv-icon"
                  title={t('presenterView.larger')}
                  aria-label={t('presenterView.larger')}
                  disabled={notesSize >= NOTES_SIZE.max}
                  onClick={() => changeNotesSize(NOTES_SIZE.step)}
                >
                  <Plus size={14} />
                </button>
              </span>
            </div>
            <div className="pv-notes-text" style={{ fontSize: notesSize }}>
              {notes.trim() ? notes : <span className="pv-notes-empty">{t('presenterView.noNotes')}</span>}
            </div>
          </section>
        </aside>
      </main>

      <footer className="pv-footer">
        <button type="button" className="pv-nav" onClick={onPrevious}>
          <ChevronLeft size={18} />
          {t('presenterView.previous')}
        </button>
        <button type="button" className="pv-nav is-primary" onClick={onNext} disabled={atEnd}>
          {t('presenterView.forward')}
          <ChevronRight size={18} />
        </button>
      </footer>
    </div>
  );
}
