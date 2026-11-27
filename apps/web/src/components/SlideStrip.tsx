import { Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { slides, type ArtboardNode } from '@shiba/core';
import { useEditor, useEditorState } from '../editor/context';
import { displayName } from '../names';

const THUMB_SIZE = 360;
const THUMB_DELAY = 150;

function SlideThumb(props: { slide: ArtboardNode; index: number; active: boolean }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const version = useEditorState((s) => s.docVersion);
  const resourceEpoch = useEditorState((s) => s.resourceEpoch);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { slide } = props;

  useEffect(() => {
    // 文档连续变化（比如拖动）时只在停下来之后重画一次缩略图
    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      const bitmap = editor.renderThumbnail(slide.id, THUMB_SIZE, THUMB_SIZE);
      if (!canvas || !bitmap) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.putImageData(new ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
    }, THUMB_DELAY);
    return () => clearTimeout(timer);
  }, [editor, slide.id, version, resourceEpoch]);

  const name = displayName(slide, t);
  return (
    <div className={`slide${props.active ? ' is-active' : ''}`}>
      <span className="slide-number">{props.index + 1}</span>
      <button
        type="button"
        className="slide-thumb"
        aria-label={name}
        aria-current={props.active}
        style={{ aspectRatio: `${slide.size[0]} / ${slide.size[1]}` }}
        onClick={() => editor.setActiveArtboard(slide.id)}
      >
        <canvas ref={canvasRef} />
      </button>
      <div className="slide-actions">
        <button
          type="button"
          title={t('slide.duplicate')}
          aria-label={`${t('slide.duplicate')}: ${name}`}
          onClick={() => editor.commands.run('artboard.duplicate', slide.id)}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          title={t('slide.delete')}
          aria-label={`${t('slide.delete')}: ${name}`}
          onClick={() => editor.commands.run('artboard.delete', slide.id)}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

/** 幻灯片条：按播放顺序列出所有画板的缩略图 */
export function SlideStrip(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const version = useEditorState((s) => s.docVersion);
  const activeId = useEditorState((s) => s.activeArtboardId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deck = useMemo(() => slides(editor.store), [editor, version]);

  return (
    <div className="panel slide-strip">
      <h2 className="panel-title">
        {t('panel.slides')}
        <button
          type="button"
          className="icon-btn"
          title={t('slide.add')}
          aria-label={t('slide.add')}
          onClick={() => editor.commands.run('artboard.add')}
        >
          <Plus size={15} />
        </button>
      </h2>
      <div className="panel-body">
        {deck.length === 0 && <p className="empty-note">{t('slide.empty')}</p>}
        {deck.map((slide, index) => (
          <SlideThumb key={slide.id} slide={slide} index={index} active={slide.id === activeId} />
        ))}
      </div>
    </div>
  );
}
