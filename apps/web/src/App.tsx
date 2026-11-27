import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { slides } from '@shiba/core';
import type { Editor } from '@shiba/editor';
import { CanvasHost } from './components/CanvasHost';
import { Inspector } from './components/Inspector';
import { LayersPanel } from './components/LayersPanel';
import { SlideStrip } from './components/SlideStrip';
import { TopBar } from './components/TopBar';
import { createApp } from './editor/bootstrap';
import { EditorProvider, useEditor, useEditorState } from './editor/context';
import { Presenter } from './present/Presenter';
import { Toasts } from './ui/toast';

function Workspace(): ReactNode {
  const editor = useEditor();
  const viewMode = useEditorState((s) => s.viewMode);
  /** 正在演示时是起始页的序号，否则为 null */
  const [presenting, setPresenting] = useState<number | null>(null);

  const play = useCallback(() => {
    // 从当前这一页开始播；正在编辑文字的话先结束编辑，让文字落进文档
    editor.setTool('select');
    const index = slides(editor.store).findIndex((s) => s.id === editor.getState().activeArtboardId);
    setPresenting(Math.max(0, index));
  }, [editor]);
  const stop = useCallback(() => setPresenting(null), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        play();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [play]);

  return (
    <div className="app">
      <TopBar onPlay={play} />
      <div className="workspace">
        <aside className="sidebar">
          {viewMode === 'slides' && <SlideStrip />}
          <LayersPanel />
        </aside>
        <CanvasHost />
        <Inspector />
      </div>
      <Toasts />
      {presenting !== null && <Presenter startSlide={presenting} onClose={stop} />}
    </div>
  );
}

export function App(): ReactNode {
  const { t } = useTranslation();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let created: Editor | null = null;
    setError(null);
    createApp()
      .then((instance) => {
        if (cancelled) {
          instance.dispose();
          return;
        }
        created = instance;
        setEditor(instance);
      })
      .catch((reason: unknown) => {
        console.error(reason);
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      created?.dispose();
      setEditor(null);
    };
  }, [attempt]);

  if (error) {
    return (
      <div className="splash">
        <strong>{t('app.loadFailed')}</strong>
        <code>{error}</code>
        <button type="button" className="text-btn" onClick={() => setAttempt((n) => n + 1)}>
          {t('app.retry')}
        </button>
      </div>
    );
  }
  if (!editor) return <div className="splash">{t('app.loading')}</div>;

  return (
    <EditorProvider value={editor}>
      <Workspace />
    </EditorProvider>
  );
}
