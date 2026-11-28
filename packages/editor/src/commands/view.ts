import { artboards, type Guide, type NodeId } from '@shiba/core';
import type { Editor } from '../editor';
import type { ViewMode } from '../types';
import type { Command } from './command';

const ZOOM_STEP = 1.25;

export const zoomIn: Command = {
  id: 'view.zoomIn',
  run: (editor) => editor.zoomBy(ZOOM_STEP),
};

export const zoomOut: Command = {
  id: 'view.zoomOut',
  run: (editor) => editor.zoomBy(1 / ZOOM_STEP),
};

export const zoomToFit: Command = {
  id: 'view.zoomToFit',
  run: (editor) => editor.zoomToFit(),
};

export const zoom100: Command = {
  id: 'view.zoom100',
  run: (editor) => editor.zoomBy(1 / editor.camera.zoom),
};

/** 缩放到选区（⇧2）：选中的对象正好放满视口 */
export const zoomToSelection: Command = {
  id: 'view.zoomToSelection',
  enabled: (editor) => editor.selection.length > 0,
  run(editor) {
    const bounds = editor.selectionBounds();
    if (bounds) editor.zoomToFit(bounds);
  },
};

/** 在自由画布和幻灯片两种视图之间切换。数据不变，只换相机和界面 */
export const setViewMode: Command<ViewMode> = {
  id: 'view.setMode',
  run: (editor, mode) => editor.setViewMode(mode),
};

export type ViewToggle =
  | 'rulers'
  | 'guides'
  | 'guidesLocked'
  | 'pixelGrid'
  | 'layoutGrids'
  | 'sizeLabel'
  | 'snapObjects'
  | 'snapGuides'
  | 'snapPixels';

/** 打开或关掉一个视图选项（标尺 ⇧R、辅助线 ⌘;、锁定辅助线 ⌥⌘;、像素网格 ⌘'、版面网格 ⇧G、吸附的几项） */
export const toggleView: Command<ViewToggle> = {
  id: 'view.toggle',
  run(editor, key) {
    editor.setView({ [key]: !editor.view[key] });
    if (key === 'guides' || key === 'guidesLocked') editor.guides.clearSelection();
  },
};

/** 一个画板（或页面）上有没有辅助线 */
function guidesOf(editor: Editor, id: NodeId): readonly Guide[] {
  const node = editor.store.get(id) as { guides?: readonly Guide[] } | undefined;
  return node?.guides ?? [];
}

/** 当前视图里放辅助线的地方：幻灯片视图是这一页，画布视图是页面和所有画板 */
function guideContainers(editor: Editor): NodeId[] {
  if (editor.viewMode === 'slides') return editor.activeArtboard ? [editor.activeArtboard.id] : [];
  return [editor.store.root.id, ...artboards(editor.store).map((b) => b.id)];
}

/** 清除一个画板（或页面）上的辅助线 */
export const clearGuides: Command<NodeId> = {
  id: 'guides.clear',
  enabled: (editor, id) => guidesOf(editor, id).length > 0,
  run(editor, id) {
    editor.store.transact('clear guides', (tx) => tx.update(id, { guides: undefined }));
    editor.store.sealHistory();
    editor.guides.clearSelection();
  },
};

/** 清除当前视图里的全部辅助线 */
export const clearAllGuides: Command = {
  id: 'guides.clearAll',
  enabled: (editor) => guideContainers(editor).some((id) => guidesOf(editor, id).length > 0),
  run(editor) {
    const ids = guideContainers(editor).filter((id) => guidesOf(editor, id).length > 0);
    editor.store.transact('clear guides', (tx) => ids.forEach((id) => tx.update(id, { guides: undefined })));
    editor.store.sealHistory();
    editor.guides.clearSelection();
  },
};

/** 改一条辅助线的位置（双击辅助线输入的值，相对它所在的画板） */
export const setGuide: Command<{ container: NodeId; id: string; offset: number }> = {
  id: 'guides.set',
  enabled: (editor, args) => guidesOf(editor, args.container).some((g) => g.id === args.id),
  run(editor, { container, id, offset }) {
    if (!Number.isFinite(offset)) return;
    const next = guidesOf(editor, container).map((g) => (g.id === id ? { ...g, offset } : g));
    editor.store.transact('move guide', (tx) => tx.update(container, { guides: next }));
    editor.store.sealHistory();
  },
};

/** 删掉一条辅助线 */
export const removeGuide: Command<{ container: NodeId; id: string }> = {
  id: 'guides.remove',
  enabled: (editor, args) => guidesOf(editor, args.container).some((g) => g.id === args.id),
  run(editor, { container, id }) {
    const next = guidesOf(editor, container).filter((g) => g.id !== id);
    editor.store.transact('remove guide', (tx) => tx.update(container, { guides: next.length > 0 ? next : undefined }));
    editor.store.sealHistory();
    editor.guides.clearSelection();
  },
};
