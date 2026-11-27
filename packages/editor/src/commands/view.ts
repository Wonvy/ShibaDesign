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

/** 在自由画布和幻灯片两种视图之间切换。数据不变，只换相机和界面 */
export const setViewMode: Command<ViewMode> = {
  id: 'view.setMode',
  run: (editor, mode) => editor.setViewMode(mode),
};
