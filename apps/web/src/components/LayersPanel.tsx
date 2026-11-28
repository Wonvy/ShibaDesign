import {
  ChevronDown,
  ChevronRight,
  Circle,
  Component,
  Crop,
  Diamond,
  Eye,
  EyeOff,
  Frame,
  Group,
  Image,
  Lock,
  LockOpen,
  Pentagon,
  Search,
  Sparkles,
  Spline,
  Square,
  SquareDashed,
  SquaresUnite,
  Star,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ancestors,
  isComponent,
  isInstance,
  isInstanceCopy,
  type DocStore,
  type NodeId,
  type SceneNode,
} from '@shiba/core';
import { isMaskNode, slideLayerOf, type Editor } from '@shiba/editor';
import { useEditor, useEditorState } from '../editor/context';
import { openPanelMenu } from '../menus/context';
import { displayName } from '../names';
import { onRenameRequest } from '../ui/rename';

const ICONS: Record<string, LucideIcon> = {
  artboard: Frame,
  rect: Square,
  ellipse: Circle,
  polygon: Pentagon,
  path: Spline,
  boolean: SquaresUnite,
  text: Type,
  group: Group,
};

/** 每一层缩进多少像素 */
const INDENT = 14;
/** 拖动挪出多远才算开始拖 */
const DRAG_START = 4;
/** 拖到折叠的组上停多久自动展开 */
const EXPAND_DELAY = 600;

interface Row {
  node: SceneNode;
  depth: number;
  hasChildren: boolean;
}

/** 能"放进去"的容器：画板、编组、布尔组（不含实例） */
function isContainer(node: SceneNode): boolean {
  return (
    (node.type === 'artboard' || node.type === 'group' || node.type === 'boolean') &&
    !isInstance(node) &&
    !isInstanceCopy(node)
  );
}

/** 把树摊平成行；同级里层叠靠上的排在前面，和设计软件的习惯一致。折叠的组不往下摊 */
function buildRows(store: DocStore, rootId: NodeId, collapsed: ReadonlySet<NodeId>, depth = 0, out: Row[] = []): Row[] {
  const children = store.children(rootId);
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i]!;
    const hasChildren = store.children(node.id).length > 0;
    out.push({ node, depth, hasChildren });
    if (hasChildren && !collapsed.has(node.id)) buildRows(store, node.id, collapsed, depth + 1, out);
  }
  return out;
}

/** 搜索：名字里有这些字的，按树的顺序列出来，不缩进 */
function searchRows(editor: Editor, rootId: NodeId, query: string, t: (key: string) => string): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: Row[] = [];
  const walk = (parentId: NodeId): void => {
    const children = editor.store.children(parentId);
    for (let i = children.length - 1; i >= 0; i--) {
      const node = children[i]!;
      const name = `${displayName(node, t, editor.store)} ${t(`node.${node.type}`)}`.toLowerCase();
      if (words.every((w) => name.includes(w))) out.push({ node, depth: 0, hasChildren: false });
      walk(node.id);
    }
  };
  walk(rootId);
  return out;
}

/** 拖动放下的位置：放在某一行的上面、下面，或者放进某个容器 */
type DropSpot = { row: number; where: 'above' | 'below' | 'into' };

/**
 * 图层列表。拖动行调整层序、拖进编组或画板（Alt 拖动是复制）；三角折叠展开（Alt 点三角折叠展开全部子孙）；
 * 锁和眼睛（Alt 点眼睛只显示这一个，按住在一列眼睛上拖过去一次开关好几个）；⌘ 单击加减选，⇧ 单击连选一段；
 * 顶上可以搜索；列表有焦点时 ↑↓ 换选中的行、← → 折叠展开、回车改名、⌫ 删除
 */
