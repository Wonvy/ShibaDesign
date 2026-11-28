import type { Editor } from '../editor';
import {
  addAnimation,
  drawAnimationPath,
  moveAnimation,
  removeAnimation,
  reverseAnimationPath,
  setTransition,
  updateAnimation,
} from './animation';
import { alignSelection, distributeSelection, orderSelection } from './arrange';
import { addArtboard, deleteArtboard, duplicateActiveArtboard } from './artboard';
import { createBoolean, releaseBoolean, setBooleanOp } from './boolean';
import { createComponent, detachInstances, goToMainComponent, placeInstance, resetInstances } from './component';
import { createGroup, releaseGroup } from './group';
import { placeImage, setImageFill } from './image';
import { createMask, releaseMask, setMaskMode, toggleMask } from './mask';
import { flattenShapes, offsetPath, outlineStroke, outlineText } from './path';
import { copyProperties, pasteProperties } from './properties';
import {
  addColorStyle,
  addTextStyle,
  applyColorStyle,
  applyTextStyleCommand,
  detachColorStyle,
  detachTextStyle,
  redefineTextStyle,
  removeColorStyle,
  removeTextStyle,
  updateColorStyle,
  updateTextStyle,
} from './style';
import { flipSelection, rotateSelection } from './transform';
import {
  deleteSelection,
  deselect,
  duplicate,
  duplicateNudge,
  nudge,
  redo,
  resizeBy,
  selectAll,
  setTool,
  undo,
} from './edit';
import {
  selectChildren,
  selectInverse,
  selectNext,
  selectParent,
  selectPrevious,
  selectSame,
  showAll,
  toggleLock,
  toggleVisible,
  unlockAll,
} from './select';
import { setViewMode, zoom100, zoomIn, zoomOut, zoomToFit, zoomToSelection } from './view';

/** 注册所有内置命令 */
export function registerBuiltinCommands(editor: Editor): void {
  editor.commands
    .register(undo)
    .register(redo)
    .register(deleteSelection)
    .register(duplicate)
    .register(selectAll)
    .register(deselect)
    .register(nudge)
    .register(setTool)
    .register(alignSelection)
    .register(distributeSelection)
    .register(orderSelection)
    .register(createBoolean)
    .register(releaseBoolean)
    .register(setBooleanOp)
    .register(addArtboard)
    .register(duplicateActiveArtboard)
    .register(deleteArtboard)
    .register(zoomIn)
    .register(zoomOut)
    .register(zoomToFit)
    .register(zoom100)
    .register(setViewMode)
    .register(placeImage)
    .register(setImageFill)
    .register(createGroup)
    .register(releaseGroup)
    .register(createMask)
    .register(releaseMask)
    .register(setMaskMode)
    .register(rotateSelection)
    .register(flipSelection)
    .register(addAnimation)
    .register(updateAnimation)
    .register(removeAnimation)
    .register(moveAnimation)
    .register(setTransition)
    .register(reverseAnimationPath)
    .register(drawAnimationPath)
    .register(outlineStroke)
    .register(offsetPath)
    .register(outlineText)
    .register(createComponent)
    .register(placeInstance)
    .register(detachInstances)
    .register(resetInstances)
    .register(goToMainComponent)
    .register(addColorStyle)
    .register(updateColorStyle)
    .register(removeColorStyle)
    .register(applyColorStyle)
    .register(detachColorStyle)
    .register(addTextStyle)
    .register(updateTextStyle)
    .register(redefineTextStyle)
    .register(removeTextStyle)
    .register(applyTextStyleCommand)
    .register(detachTextStyle)
    .register(copyProperties)
    .register(pasteProperties)
    .register(duplicateNudge)
    .register(resizeBy)
    .register(zoomToSelection)
    .register(toggleMask)
    .register(flattenShapes)
    .register(selectParent)
    .register(selectChildren)
    .register(selectNext)
    .register(selectPrevious)
    .register(selectInverse)
    .register(selectSame)
    .register(toggleLock)
    .register(toggleVisible)
    .register(unlockAll)
    .register(showAll);
}

export type { Command } from './command';
export { CommandRegistry } from './command';
export type { OrderMode } from './arrange';
export type { SameKind } from './select';
export { cloneNodes } from './edit';
export type { OffsetPathArgs } from './path';
export type { AddArtboardArgs } from './artboard';
export { pruneAnimations, setAnimationPath, setSlideNotes, slideLayerOf } from './animation';
export { isMaskNode } from './mask';
export { mainOf } from './component';
export type { PlaceInstanceArgs } from './component';
export { selectionColor } from './style';
export { hasCopiedProperties } from './properties';
export type {
  AddColorStyleArgs,
  AddTextStyleArgs,
  ColorTarget,
  UpdateColorStyleArgs,
  UpdateTextStyleArgs,
} from './style';
