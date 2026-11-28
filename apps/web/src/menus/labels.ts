/**
 * 命令（连同参数）在界面上叫什么：语言包的键。菜单、命令面板、快捷键表都用它，同一个命令到处叫同一个名字。
 * 键写成 "命令 id" 或 "命令 id|参数的 JSON"；带参数的查不到时退回不带参数的那一条（比如所有方向的微移都叫"微移"）。
 * 这个文件不依赖浏览器，单元测试检查每条快捷键都有名字、名字在两个语言包里都有
 */
export const COMMAND_LABELS: Record<string, string> = {
  'tool.set|"select"': 'tool.select',
  'tool.set|"direct"': 'tool.direct',
  'tool.set|"scale"': 'tool.scale',
  'tool.set|"frame"': 'tool.frame',
  'tool.set|"line"': 'tool.line',
  'tool.set|"arrow"': 'tool.arrow',
  'tool.set|"polygon"': 'tool.polygon',
  'tool.set|"star"': 'tool.star',
  'tool.set|"pencil"': 'tool.pencil',
  'tool.set|"eyedropper"': 'tool.eyedropper',
  'tool.set|"zoom"': 'tool.zoom',
  'tool.set|"hand"': 'tool.hand',
  'tool.set|"rect"': 'tool.rect',
  'tool.set|"ellipse"': 'tool.ellipse',
  'tool.set|"pen"': 'tool.pen',
  'tool.set|"text"': 'tool.text',

  'edit.undo': 'action.undo',
  'edit.redo': 'action.redo',
  'edit.cut': 'menu.cut',
  'edit.copy': 'menu.copy',
  'edit.paste': 'menu.paste',
  'edit.pasteInPlace': 'menu.pasteInPlace',
  'edit.pasteHere': 'menu.pasteHere',
  'edit.copyAsPng': 'menu.copyAsPng',
  'edit.copyAsSvg': 'menu.copyAsSvg',
  'edit.copyAsCss': 'menu.copyAsCss',
  'edit.copyProperties': 'menu.copyProperties',
  'edit.pasteProperties': 'menu.pasteProperties',
  'edit.duplicate': 'menu.duplicate',
  'edit.delete': 'menu.delete',
  'edit.selectAll': 'menu.selectAll',
  'edit.deselect': 'menu.deselect',
  'edit.nudge': 'menu.nudge',
  'edit.resize': 'menu.resizeBy',
  'edit.duplicateNudge': 'menu.duplicateNudge',
  'node.rename': 'menu.rename',

  'select.children': 'menu.selectChildren',
  'select.parent': 'menu.selectParent',
  'select.next': 'menu.selectNext',
  'select.previous': 'menu.selectPrevious',
  'select.inverse': 'menu.selectInverse',
  'select.same|"fill"': 'menu.selectSameFill',
  'select.same|"stroke"': 'menu.selectSameStroke',
  'select.same|"font"': 'menu.selectSameFont',
  'select.same|"type"': 'menu.selectSameType',
  'select.same|"instances"': 'menu.selectInstances',

  'arrange.order|"front"': 'order.front',
  'arrange.order|"forward"': 'order.forward',
  'arrange.order|"backward"': 'order.backward',
  'arrange.order|"back"': 'order.back',
  'arrange.align|"left"': 'align.left',
  'arrange.align|"hcenter"': 'align.hcenter',
  'arrange.align|"right"': 'align.right',
  'arrange.align|"top"': 'align.top',
  'arrange.align|"vcenter"': 'align.vcenter',
  'arrange.align|"bottom"': 'align.bottom',
  'arrange.distribute|"hspacing"': 'distribute.hspacing',
  'arrange.distribute|"vspacing"': 'distribute.vspacing',
  'arrange.flip|"horizontal"': 'transform.flipH',
  'arrange.flip|"vertical"': 'transform.flipV',
  'arrange.rotate|90': 'transform.rotate90',
  'arrange.rotate|-90': 'menu.rotateCcw',
  'arrange.scale': 'menu.scaleUniform',

  'group.create': 'group.create',
  'group.release': 'group.release',
  'frame.wrap': 'frame.wrap',
  'frame.autoLayout': 'frame.autoLayout',
  'frame.removeAutoLayout': 'frame.removeAutoLayout',
  'mask.toggle': 'menu.maskToggle',
  'mask.create': 'mask.create',
  'mask.release': 'mask.release',
  'boolean.create|"union"': 'boolean.union',
  'boolean.create|"subtract"': 'boolean.subtract',
  'boolean.create|"intersect"': 'boolean.intersect',
  'boolean.create|"exclude"': 'boolean.exclude',
  'boolean.release': 'boolean.release',
  'path.flatten': 'menu.flatten',
  'path.outlineStroke': 'path.outlineStroke',
  'path.offset': 'path.offset',
  'text.outline': 'path.outlineText',
  'component.create': 'component.create',
  'component.detach': 'component.detach',
  'component.reset': 'component.reset',
  'component.goToMain': 'component.goToMain',
  'node.toggleLock': 'menu.lockToggle',
  'node.toggleVisible': 'menu.hideToggle',
  'node.unlockAll': 'menu.unlockAll',
  'node.showAll': 'menu.showAll',
  'image.resetRatio': 'menu.resetRatio',
  'artboard.toggleSkip': 'menu.hideSlide',
  'node.moveTo': 'menu.moveLayers',
  'artboard.reorder': 'menu.reorderSlides',

  'text.toggle|"bold"': 'text.bold',
  'text.toggle|"italic"': 'text.italic',
  'text.toggle|"underline"': 'text.underline',
  'text.toggle|"strikethrough"': 'text.strikethrough',
  'text.fontStep|1': 'menu.fontBigger',
  'text.fontStep|-1': 'menu.fontSmaller',
  'text.paragraph|{"patch":{"align":"left"}}': 'text.alignLeft',
  'text.paragraph|{"patch":{"align":"center"}}': 'text.alignCenter',
  'text.paragraph|{"patch":{"align":"right"}}': 'text.alignRight',
  'text.paragraph|{"patch":{"align":"justify"}}': 'text.alignJustify',
  'text.list|"bullet"': 'text.bullets',
  'text.list|"number"': 'text.numbering',

  'view.zoomIn': 'action.zoomIn',
  'view.zoomOut': 'action.zoomOut',
  'view.zoomToFit': 'action.zoomToFit',
  'view.zoom100': 'menu.zoom100',
  'view.zoomToSelection': 'menu.zoomToSelection',
  'view.toggle|"rulers"': 'menu.rulers',
  'view.toggle|"guides"': 'menu.guides',
  'view.toggle|"guidesLocked"': 'menu.lockGuides',
  'view.toggle|"pixelGrid"': 'menu.pixelGrid',
  'view.toggle|"layoutGrids"': 'menu.layoutGrids',
  'view.toggle|"sizeLabel"': 'menu.sizeLabel',
  'view.toggle|"snapObjects"': 'menu.snapObjects',
  'view.toggle|"snapGuides"': 'menu.snapGuides',
  'view.toggle|"snapPixels"': 'menu.snapPixels',
  'view.toggle|"alignToContainer"': 'align.toContainerOff',
  'guides.clearAll': 'menu.clearGuides',
  'guides.clear': 'menu.clearBoardGuides',
  'guides.remove': 'menu.removeGuide',
  'view.setMode|"canvas"': 'view.canvas',
  'view.setMode|"slides"': 'view.slides',

  'dock.show|"layers"': 'panel.layers',
  'dock.show|"assets"': 'panel.assets',
  'dock.show|"slides"': 'panel.slides',
  'dock.toggle': 'menu.togglePanel',
  'dock.toggleHidden': 'menu.hideUi',
  'present.play': 'present.play',
  'present.playFromStart': 'menu.playFromStart',
  'help.commandPalette': 'menu.commandPalette',
  'help.shortcuts': 'menu.shortcuts',
};

/** 命令的名字（语言包的键）；查不到时返回 undefined */
export function labelKeyFor(command: string, args?: unknown): string | undefined {
  if (args !== undefined) {
    const exact = COMMAND_LABELS[`${command}|${JSON.stringify(args)}`];
    if (exact) return exact;
  }
  return COMMAND_LABELS[command];
}

/** 快捷键表里的分组：按命令 id 的前缀 */
export function commandGroup(command: string): string {
  const prefix = command.split('.')[0]!;
  if (prefix === 'tool') return 'tools';
  if (prefix === 'edit' || prefix === 'select') return command.startsWith('select.') ? 'select' : 'edit';
  if (prefix === 'text') return command === 'text.outline' ? 'object' : 'text';
  if (prefix === 'view' || prefix === 'dock') return 'view';
  if (prefix === 'present') return 'present';
  if (prefix === 'help') return 'help';
  return 'object';
}

export const COMMAND_GROUPS = ['tools', 'edit', 'select', 'object', 'text', 'view', 'present', 'help'] as const;