export function LayersPanel(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const version = useEditorState((s) => s.docVersion);
  const selection = useEditorState((s) => s.selection);
  const viewMode = useEditorState((s) => s.viewMode);
  const activeArtboardId = useEditorState((s) => s.activeArtboardId);
  const [renaming, setRenaming] = useState<NodeId | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<NodeId>>(new Set());
  const [query, setQuery] = useState('');
  const [drop, setDrop] = useState<DropSpot | null>(null);
  const anchor = useRef<NodeId | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rootId = viewMode === 'slides' ? activeArtboardId : editor.store.root.id;
  const rows = useMemo(
    () =>
      !rootId || !editor.store.has(rootId)
        ? []
        : query.trim()
          ? searchRows(editor, rootId, query, t)
          : buildRows(editor.store, rootId, collapsed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, rootId, version, collapsed, query, t],
  );
  const selected = new Set(selection);

  // 重命名（⌘R、菜单）：那一行进入改名状态
  useEffect(() => onRenameRequest((id) => setRenaming(id)), []);

  // 选中的对象被折叠在组里时，把上级展开；然后滚到那一行
  useEffect(() => {
    const hidden = selection
      .flatMap((id) => ancestors(editor.store, id).map((a) => a.id))
      .filter((id) => collapsed.has(id));
    if (hidden.length > 0) {
      setCollapsed((current) => new Set([...current].filter((id) => !hidden.includes(id))));
      return;
    }
    const first = selection[0];
    if (first) listRef.current?.querySelector(`[data-layer="${first}"]`)?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const rename = (id: NodeId, value: string): void => {
    setRenaming(null);
    const name = value.trim();
    const node = editor.store.get(id);
    if (!node || name === displayName(node, t, editor.store)) return;
    editor.store.transact('rename', (tx) => tx.update(id, { name: name || undefined }));
    editor.store.sealHistory();
  };

  const toggleCollapse = (node: SceneNode, all: boolean): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      const closing = !current.has(node.id);
      const ids = all ? [node.id, ...descendantsOf(editor.store, node.id)] : [node.id];
      for (const id of ids) {
        if (closing) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const click = (event: React.MouseEvent, node: SceneNode, index: number): void => {
    if (event.shiftKey && anchor.current) {
      // 连选：从上次点的那一行到这一行
      const from = rows.findIndex((r) => r.node.id === anchor.current);
      if (from >= 0) {
        const [a, b] = from < index ? [from, index] : [index, from];
        editor.select(rows.slice(a, b + 1).map((r) => r.node.id));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      editor.select(selected.has(node.id) ? selection.filter((id) => id !== node.id) : [...selection, node.id]);
    } else {
      editor.select([node.id]);
    }
    anchor.current = node.id;
  };

  // ───────────── 眼睛和锁 ─────────────

  /** 按住在一列眼睛上拖过去：经过的都设成按下那一个要变成的样子，整个是一步撤销 */
  const eyeSweep = useRef<{ visible: boolean; key: string } | null>(null);
  useEffect(() => {
    const stop = (): void => {
      if (eyeSweep.current) editor.store.sealHistory();
      eyeSweep.current = null;
    };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, [editor]);

  const setVisible = (node: SceneNode, visible: boolean, key: string): void => {
    editor.store.transact('visibility', (tx) => tx.update(node.id, { visible }), { mergeKey: key });
  };

  const onEyeDown = (event: React.PointerEvent, node: SceneNode): void => {
    event.preventDefault();
    if (event.altKey) {
      // 只显示这一个（同级的其他都隐藏），再 Alt 点一次全部显示
      editor.commands.run('node.solo', node.id);
      return;
    }
    const key = editor.newMergeKey('eyes');
    eyeSweep.current = { visible: !node.visible, key };
    setVisible(node, !node.visible, key);
  };

  const toggleLock = (node: SceneNode): void => {
    editor.store.transact(node.locked ? 'unlock' : 'lock', (tx) => tx.update(node.id, { locked: !node.locked }));
    editor.store.sealHistory();
  };

  // ───────────── 拖动排序 ─────────────

  const spotAt = (clientY: number): DropSpot | null => {
    const list = listRef.current;
    if (!list) return null;
    const elements = [...list.querySelectorAll<HTMLElement>('[data-layer]')];
    for (let i = 0; i < elements.length; i++) {
      const r = elements[i]!.getBoundingClientRect();
      if (clientY < r.top || clientY > r.bottom) continue;
      const row = rows[i];
      if (!row) return null;
      const y = (clientY - r.top) / r.height;
      // 容器那一行的中间三分之一是放进去
      if (isContainer(row.node) && y > 1 / 3 && y < 2 / 3) return { row: i, where: 'into' };
      return { row: i, where: y < 0.5 ? 'above' : 'below' };
    }
    const last = elements.at(-1)?.getBoundingClientRect();
    if (last && clientY > last.bottom && rows.length > 0) return { row: rows.length - 1, where: 'below' };
    return null;
  };

  /** 放下的位置换成命令的参数：父节点和放在哪个同级的上面 */
  const targetOf = (spot: DropSpot): { parent: NodeId; above: NodeId | null } | null => {
    const row = rows[spot.row];
    if (!row) return null;
    const node = row.node;
    if (spot.where === 'into') {
      const children = editor.store.children(node.id);
      return { parent: node.id, above: children.at(-1)?.id ?? null };
    }
    // 展开的容器的下面：放进它里面的最上面
    if (spot.where === 'below' && row.hasChildren && !collapsed.has(node.id) && !query) {
      const children = editor.store.children(node.id);
      return { parent: node.id, above: children.at(-1)?.id ?? null };
    }
    const parent = node.parent;
    if (!parent) return null;
    const siblings = editor.store.children(parent);
    const at = siblings.findIndex((s) => s.id === node.id);
    // 列表里上面的是层序靠上的：放在这一行"上面"就是层序在它上面
    return spot.where === 'above' ? { parent, above: node.id } : { parent, above: siblings[at - 1]?.id ?? null };
  };

  const startDrag = (event: React.PointerEvent, node: SceneNode): void => {
    if (event.button !== 0 || renaming) return;
    const startY = event.clientY;
    const startX = event.clientX;
    let dragging = false;
    let expandTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSpot: DropSpot | null = null;
    const ids = selected.has(node.id) ? [...selection] : [node.id];
    const move = (e: PointerEvent): void => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_START) return;
      dragging = true;
      const spot = spotAt(e.clientY);
      const target = spot ? targetOf(spot) : null;
      const ok = target && editor.commands.canRun('node.moveTo', { ids, ...target, copy: e.altKey });
      lastSpot = ok ? spot : null;
      setDrop(lastSpot);
      // 停在折叠的组上一会儿：展开它
      if (expandTimer) clearTimeout(expandTimer);
      const row = spot ? rows[spot.row] : undefined;
      if (spot?.where === 'into' && row && collapsed.has(row.node.id)) {
        expandTimer = setTimeout(() => toggleCollapse(row.node, false), EXPAND_DELAY);
      }
      // 拖到列表边缘自动滚动
      const list = listRef.current;
      if (list) {
        const r = list.getBoundingClientRect();
        if (e.clientY < r.top + 20) list.scrollTop -= 12;
        else if (e.clientY > r.bottom - 20) list.scrollTop += 12;
      }
    };
    const up = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (expandTimer) clearTimeout(expandTimer);
      setDrop(null);
      if (!dragging || !lastSpot) return;
      const target = targetOf(lastSpot);
      if (target) editor.commands.run('node.moveTo', { ids, ...target, copy: e.altKey });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ───────────── 键盘 ─────────────

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) return;
    const current = rows.findIndex((r) => r.node.id === selection[0]);
    const row = rows[current];
    let handled = true;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) editor.select([next.node.id]);
    } else if (event.key === 'ArrowLeft' && row?.hasChildren && !collapsed.has(row.node.id)) {
      toggleCollapse(row.node, false);
    } else if (event.key === 'ArrowRight' && row?.hasChildren && collapsed.has(row.node.id)) {
      toggleCollapse(row.node, false);
    } else if (event.key === 'Enter' && row) {
      setRenaming(row.node.id);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      editor.commands.run('edit.delete');
    } else {
      handled = false;
    }
    if (handled) {
      // 不让画布的快捷键再处理一遍（比如 ⌫ 删两次）
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const dropLine = (index: number): string => {
    if (!drop || drop.row !== index) return '';
    return drop.where === 'into' ? ' is-drop-into' : drop.where === 'above' ? ' is-drop-above' : ' is-drop-below';
  };

  return (
    <div className="layers-panel" role="tabpanel">
      <label className="layers-search">
        <Search size={13} />
        <input
          className="field-input"
          placeholder={t('layers.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
          aria-label={t('layers.search')}
        />
      </label>
      <div className="panel-body layers-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
        {rows.length === 0 && <p className="empty-note">{t(query ? 'layers.noMatch' : 'layers.empty')}</p>}
        {rows.map(({ node, depth, hasChildren }, index) => {
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
                    : node.type === 'polygon' && node.innerRatio !== undefined
                      ? Star
                      : (ICONS[node.type] ?? Square);
          const name = displayName(node, t, editor.store);
          // 主组件、实例和实例里的东西用组件色标出来
          const tone = isComponent(node) || isInstance(node) || node.source !== undefined ? ' is-component' : '';
          const animated = hasAnimation(editor, node);
          return (
            <div
              key={node.id}
              data-layer={node.id}
              className={`layer-row${selected.has(node.id) ? ' is-selected' : ''}${node.visible ? '' : ' is-hidden'}${node.locked ? ' is-locked' : ''}${tone}${dropLine(index)}`}
              style={{ paddingLeft: 4 + depth * INDENT }}
              onContextMenu={(event) => {
                if (!selected.has(node.id)) editor.select([node.id]);
                openPanelMenu(event, editor, 'layer.row', node.id);
              }}
              onMouseEnter={() => editor.setHover(node.id)}
              onMouseLeave={() => editor.setHover(null)}
            >
              <button
                type="button"
                className="layer-toggle"
                tabIndex={-1}
                aria-label={hasChildren ? t(collapsed.has(node.id) ? 'layers.expand' : 'layers.collapse') : undefined}
                aria-hidden={!hasChildren}
                disabled={!hasChildren}
                onClick={(event) => toggleCollapse(node, event.altKey)}
              >
                {hasChildren && (collapsed.has(node.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />)}
              </button>
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
                    e.stopPropagation();
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="layer-main"
                  title={t('layers.renameHint')}
                  tabIndex={-1}
                  onPointerDown={(event) => startDrag(event, node)}
                  onClick={(event) => click(event, node, index)}
                  onDoubleClick={() => setRenaming(node.id)}
                >
                  <Icon size={14} className="layer-icon" />
                  <span className="layer-name">{name}</span>
                  {animated && <Sparkles size={11} className="layer-badge" aria-label={t('layers.animated')} />}
                </button>
              )}
              <button
                type="button"
                className={`layer-lock${node.locked ? ' is-on' : ''}`}
                tabIndex={-1}
                title={node.locked ? t('menu.unlock') : t('menu.lock')}
                aria-label={`${node.locked ? t('menu.unlock') : t('menu.lock')}: ${name}`}
                onClick={() => toggleLock(node)}
              >
                {node.locked ? <Lock size={13} /> : <LockOpen size={13} />}
              </button>
              <button
                type="button"
                className="layer-eye"
                tabIndex={-1}
                title={`${node.visible ? t('action.hide') : t('action.show')} · ${t('layers.soloHint')}`}
                aria-label={`${node.visible ? t('action.hide') : t('action.show')}: ${name}`}
                onPointerDown={(event) => onEyeDown(event, node)}
                onPointerEnter={(event) => {
                  const sweep = eyeSweep.current;
                  if (sweep && event.buttons === 1 && node.visible !== sweep.visible)
                    setVisible(node, sweep.visible, sweep.key);
                }}
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

function descendantsOf(store: DocStore, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const walk = (parent: NodeId): void => {
    for (const child of store.children(parent)) {
      out.push(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** 这个对象在它那一页上有没有动画（图层上标一个小星星） */
function hasAnimation(editor: Editor, node: SceneNode): boolean {
  const layer = slideLayerOf(editor.store, node.id);
  if (!layer || layer.layer.id !== node.id) return false;
  return layer.slide.deck?.animations?.some((a) => a.target === node.id) ?? false;
}
