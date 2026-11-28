import { ImagePlus, Maximize, Minus, Play, Plus, Redo2, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewMode } from '@shiba/editor';
import { useEditor, useEditorState } from '../editor/context';
import { pickAndPlaceImages } from '../files';
import { toolbarItems } from '../toolbar';
import { IconButton } from '../ui/controls';
import { formatShortcut } from '../ui/shortcut';
import { FileMenu } from './FileMenu';
import { LanguageMenu } from './LanguageMenu';
import { ThemeMenu } from './ThemeMenu';

const VIEW_MODES: ViewMode[] = ['canvas', 'slides'];

export function TopBar(props: { onPlay: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const tool = useEditorState((s) => s.tool);
  const viewMode = useEditorState((s) => s.viewMode);
  const zoom = useEditorState((s) => s.zoom);
  const canUndo = useEditorState((s) => s.canUndo);
  const canRedo = useEditorState((s) => s.canRedo);

  const withShortcut = (label: string, command: string, args?: unknown): string => {
    const key = editor.keymap.keyFor(command, args);
    return key ? `${label} (${formatShortcut(key)})` : label;
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        ShibaDesign
      </div>

      <div className="group">
        <FileMenu />
      </div>

      <div className="group" role="toolbar">
        {toolbarItems.map(({ tool: id, icon: Icon, labelKey }) => (
          <IconButton
            key={id}
            title={withShortcut(t(labelKey), 'tool.set', id)}
            active={tool === id}
            onClick={() => editor.commands.run('tool.set', id)}
          >
            <Icon size={16} />
          </IconButton>
        ))}
        <IconButton title={t('image.place')} onClick={() => void pickAndPlaceImages(editor)}>
          <ImagePlus size={16} />
        </IconButton>
      </div>

      <div className="group">
        <IconButton title={t('action.undo')} disabled={!canUndo} onClick={() => editor.commands.run('edit.undo')}>
          <Undo2 size={16} />
        </IconButton>
        <IconButton title={t('action.redo')} disabled={!canRedo} onClick={() => editor.commands.run('edit.redo')}>
          <Redo2 size={16} />
        </IconButton>
      </div>

      <div className="spacer" />

      <div className="segmented" role="tablist" aria-label={t('view.label')}>
        {VIEW_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={viewMode === mode}
            className={viewMode === mode ? 'is-active' : ''}
            onClick={() => editor.commands.run('view.setMode', mode)}
          >
            {t(`view.${mode}`)}
          </button>
        ))}
      </div>

      <div className="spacer" />

      <div className="group">
        <IconButton title={`${t('present.play')} (${formatShortcut('mod+enter')})`} onClick={props.onPlay}>
          <Play size={16} />
        </IconButton>
      </div>

      <div className="group">
        <IconButton title={t('action.zoomOut')} onClick={() => editor.commands.run('view.zoomOut')}>
          <Minus size={16} />
        </IconButton>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <IconButton title={t('action.zoomIn')} onClick={() => editor.commands.run('view.zoomIn')}>
          <Plus size={16} />
        </IconButton>
        <IconButton title={t('action.zoomToFit')} onClick={() => editor.commands.run('view.zoomToFit')}>
          <Maximize size={16} />
        </IconButton>
      </div>

      <div className="group">
        <ThemeMenu />
        <LanguageMenu />
      </div>
    </header>
  );
}
