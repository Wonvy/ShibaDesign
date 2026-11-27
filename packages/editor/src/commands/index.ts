import type { Editor } from '../editor';
import { alignSelection, distributeSelection, orderSelection } from './arrange';
import { addArtboard, deleteArtboard, duplicateActiveArtboard } from './artboard';
import { createBoolean, releaseBoolean, setBooleanOp } from './boolean';
import { createGroup, releaseGroup } from './group';
import { placeImage, setImageFill } from './image';
import { flipSelection, rotateSelection } from './transform';
import { deleteSelection, deselect, duplicate, nudge, redo, selectAll, setTool, undo } from './edit';
import { setViewMode, zoom100, zoomIn, zoomOut, zoomToFit } from './view';

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
    .register(rotateSelection)
    .register(flipSelection);
}

export type { Command } from './command';
export { CommandRegistry } from './command';
export type { OrderMode } from './arrange';
