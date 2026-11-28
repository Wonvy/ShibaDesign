import {
  Circle,
  Component,
  Crop,
  Diamond,
  Eye,
  EyeOff,
  Frame,
  Group,
  Image,
  Spline,
  Square,
  SquareDashed,
  SquaresUnite,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isComponent, isInstance, type DocStore, type NodeId, type SceneNode } from '@shiba/core';
import { isMaskNode } from '@shiba/editor';
import { useEditor, useEditorState } from '../editor/context';
import { openPanelMenu } from '../menus/context';
import { displayName } from '../names';
import { onRenameRequest } from '../ui/rename';

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

/** 图层列表。标题（和"资源"切换的标签）在 Sidebar 里 */
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

  // 重命名（⌘R、菜单）：那一行进入改名状态
  useEffect(() => onRenameRequest((id) => setRenaming(id)), []);

  const rename = (id: NodeId, value: string): void => {
    setRenaming(null);
    const name = value.trim();
    const node = editor.store.get(id);
    if (!node || name === displayName(node, t, editor.store)) return;
    editor.store.transact('rename', (tx) => tx.update(id, { name: name || undefined }));
    editor.store.sealHistory();
  };

  const toggleVisible = (node: SceneNode): void => {
    editor.store.transact('visibility', (tx) => tx.update(node.id, { visible: !node.visible }));
    editor.store.sealHistory();
  };

  return (
    <div className="panel-body" role="tabpanel">
      {rows.length === 0 && <p className="empty-note">{t('layers.empty')}</p>}
      {rows.map(({ node, depth }) => {
        const isImage = 'fill' in node && node.fill?.type === 'image';
        // 蒙版组和组里当蒙版的那个对象用自己的图标，一眼看出谁遮住谁
        const isMask = isMaskNode(editor, node);
        const Icon = isMask
          ? SquareDashed
          : isComponent(node)
            ? Component
            : isInstance(node)
              ? Diamond
              : node.type === 'group' && node.mask
                ? Crop
                : isImage
                  ? Image
                  : (ICONS[node.type] ?? Square);
        const name = displayName(node, t, editor.store);
        // 主组件、实例和实例里的东西用组件色标出来
        const tone = isComponent(node) || isInstance(node) || node.source !== undefined ? ' is-component' : '';
        return (
          <div
            key={node.id}
            className={`layer-row${selected.has(node.id) ? ' is-selected' : ''}${node.visible ? '' : ' is-hidden'}${tone}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onContextMenu={(event) => {
              if (!selected.has(node.id)) editor.select([node.id]);
              openPanelMenu(event, editor, 'layer.row', node.id);
            }}
            onMouseEnter={() => editor.setHover(node.id)}
            onMouseLeave={() => editor.setHover(null)}
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
  );
}
