import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { runPlayer, type PlayerHandle } from '@shiba/player';
import { useEditor } from '../editor/context';
import { compilePresentation, type CompiledPresentation } from './compile';

/**
 * 演示模式：盖住整个窗口，用 HTML5 播放器播放当前文档。
 * 这里用的播放器和导出的网页里是同一个，所以在这里看到的就是导出后的效果。
 */
export function Presenter(props: { startSlide: number; onClose: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty'>('loading');
  const { startSlide, onClose } = props;

  useEffect(() => {
    let cancelled = false;
    let handle: PlayerHandle | null = null;
    let compiled: CompiledPresentation | null = null;
    const root = rootRef.current;

    // 演示期间的按键只属于播放器：拦在这里，不让它们传到编辑器的快捷键（否则按 Delete 会删掉画布上的东西）
    const swallow = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      event.stopPropagation();
    };
    root?.addEventListener('keydown', swallow);
    root?.focus();

    void compilePresentation(editor, 'preview', '').then((result) => {
      if (cancelled || !stageRef.current) {
        result.dispose();
        return;
      }
      compiled = result;
      if (result.data.slides.length === 0) {
        setStatus('empty');
        return;
      }
      handle = runPlayer(stageRef.current, result.data, { startSlide, onExit: onClose });
      setStatus('ready');
    });

    return () => {
      cancelled = true;
      root?.removeEventListener('keydown', swallow);
      handle?.destroy();
      compiled?.dispose();
    };
  }, [editor, startSlide, onClose]);

  return (
    <div className="presenter" ref={rootRef} tabIndex={-1}>
      <div className="presenter-stage" ref={stageRef} />
      {status !== 'ready' && <div className="presenter-message">{t(`present.${status}`)}</div>}
      <button
        type="button"
        className="presenter-close"
        title={t('present.close')}
        aria-label={t('present.close')}
        onClick={onClose}
      >
        <X size={18} />
      </button>
    </div>
  );
}
