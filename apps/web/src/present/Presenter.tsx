import { NotebookText, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { runPlayer, type PlayerHandle, type PlayerState } from '@shiba/player';
import { useEditor } from '../editor/context';
import { toast } from '../ui/toast';
import { compilePresentation, type CompiledPresentation } from './compile';
import { openPresenterWindow } from './popup';
import { PresenterView } from './PresenterView';

/**
 * 演示模式：盖住整个窗口，用 HTML5 播放器播放当前文档。
 * 这里用的播放器和导出的网页里是同一个，所以在这里看到的就是导出后的效果。
 * 右上角可以打开演讲者视图：一个单独的窗口，显示当前页、下一页、备注和计时，两边同步翻页（见 PresenterView.tsx）
 */
export function Presenter(props: { startSlide: number; onClose: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty'>('loading');
  const [compiled, setCompiled] = useState<CompiledPresentation | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);
  const [popup, setPopup] = useState<{ win: Window; container: HTMLElement } | null>(null);
  /** 演示开始的时刻，演讲者视图的计时从这里算起 */
  const [startedAt] = useState(() => Date.now());
  const { startSlide, onClose } = props;

  useEffect(() => {
    let cancelled = false;
    let handle: PlayerHandle | null = null;
    let result: CompiledPresentation | null = null;
    const root = rootRef.current;

    // 演示期间的按键只属于播放器：拦在这里，不让它们传到编辑器的快捷键（否则按 Delete 会删掉画布上的东西）
    const swallow = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      event.stopPropagation();
    };
    root?.addEventListener('keydown', swallow);
    root?.focus();

    void compilePresentation(editor, 'preview', '').then((compiledResult) => {
      if (cancelled || !stageRef.current) {
        compiledResult.dispose();
        return;
      }
      result = compiledResult;
      setCompiled(compiledResult);
      if (compiledResult.data.slides.length === 0) {
        setStatus('empty');
        return;
      }
      handle = runPlayer(stageRef.current, compiledResult.data, {
        startSlide,
        onExit: onClose,
        onChange: setPlayerState,
      });
      handleRef.current = handle;
      setPlayerState(handle.state());
      setStatus('ready');
    });

    return () => {
      cancelled = true;
      root?.removeEventListener('keydown', swallow);
      handle?.destroy();
      handleRef.current = null;
      result?.dispose();
    };
  }, [editor, startSlide, onClose]);

  // 演讲者视图的窗口：用户自己关掉时收起；演示结束时一起关掉
  useEffect(() => {
    if (!popup) return;
    const { win } = popup;
    const closed = (): void => setPopup((current) => (current?.win === win ? null : current));
    win.addEventListener('pagehide', closed);
    return () => win.removeEventListener('pagehide', closed);
  }, [popup]);
  useEffect(() => () => popup?.win.close(), [popup]);

  const openPresenterView = (): void => {
    if (popup && !popup.win.closed) {
      popup.win.focus();
      return;
    }
    const opened = openPresenterWindow(t('presenterView.title'));
    if (!opened) {
      toast(t('presenterView.blocked'), 'error');
      return;
    }
    setPopup(opened);
  };

  /** 演讲者视图里翻页：交给观众看的这个播放器，之后两边都按它的状态走 */
  const next = useCallback(() => handleRef.current?.next(), []);
  const previous = useCallback(() => handleRef.current?.previous(), []);
  const goTo = useCallback((slide: number) => handleRef.current?.goTo(slide), []);

  return (
    <div className="presenter" ref={rootRef} tabIndex={-1}>
      <div className="presenter-stage" ref={stageRef} />
      {status !== 'ready' && <div className="presenter-message">{t(`present.${status}`)}</div>}
      <div className="presenter-actions">
        {status === 'ready' && (
          <button
            type="button"
            className="presenter-button"
            title={t('presenterView.open')}
            aria-label={t('presenterView.open')}
            onClick={openPresenterView}
          >
            <NotebookText size={18} />
          </button>
        )}
        <button
          type="button"
          className="presenter-button"
          title={t('present.close')}
          aria-label={t('present.close')}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {popup &&
        compiled &&
        playerState &&
        createPortal(
          <PresenterView
            win={popup.win}
            data={compiled.data}
            slideIds={compiled.slideIds}
            state={playerState}
            startedAt={startedAt}
            onNext={next}
            onPrevious={previous}
            onGoTo={goTo}
            onExit={onClose}
          />,
          popup.container,
        )}
    </div>
  );
}
