import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { slides } from '@shiba/core';
import { playableSlides, type Editor } from '@shiba/editor';
import { DockHost } from './dock/DockHost';
import { TopBar } from './components/TopBar';
import { installClipboard } from './clipboard';
import { GuideDialog } from './components/GuideDialog';
import { persistViewOptions } from './storage/view';
import { CommandPalette } from './menus/CommandPalette';
import { ContextMenuHost } from './menus/ContextMenuHost';
import { installMenus } from './menus/install';
import { useOverlay } from './menus/overlays';
import { ShortcutSheet } from './menus/ShortcutSheet';
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
    // 播放器只放能玩的那几页（看得见、没隐藏的）：从当前这一页（它隐藏了的话是它后面的第一页）开始
    const all = slides(editor.store);
    const active = all.findIndex((s) => s.id === editor.getState().activeArtboardId);
    const playable = playableSlides(editor);
    const index = playable.findIndex((s) => all.indexOf(s) >= active);
    setPresenting(Math.max(0, index));
  }, [editor]);
  const stop = useCallback(() => setPresenting(null), []);

  useEffect(() => installClipboard(editor), [editor]);
  useEffect(() => installMenus(editor), [editor]);
  useEffect(() => persistViewOptions(editor), [editor]);
  const overlay = useOverlay();

  // 演示的两个命令在界面层注册（要打开演示界面），快捷键 ⌘↵、⇧⌘↵ 在快捷键表里
  useEffect(() => {
    editor.commands.register({ id: 'present.play', run: play }).register({
      id: 'present.playFromStart',
      enabled: (e) => playableSlides(e).length > 0,
      run: () => {
        editor.setTool('select');
        setPresenting(0);
      },
    });
  }, [editor, play]);

  return (
    <div className="app">
      <TopBar onPlay={play} />
      <DockHost />
      <Toasts />
      <ContextMenuHost />
      <GuideDialog />
      {overlay === 'palette' && <CommandPalette />}
      {overlay === 'shortcuts' && <ShortcutSheet />}
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
