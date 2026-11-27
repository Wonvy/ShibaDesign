import {
  Circle,
  Eye,
  EyeOff,
  Frame,
  Group,
  Image,
  Spline,
  Square,
  SquaresUnite,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocStore, NodeId, SceneNode } from '@shiba/core';
import { useEditor, useEditorState } from '../editor/context';
import { displayName } from '../names';

const ICONS: Record<string, LucideIcon> = {
  artboard: Frame,
  rect: Square,
  ellipse: Circle,
  path: Spline,
  boolean: SquaresUnite,
  text: Type,
  group: Group,
};

interface Row {
  node: SceneNode;
  depth: number;
}

/** 把树摊平成行；同级里层叠靠上的排在前面，和设计软件的习惯一致 */
function buildRows(store: DocStore, rootId: NodeId, depth = 0, out: Row[] = []): Row[] {
  const children = store.children(rootId);
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i]!;
    out.push({ node, depth });
    buildRows(store, node.id, depth + 1, out);
  }
  return out;
}

export function LayersPanel(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const version = useEditorState((s) => s.docVersion);
  const selection = useEditorState((s) => s.selection);
  const viewMode = useEditorState((s) => s.viewMode);
  const activeArtboardId = useEditorState((s) => s.activeArtboardId);
  const [renaming, setRenaming] = useState<NodeId | null>(null);

  const rootId = viewMode === 'slides' ? activeArtboardId : editor.store.root.id;
  const rows = useMemo(
    () => (rootId && editor.store.has(rootId) ? buildRows(editor.store, rootId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, rootId, version],
  );
  const selected = new Set(selection);

  const rename = (id: NodeId, value: string): void => {
    setRenaming(null);
    const name = value.trim();
    const node = editor.store.get(id);
    if (!node || name === displayName(node, t)) return;
    editor.store.transact('rename', (tx) => tx.update(id, { name: name || undefined }));
    editor.store.sealHistory();
  };

  const toggleVisible = (node: SceneNode): void => {
    editor.store.transact('visibility', (tx) => tx.update(node.id, { visible: !node.visible }));
    editor.store.sealHistory();
  };

  return (
    <div className="panel layers">
      <h2 className="panel-title">{t('panel.layers')}</h2>
      <div className="panel-body">
        {rows.length === 0 && <p className="empty-note">{t('layers.empty')}</p>}
        {rows.map(({ node, depth }) => {
          const isImage = 'fill' in node && node.fill?.type === 'image';
          const Icon = isImage ? Image : (ICONS[node.type] ?? Square);
          const name = displayName(node, t);
          return (
            <div
              key={node.id}
              className={`layer-row${selected.has(node.id) ? ' is-selected' : ''}${node.visible ? '' : ' is-hidden'}`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {renaming === node.id ? (
                <input
                  className="field-input layer-rename"
                  defaultValue={name}
                  autoFocus
                  aria-label={t('layers.renameHint')}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => rename(node.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="layer-main"
                  title={t('layers.renameHint')}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      editor.select(
                        selected.has(node.id) ? selection.filter((id) => id !== node.id) : [...selection, node.id],
                      );
                    } else {
                      editor.select([node.id]);
                    }
                  }}
                  onDoubleClick={() => setRenaming(node.id)}
                >
                  <Icon size={14} className="layer-icon" />
                  <span className="layer-name">{name}</span>
                </button>
              )}
              <button
                type="button"
                className="layer-eye"
                title={node.visible ? t('action.hide') : t('action.show')}
                aria-label={`${node.visible ? t('action.hide') : t('action.show')}: ${name}`}
                onClick={() => toggleVisible(node)}
              >
                {node.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
