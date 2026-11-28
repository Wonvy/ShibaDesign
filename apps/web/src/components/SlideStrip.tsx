import { Copy, EyeOff, Plus, Shuffle, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { slides, type ArtboardNode, type NodeId } from '@shiba/core';
import { useEditor, useEditorState } from '../editor/context';
import { openPanelMenu } from '../menus/context';
import { displayName } from '../names';
import { LayoutMenu } from './LayoutMenu';

const THUMB_SIZE = 360;
const THUMB_DELAY = 150;
/** 拖动挪出多远才算开始拖 */
const DRAG_START = 5;

/** 幻灯片条里多选的那几页（右键菜单要对它们一起操作） */
let multiSelection: readonly NodeId[] = [];

/** 右键点在某一页上时要操作的那几页：点在多选里就是整个多选，否则只是它 */
export function slidesForMenu(clicked: NodeId): readonly NodeId[] {
  return multiSelection.includes(clicked) ? multiSelection : [clicked];
}

function SlideThumb(props: {
  slide: ArtboardNode;
  index: number;
  active: boolean;
  picked: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onClick: (event: React.MouseEvent) => void;
  onInsertAfter: () => void;
}): ReactNode {
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
  const deck = slide.deck!;
  const animations = deck.animations?.length ?? 0;
  const hasTransition = !!deck.transition && deck.transition.effect !== 'none';
  return (
    <div
      className={`slide${props.active ? ' is-active' : ''}${props.picked ? ' is-picked' : ''}${deck.skip ? ' is-skipped' : ''}${props.dropBefore ? ' is-drop-before' : ''}${props.dropAfter ? ' is-drop-after' : ''}`}
      data-slide={slide.id}
      onContextMenu={(event) => {
        editor.setActiveArtboard(slide.id);
        openPanelMenu(event, editor, 'slide.thumb', slide.id);
      }}
    >
      <span className="slide-number">
        {props.index + 1}
        <span className="slide-badges">
          {hasTransition && <Shuffle size={10} aria-label={t('slide.hasTransition')} />}
          {animations > 0 && <Sparkles size={10} aria-label={t('slide.hasAnimation')} />}
          {deck.skip && <EyeOff size={10} aria-label={t('slide.hidden')} />}
        </span>
      </span>
      <button
        type="button"
        className="slide-thumb"
        aria-label={name}
        aria-current={props.active}
        tabIndex={-1}
        style={{ aspectRatio: `${slide.size[0]} / ${slide.size[1]}` }}
        onPointerDown={props.onPointerDown}
        onClick={props.onClick}
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
      <button
        type="button"
        className="slide-insert"
        title={t('slide.insertAfter')}
        aria-label={`${t('slide.insertAfter')}: ${name}`}
        tabIndex={-1}
        onClick={props.onInsertAfter}
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

/**
 * 幻灯片条：按播放顺序列出所有画板的缩略图。
 * 拖动调整顺序（多选后一起拖，按住 Alt 是复制）；⌘ 单击、⇧ 单击多选；两页之间的"+"在那里新建一页；
 * 有焦点时 ↑↓ 换页、回车在后面新建一页、⌘D 复制、⌫ 删除；面板拖宽了排成网格
 */
export function SlideStrip(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const version = useEditorState((s) => s.docVersion);
  const activeId = useEditorState((s) => s.activeArtboardId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deck = useMemo(() => slides(editor.store), [editor, version]);
  const [picked, setPicked] = useState<readonly NodeId[]>([]);
  const [drop, setDrop] = useState<number | null>(null);
  const anchor = useRef<NodeId | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 多选里的页被删掉了就去掉；记到模块里给右键菜单用
  const live = picked.filter((id) => deck.some((s) => s.id === id));
  multiSelection = live;

  const goTo = (id: NodeId): void => {
    editor.setActiveArtboard(id);
    // 画布视图里：把视口挪到这个画板
    const board = editor.store.get(id);
    if (editor.viewMode === 'canvas' && board) editor.zoomToFit(editor.geometry.worldBounds(board));
  };

  const click = (event: React.MouseEvent, slide: ArtboardNode, index: number): void => {
    if (event.shiftKey && anchor.current) {
      const from = deck.findIndex((s) => s.id === anchor.current);
      if (from >= 0) {
        const [a, b] = from < index ? [from, index] : [index, from];
        setPicked(deck.slice(a, b + 1).map((s) => s.id));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      const base = live.length > 0 ? live : activeId ? [activeId] : [];
      setPicked(base.includes(slide.id) ? base.filter((id) => id !== slide.id) : [...base, slide.id]);
      anchor.current = slide.id;
      return;
    }
    setPicked([]);
    anchor.current = slide.id;
    goTo(slide.id);
  };

  /** 拖到哪两页之间：返回插入的位置（第几页之前，按全部的顺序数） */
  const slotAt = (x: number, y: number): number | null => {
    const list = listRef.current;
    if (!list) return null;
    const items = [...list.querySelectorAll<HTMLElement>('[data-slide]')];
    if (items.length === 0) return null;
    const grid = list.classList.contains('is-grid') || getComputedStyle(list).display === 'grid';
    for (let i = 0; i < items.length; i++) {
      const r = items[i]!.getBoundingClientRect();
      const inside = grid ? y >= r.top && y <= r.bottom && x >= r.left && x <= r.right : y >= r.top && y <= r.bottom;
      if (!inside) continue;
      const before = grid ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
      return before ? i : i + 1;
    }
    const last = items.at(-1)!.getBoundingClientRect();
    return y > last.bottom ? items.length : null;
  };

  const startDrag = (event: React.PointerEvent, slide: ArtboardNode): void => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let slot: number | null = null;
    const ids = live.includes(slide.id) ? live : [slide.id];
    const move = (e: PointerEvent): void => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_START) return;
      dragging = true;
      slot = slotAt(e.clientX, e.clientY);
      setDrop(slot);
      const list = listRef.current;
      if (list) {
        const r = list.getBoundingClientRect();
        if (e.clientY < r.top + 24) list.scrollTop -= 14;
        else if (e.clientY > r.bottom - 24) list.scrollTop += 14;
      }
    };
    const up = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrop(null);
      if (!dragging || slot === null) return;
      // 命令的位置按去掉这几页之后的顺序数（复制时按全部的）
      const index = e.altKey ? slot : slot - deck.slice(0, slot).filter((s) => ids.includes(s.id)).length;
      editor.commands.run('artboard.reorder', { ids, index, copy: e.altKey });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const insertAfter = (slide: ArtboardNode): void => {
    editor.setActiveArtboard(slide.id);
    editor.commands.run('artboard.add');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = deck.findIndex((s) => s.id === activeId);
    const targets = live.length > 0 ? live : activeId ? [activeId] : [];
    const mod = event.metaKey || event.ctrlKey;
    let handled = true;
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowRight' ||
      event.key === 'ArrowLeft'
    ) {
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const next = deck[Math.max(0, Math.min(deck.length - 1, current + step))];
      if (next) {
        setPicked([]);
        goTo(next.id);
      }
    } else if (event.key === 'Enter' && !mod) {
      editor.commands.run('artboard.add');
    } else if (mod && event.code === 'KeyD') {
      targets.forEach((id) => editor.commands.run('artboard.duplicate', id));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      targets.forEach((id) => editor.commands.run('artboard.delete', id));
      setPicked([]);
    } else if (mod && (event.code === 'KeyC' || event.code === 'KeyX')) {
      // 复制整页：让剪贴板复制的是这几页（浏览器接着会发 copy / cut 事件）
      editor.select([...targets]);
      handled = false;
    } else if (mod && event.code === 'KeyV') {
      editor.select([]);
      handled = false;
    } else {
      handled = false;
    }
    if (handled) {
      // 不让画布的快捷键再处理一遍
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div className="panel slide-strip">
      <div className="panel-toolbar">
        <span className="panel-count">
          {live.length > 1 ? t('slide.picked', { count: live.length }) : t('slide.count', { count: deck.length })}
        </span>
        <LayoutMenu />
      </div>
      <div
        className="panel-body slide-list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => openPanelMenu(event, editor, 'slide.empty')}
      >
        {deck.length === 0 && <p className="empty-note">{t('slide.empty')}</p>}
        {deck.map((slide, index) => (
          <SlideThumb
            key={slide.id}
            slide={slide}
            index={index}
            active={slide.id === activeId}
            picked={live.includes(slide.id)}
            dropBefore={drop === index}
            dropAfter={drop === deck.length && index === deck.length - 1}
            onPointerDown={(event) => startDrag(event, slide)}
            onClick={(event) => click(event, slide, index)}
            onInsertAfter={() => insertAfter(slide)}
          />
        ))}
      </div>
    </div>
  );
}
