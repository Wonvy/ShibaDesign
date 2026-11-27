import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@shiba/editor';
import { CanvasHost } from './components/CanvasHost';
import { Inspector } from './components/Inspector';
import { LayersPanel } from './components/LayersPanel';
import { SlideStrip } from './components/SlideStrip';
import { TopBar } from './components/TopBar';
import { createApp } from './editor/bootstrap';
import { EditorProvider, useEditorState } from './editor/context';
import { Toasts } from './ui/toast';

function Workspace(): ReactNode {
  const viewMode = useEditorState((s) => s.viewMode);
  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <aside className="sidebar">
          {viewMode === 'slides' && <SlideStrip />}
          <LayersPanel />
        </aside>
        <CanvasHost />
        <Inspector />
      </div>
      <Toasts />
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
