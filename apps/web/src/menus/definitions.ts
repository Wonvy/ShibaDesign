import {
  DEFAULT_TRANSITION,
  TRANSITION_EFFECTS,
  hasShapeStyle,
  isComponent,
  isInstance,
  slides,
  type NodeId,
  type SceneNode,
} from '@shiba/core';
import {
  exportHtml,
  exportImage,
  exportPdf,
  openDocument,
  pickAndPlaceImages,
  pickImageFill,
  saveDocument,
  saveDocumentAs,
} from '../files';
import { i18n } from '../i18n';
import { displayName } from '../names';
import { openFileDialog } from '../components/FileMenu';
import { slidesForMenu } from '../components/SlideStrip';
import type { ViewToggle } from '@shiba/editor';
import {
  WORKSPACE_PRESETS,
  closeTab,
  findTab,
  isTabVisible,
  moveTab,
  presetLayout,
  type DropTarget,
  type ZoneId,
} from '../dock/layout';
import { listDockPanels } from '../dock/registry';
import { getLayout, resetLayout, setLayout } from '../dock/store';
import { labelKeyFor } from './labels';
import { registerMenu, type MenuContext, type MenuEntry, type MenuItemDef } from './model';
import { toast } from '../ui/toast';

/**
 * 内置的菜单：右键菜单（画布上的对象、正在编辑的文字、画板、画布空白处、幻灯片缩略图、图层、资源）
 * 和顶部菜单栏的每一栏。命令的名字来自 labels.ts，所以菜单、命令面板、快捷键表里叫同一个名字
 */

/** 一个执行命令的菜单项，名字按命令查 */
function cmd(command: string, args?: unknown, extra: Partial<MenuItemDef> = {}): MenuItemDef {
  const id = args === undefined ? command : `${command}:${JSON.stringify(args)}`;
  return { id, labelKey: labelKeyFor(command, args) ?? command, command, args, ...extra };
}

function sub(id: string, labelKey: string, submenu: (ctx: MenuContext) => MenuEntry[]): MenuItemDef {
  return { id, labelKey, submenu };
}

const selected = (ctx: MenuContext): SceneNode[] => ctx.editor.selectedNodes();
const hasImage = (ctx: MenuContext): boolean =>
  selected(ctx).some((n) => 'fill' in n && (n.fill as { type?: string } | null)?.type === 'image');

// ───────────── 几组常用的项 ─────────────

function clipboardItems(ctx: MenuContext, here: boolean): MenuEntry[] {
  return [
    cmd('edit.cut', undefined, { shortcut: 'mod+x' }),
    cmd('edit.copy', undefined, { shortcut: 'mod+c' }),
    cmd('edit.paste', undefined, { shortcut: 'mod+v' }),
    ...(here ? [cmd('edit.pasteHere', ctx.info.world)] : []),
    cmd('edit.pasteInPlace', undefined, { shortcut: 'mod+shift+v' }),
    sub('copyAs', 'menu.copyAs', () => [cmd('edit.copyAsPng'), cmd('edit.copyAsSvg')]),
    cmd('edit.copyProperties'),
    cmd('edit.pasteProperties'),
  ];
}

function selectItems(): MenuItemDef {
  return sub('select', 'menu.select', () => [
    cmd('select.same', 'fill'),
    cmd('select.same', 'stroke'),
    cmd('select.same', 'font'),
    cmd('select.same', 'type'),
    cmd('select.same', 'instances'),
    'separator',
    cmd('select.inverse'),
  ]);
}

/** "选择图层"：鼠标下所有重叠的对象，悬停时画布上高亮 */
function layerStack(ctx: MenuContext): MenuItemDef | null {
  const { editor, info } = ctx;
  if (info.stack.length < 2) return null;
  return sub('selectLayer', 'menu.selectLayer', () =>
    info.stack.flatMap((id) => {
      const node = editor.store.get(id);
      if (!node) return [];
      return [
        {
          id: `layer:${id}`,
          labelKey: '',
          label: displayName(node, i18n.t.bind(i18n), editor.store),
          run: () => editor.select([id]),
          checked: () => editor.selection.includes(id),
          hoverNode: id,
        },
      ];
    }),
  );
}

function arrangeItems(ctx: MenuContext): MenuEntry[] {
  const multi = selected(ctx).length >= 2;
  return [
    sub('order', 'panel.order', () => [
      cmd('arrange.order', 'front'),
      cmd('arrange.order', 'forward'),
      cmd('arrange.order', 'backward'),
      cmd('arrange.order', 'back'),
    ]),
    sub('align', 'panel.align', () => [
      cmd('arrange.align', 'left'),
      cmd('arrange.align', 'hcenter'),
      cmd('arrange.align', 'right'),
      'separator',
      cmd('arrange.align', 'top'),
      cmd('arrange.align', 'vcenter'),
      cmd('arrange.align', 'bottom'),
      ...(multi
        ? (['separator', cmd('arrange.distribute', 'hspacing'), cmd('arrange.distribute', 'vspacing')] as MenuEntry[])
        : []),
    ]),
    sub('transform', 'menu.transform', () => [
      cmd('arrange.flip', 'horizontal'),
      cmd('arrange.flip', 'vertical'),
      'separator',
      cmd('arrange.rotate', 90),
      cmd('arrange.rotate', -90),
    ]),
  ];
}

function structureItems(ctx: MenuContext): MenuEntry[] {
  const nodes = selected(ctx);
  const shapes = nodes.filter(hasShapeStyle).length;
  const isMask = nodes.some((n) => n.type === 'group' && n.mask);
  return [
    cmd('group.create'),
    cmd('group.release'),
    cmd('frame.wrap'),
    cmd('frame.autoLayout'),
    cmd('frame.removeAutoLayout'),
    cmd('mask.toggle', undefined, { labelKey: isMask ? 'mask.release' : 'mask.create' }),
    ...(shapes >= 1
      ? [
          sub('boolean', 'panel.boolean', () => [
            cmd('boolean.create', 'union'),
            cmd('boolean.create', 'subtract'),
            cmd('boolean.create', 'intersect'),
            cmd('boolean.create', 'exclude'),
            'separator',
            cmd('path.flatten'),
          ]),
        ]
      : []),
    sub('path', 'panel.path', () => [
      cmd('path.outlineStroke'),
      cmd('path.offset'),
      cmd('text.outline'),
      cmd('path.flatten'),
    ]),
  ];
}

function componentItems(ctx: MenuContext): MenuEntry[] {
  const nodes = selected(ctx);
  const related = nodes.some((n) => isComponent(n) || isInstance(n) || n.source !== undefined);
  return [
    related
      ? sub('component', 'panel.component', () => [
          cmd('component.create'),
          cmd('component.goToMain'),
          cmd('component.reset'),
          cmd('component.detach'),
        ])
      : cmd('component.create'),
  ];
}

function imageItems(ctx: MenuContext): MenuEntry[] {
  if (!hasImage(ctx)) return [];
  const node = selected(ctx)[0]!;
  return [
    sub('image', 'menu.image', () => [
      {
        id: 'image.position',
        labelKey: 'menu.adjustImagePosition',
        run: () => ctx.editor.setFillEditing({ id: node.id, kind: 'image' }),
        enabled: () => selected(ctx).length === 1,
      },
      { id: 'image.replace', labelKey: 'image.replace', run: () => void pickImageFill(ctx.editor) },
      cmd('image.resetRatio'),
    ]),
  ];
}

function slideItems(ctx: MenuContext): MenuEntry[] {
  const deck = slides(ctx.editor.store);
  if (deck.length < 2) return [];
  return [
    sub('moveToSlide', 'menu.moveToSlide', () =>
      deck.map((slide, i) =>
        cmd('arrange.moveToSlide', slide.id, { labelKey: 'menu.slideN', labelArgs: { n: i + 1 } }),
      ),
    ),
  ];
}

function stateItems(ctx: MenuContext): MenuEntry[] {
  const nodes = selected(ctx);
  const allLocked = nodes.length > 0 && nodes.every((n) => n.locked);
  const allHidden = nodes.length > 0 && nodes.every((n) => !n.visible);
  return [
    cmd('node.toggleLock', undefined, { labelKey: allLocked ? 'menu.unlock' : 'menu.lock' }),
    cmd('node.toggleVisible', undefined, { labelKey: allHidden ? 'menu.show' : 'menu.hide' }),
  ];
}

/** 画布上的对象、图层面板的一行共用的那些项 */
function objectItems(ctx: MenuContext, here: boolean): MenuEntry[] {
  const stack = here ? layerStack(ctx) : null;
  return [
    ...clipboardItems(ctx, here),
    'separator',
    cmd('edit.duplicate'),
    cmd('edit.delete'),
    cmd('node.rename'),
    'separator',
    ...(stack ? [stack] : []),
    selectItems(),
    'separator',
    ...arrangeItems(ctx),
    'separator',
    ...structureItems(ctx),
    'separator',
    ...componentItems(ctx),
    ...imageItems(ctx),
    ...slideItems(ctx),
    'separator',
    ...stateItems(ctx),
    'separator',
    { id: 'export', labelKey: 'menu.exportSelection', run: () => void exportImage(ctx.editor, 'png', 2) },
  ];
}

/** 一个打勾的视图选项 */
function toggle(key: ViewToggle): MenuItemDef {
  return cmd('view.toggle', key, { checked: (ctx) => ctx.editor.view[key] });
}

function showItems(): MenuItemDef {
  return sub('show', 'menu.show', () => [toggle('rulers'), toggle('guides'), toggle('pixelGrid'), toggle('sizeLabel')]);
}

function snapItems(): MenuItemDef {
  return sub('snap', 'menu.snap', () => [toggle('snapObjects'), toggle('snapGuides'), toggle('snapPixels')]);
}

// ───────────── 右键菜单 ─────────────

export function registerBuiltinMenus(): void {
  registerMenu('canvas.object', (ctx) => objectItems(ctx, true));

  registerMenu('canvas.text', (ctx) => {
    const target = () => ctx.editor.keyboardTarget as HTMLTextAreaElement | null;
    return [
      { id: 'text.cut', labelKey: 'menu.cut', shortcut: 'mod+x', run: () => textareaCommand(target(), 'cut') },
      { id: 'text.copy', labelKey: 'menu.copy', shortcut: 'mod+c', run: () => textareaCommand(target(), 'copy') },
      { id: 'text.paste', labelKey: 'menu.paste', shortcut: 'mod+v', run: () => void pasteIntoTextarea(target()) },
      { id: 'text.selectAll', labelKey: 'menu.selectAll', shortcut: 'mod+a', run: () => selectAllText(target()) },
      'separator',
      cmd('text.toggle', 'bold'),
      cmd('text.toggle', 'italic'),
      cmd('text.toggle', 'underline'),
      cmd('text.toggle', 'strikethrough'),
      'separator',
      cmd('text.fontStep', 1),
      cmd('text.fontStep', -1),
      'separator',
      {
        id: 'text.finish',
        labelKey: 'menu.finishEditing',
        shortcut: 'escape',
        run: () => ctx.editor.setTool('select'),
      },
    ];
  });

  registerMenu('canvas.artboard', (ctx) => {
    const target = ctx.info.target;
    const id = target.kind === 'artboard' ? target.id : (ctx.editor.activeArtboard?.id ?? '');
    const board = ctx.editor.store.get(id);
    const isSlide = board?.type === 'artboard' && board.deck !== null;
    return [
      cmd('edit.paste', undefined, { shortcut: 'mod+v' }),
      cmd('edit.pasteHere', ctx.info.world),
      'separator',
      { id: 'artboard.select', labelKey: 'menu.selectArtboard', run: () => ctx.editor.select([id]) },
      {
        id: 'artboard.rename',
        labelKey: 'menu.rename',
        run: () => {
          ctx.editor.select([id]);
          ctx.editor.commands.run('node.rename');
        },
      },
      'separator',
      cmd('artboard.duplicate', id, { labelKey: isSlide ? 'slide.duplicate' : 'menu.duplicateArtboard' }),
      cmd('artboard.delete', id, { labelKey: isSlide ? 'slide.delete' : 'menu.deleteArtboard' }),
      'separator',
      cmd('artboard.toggleSlide', id, { labelKey: isSlide ? 'menu.unmakeSlide' : 'menu.makeSlide' }),
      cmd('artboard.fitContent', id, { labelKey: 'menu.fitContent' }),
      cmd('guides.clear', id),
      'separator',
      cmd('edit.selectAll'),
      cmd('node.showAll'),
      cmd('node.unlockAll'),
      'separator',
      {
        id: 'artboard.export',
        labelKey: 'menu.exportArtboard',
        run: () => {
          ctx.editor.select([id]);
          void exportImage(ctx.editor, 'png', 2);
        },
      },
    ];
  });

  registerMenu('canvas.empty', (ctx) => [
    cmd('edit.paste', undefined, { shortcut: 'mod+v' }),
    cmd('edit.pasteHere', ctx.info.world),
    cmd('edit.selectAll'),
    'separator',
    cmd('artboard.add', undefined, { labelKey: 'menu.newArtboard' }),
    'separator',
    sub('zoom', 'menu.zoom', () => [
      cmd('view.zoomIn'),
      cmd('view.zoomOut'),
      cmd('view.zoomToFit'),
      cmd('view.zoom100'),
    ]),
    showItems(),
    snapItems(),
    cmd('guides.clearAll'),
    'separator',
    cmd('node.showAll'),
    cmd('node.unlockAll'),
  ]);

  registerMenu('canvas.guide', (ctx) => {
    const target = ctx.info.target;
    if (target.kind !== 'guide') return [];
    const guide = { container: target.container, id: target.id };
    return [
      { id: 'guide.position', labelKey: 'menu.setGuidePosition', run: () => ctx.editor.guideEditHandler?.(guide) },
      cmd('guides.remove', guide),
      'separator',
      toggle('guidesLocked'),
      cmd('guides.clearAll'),
    ];
  });

  registerMenu('canvas.ruler', () => [toggle('rulers'), toggle('guidesLocked'), cmd('guides.clearAll')]);

  registerMenu('slide.thumb', (ctx) => {
    const id = ctx.subject ?? '';
    const { editor } = ctx;
    // 点在多选里时对整个多选操作
    const targets = slidesForMenu(id);
    const focus = (): void => {
      editor.setActiveArtboard(id);
      editor.select([...targets]);
    };
    const skipped = targets.every((t) => (editor.store.get(t) as { deck?: { skip?: boolean } | null })?.deck?.skip);
    return [
      {
        id: 'slide.addAfter',
        labelKey: 'menu.newSlideAfter',
        run: () => {
          editor.setActiveArtboard(id);
          editor.commands.run('artboard.add');
        },
      },
      {
        id: 'slide.duplicate',
        labelKey: 'slide.duplicate',
        run: () => targets.forEach((t) => editor.commands.run('artboard.duplicate', t)),
      },
      {
        id: 'slide.delete',
        labelKey: 'slide.delete',
        run: () => targets.forEach((t) => editor.commands.run('artboard.delete', t)),
      },
      cmd('artboard.toggleSkip', targets, { labelKey: skipped ? 'menu.showSlide' : 'menu.hideSlide' }),
      'separator',
      {
        id: 'slide.copy',
        labelKey: 'menu.copy',
        run: () => {
          focus();
          editor.commands.run('edit.copy');
        },
      },
      {
        id: 'slide.cut',
        labelKey: 'menu.cut',
        run: () => {
          focus();
          editor.commands.run('edit.cut');
        },
      },
      {
        id: 'slide.paste',
        labelKey: 'menu.paste',
        run: () => {
          editor.setActiveArtboard(id);
          editor.select([]);
          editor.commands.run('edit.paste');
        },
      },
      'separator',
      sub('transition', 'transition.label', () =>
        TRANSITION_EFFECTS.map((effect) => ({
          id: `transition:${effect}`,
          labelKey: `transition.${effect}`,
          run: () =>
            editor.commands.run('slide.setTransition', {
              slideId: id,
              transition: { ...DEFAULT_TRANSITION, ...currentTransition(ctx, id), effect },
            }),
          checked: () => (currentTransition(ctx, id)?.effect ?? 'none') === effect,
        })),
      ),
      sub('slideMove', 'menu.slideMove', () => [
        cmd('artboard.move', { id, to: 'up' }, { labelKey: 'menu.moveUp' }),
        cmd('artboard.move', { id, to: 'down' }, { labelKey: 'menu.moveDown' }),
        cmd('artboard.move', { id, to: 'start' }, { labelKey: 'menu.moveToStart' }),
        cmd('artboard.move', { id, to: 'end' }, { labelKey: 'menu.moveToEnd' }),
      ]),
      'separator',
      {
        id: 'slide.play',
        labelKey: 'present.play',
        run: () => {
          editor.setActiveArtboard(id);
          editor.commands.run('present.play');
        },
      },
      {
        id: 'slide.export',
        labelKey: 'menu.exportArtboard',
        run: () => {
          focus();
          void exportImage(editor, 'png', 2);
        },
      },
    ];
  });

  registerMenu('slide.empty', () => [
    cmd('artboard.add', undefined, { labelKey: 'slide.add' }),
    cmd('edit.paste', undefined, { shortcut: 'mod+v' }),
  ]);

  registerMenu('layer.row', (ctx) => {
    const id = ctx.subject ?? '';
    return [
      {
        id: 'layer.reveal',
        labelKey: 'menu.revealOnCanvas',
        run: () => {
          ctx.editor.reveal(id);
          ctx.editor.commands.run('view.zoomToSelection');
        },
      },
      cmd('node.solo', id, { labelKey: 'menu.solo' }),
      'separator',
      ...objectItems(ctx, false),
    ];
  });

  registerMenu('asset.component', (ctx) => {
    const id = ctx.subject ?? '';
    return [
      cmd('component.place', { componentId: id }, { labelKey: 'component.place' }),
      {
        id: 'component.goTo',
        labelKey: 'component.goToMain',
        run: () => {
          ctx.editor.select([id]);
          ctx.editor.commands.run('component.goToMain');
        },
      },
      {
        id: 'component.instances',
        labelKey: 'menu.selectInstances',
        run: () => {
          ctx.editor.select([id]);
          ctx.editor.commands.run('select.same', 'instances');
        },
      },
    ];
  });

  registerMenu('asset.colorStyle', (ctx) => {
    const id = ctx.subject ?? '';
    return [
      cmd('style.color.apply', { id, target: 'fill' }, { labelKey: 'menu.applyToFill' }),
      cmd('style.color.apply', { id, target: 'stroke' }, { labelKey: 'menu.applyToStroke' }),
      'separator',
      cmd('select.byStyle', id, { labelKey: 'menu.selectUsers' }),
      'separator',
      cmd('style.color.remove', { id }, { labelKey: 'style.delete' }),
    ];
  });

  registerMenu('asset.textStyle', (ctx) => {
    const id = ctx.subject ?? '';
    return [
      cmd('style.text.apply', { id }, { labelKey: 'menu.applyStyle' }),
      cmd('style.text.redefine', { id }, { labelKey: 'style.redefine' }),
      'separator',
      cmd('select.byStyle', id, { labelKey: 'menu.selectUsers' }),
      'separator',
      cmd('style.text.remove', { id }, { labelKey: 'style.delete' }),
    ];
  });

  // ───────────── 顶部菜单栏 ─────────────

  registerMenu('bar.file', () => [
    { id: 'file.new', labelKey: 'file.new', run: () => openFileDialog('new') },
    { id: 'file.open', labelKey: 'file.open', shortcut: 'mod+o', run: (c) => void openDocument(c.editor) },
    { id: 'file.placeImage', labelKey: 'image.place', run: (c) => void pickAndPlaceImages(c.editor) },
    'separator',
    { id: 'file.save', labelKey: 'file.save', shortcut: 'mod+s', run: (c) => void saveDocument(c.editor) },
    { id: 'file.saveAs', labelKey: 'file.saveAs', shortcut: 'mod+shift+s', run: (c) => void saveDocumentAs(c.editor) },
    { id: 'file.saveAsTemplate', labelKey: 'file.saveAsTemplate', run: () => openFileDialog('template') },
    'separator',
    { id: 'file.exportPdf', labelKey: 'file.exportPdf', run: (c) => void exportPdf(c.editor) },
    { id: 'file.exportSvg', labelKey: 'file.exportSvg', run: () => openFileDialog('svg') },
    {
      id: 'file.exportPng',
      labelKey: 'file.exportPng',
      shortcut: 'mod+shift+e',
      run: (c) => void exportImage(c.editor, 'png', 1),
    },
    { id: 'file.exportPng2x', labelKey: 'file.exportPng2x', run: (c) => void exportImage(c.editor, 'png', 2) },
    { id: 'file.exportJpeg', labelKey: 'file.exportJpeg', run: (c) => void exportImage(c.editor, 'jpeg', 1) },
    { id: 'file.exportJpeg2x', labelKey: 'file.exportJpeg2x', run: (c) => void exportImage(c.editor, 'jpeg', 2) },
    { id: 'file.exportHtml', labelKey: 'file.exportHtml', run: (c) => void exportHtml(c.editor) },
    { id: 'file.exportVideo', labelKey: 'file.exportVideo', run: () => openFileDialog('video') },
  ]);

  registerMenu('bar.edit', (ctx) => [
    cmd('edit.undo'),
    cmd('edit.redo'),
    'separator',
    ...clipboardItems(ctx, false),
    'separator',
    cmd('edit.duplicate'),
    cmd('edit.delete'),
    cmd('node.rename'),
    'separator',
    cmd('edit.selectAll'),
    cmd('edit.deselect'),
    cmd('select.parent'),
    cmd('select.children'),
    cmd('select.next'),
    cmd('select.previous'),
    selectItems(),
  ]);

  registerMenu('bar.object', (ctx) => [
    ...arrangeItems(ctx),
    'separator',
    ...structureItems(ctx),
    'separator',
    cmd('component.create'),
    cmd('component.goToMain'),
    cmd('component.reset'),
    cmd('component.detach'),
    'separator',
    ...imageItems(ctx),
    ...slideItems(ctx),
    'separator',
    ...stateItems(ctx),
    cmd('node.unlockAll'),
    cmd('node.showAll'),
  ]);

  registerMenu('bar.text', () => [
    cmd('text.toggle', 'bold'),
    cmd('text.toggle', 'italic'),
    cmd('text.toggle', 'underline'),
    cmd('text.toggle', 'strikethrough'),
    'separator',
    cmd('text.fontStep', 1),
    cmd('text.fontStep', -1),
    'separator',
    cmd('text.paragraph', { patch: { align: 'left' } }),
    cmd('text.paragraph', { patch: { align: 'center' } }),
    cmd('text.paragraph', { patch: { align: 'right' } }),
    cmd('text.paragraph', { patch: { align: 'justify' } }),
    'separator',
    cmd('text.list', 'bullet'),
    cmd('text.list', 'number'),
    'separator',
    cmd('text.outline'),
  ]);

  registerMenu('bar.view', (ctx) => [
    cmd('view.setMode', 'canvas', { checked: () => ctx.editor.viewMode === 'canvas' }),
    cmd('view.setMode', 'slides', { checked: () => ctx.editor.viewMode === 'slides' }),
    'separator',
    cmd('view.zoomIn'),
    cmd('view.zoomOut'),
    cmd('view.zoomToFit'),
    cmd('view.zoom100'),
    cmd('view.zoomToSelection'),
    'separator',
    toggle('rulers'),
    toggle('guides'),
    toggle('guidesLocked'),
    toggle('pixelGrid'),
    toggle('sizeLabel'),
    snapItems(),
    cmd('guides.clearAll'),
    'separator',
    cmd('present.play'),
    cmd('present.playFromStart'),
  ]);

  registerMenu('dock.tab', (ctx) => {
    const tab = ctx.subject ?? '';
    const move = (target: DropTarget): void => setLayout((current) => moveTab(current, tab, target));
    const firstGroup = (zone: ZoneId): DropTarget => {
      const group = getLayout().zones[zone].groups[0];
      return group ? { kind: 'tabs', group: group.id, index: group.tabs.length } : { kind: 'split', zone, index: 0 };
    };
    const where = findTab(getLayout(), tab);
    return [
      { id: 'tab.close', labelKey: 'dock.close', run: () => setLayout((current) => closeTab(current, tab)) },
      {
        id: 'tab.float',
        labelKey: 'dock.float',
        enabled: () => where?.kind !== 'float',
        run: () => move({ kind: 'float', x: Math.max(16, window.innerWidth - 640), y: 100, w: 300, h: 460 }),
      },
      'separator',
      {
        id: 'tab.left',
        labelKey: 'dock.toLeft',
        enabled: () => !(where?.kind === 'zone' && where.zone === 'left'),
        run: () => move(firstGroup('left')),
      },
      {
        id: 'tab.right',
        labelKey: 'dock.toRight',
        enabled: () => !(where?.kind === 'zone' && where.zone === 'right'),
        run: () => move(firstGroup('right')),
      },
      {
        id: 'tab.bottom',
        labelKey: 'dock.toBottom',
        enabled: () => !(where?.kind === 'zone' && where.zone === 'bottom'),
        run: () => move(firstGroup('bottom')),
      },
      'separator',
      { id: 'tab.reset', labelKey: 'dock.reset', run: resetLayout },
    ];
  });

  registerMenu('bar.window', () => [
    ...listDockPanels().map((panel): MenuItemDef => ({
      id: `panel:${panel.id}`,
      labelKey: panel.titleKey,
      command: 'dock.toggle',
      args: panel.id,
      checked: () => isTabVisible(getLayout(), panel.id),
    })),
    'separator',
    sub('workspace', 'dock.workspace', () =>
      WORKSPACE_PRESETS.map((preset) => ({
        id: `workspace:${preset}`,
        labelKey: `dock.preset.${preset}`,
        run: () => setLayout(presetLayout(preset, { width: window.innerWidth, height: window.innerHeight })),
      })),
    ),
    { id: 'dock.reset', labelKey: 'dock.reset', run: resetLayout },
    cmd('dock.toggleHidden', undefined, { checked: () => getLayout().hidden }),
  ]);

  registerMenu('bar.help', () => [
    { id: 'help.commandPalette', labelKey: 'menu.commandPalette', command: 'help.commandPalette' },
    { id: 'help.shortcuts', labelKey: 'menu.shortcuts', command: 'help.shortcuts' },
  ]);
}

/** 顶部菜单栏的几栏，按顺序 */
export const MENU_BAR: readonly { id: string; labelKey: string }[] = [
  { id: 'bar.file', labelKey: 'menu.file' },
  { id: 'bar.edit', labelKey: 'menu.edit' },
  { id: 'bar.object', labelKey: 'menu.object' },
  { id: 'bar.text', labelKey: 'menu.text' },
  { id: 'bar.view', labelKey: 'menu.view' },
  { id: 'bar.window', labelKey: 'menu.window' },
  { id: 'bar.help', labelKey: 'menu.help' },
];

/** 右键点到的东西对应哪个菜单 */
export function contextMenuId(kind: 'text' | 'object' | 'artboard' | 'canvas' | 'guide' | 'ruler'): string {
  return {
    text: 'canvas.text',
    object: 'canvas.object',
    artboard: 'canvas.artboard',
    canvas: 'canvas.empty',
    guide: 'canvas.guide',
    ruler: 'canvas.ruler',
  }[kind];
}

function currentTransition(ctx: MenuContext, id: NodeId) {
  const board = ctx.editor.store.get(id);
  return board?.type === 'artboard' ? board.deck?.transition : undefined;
}

// ───────────── 编辑文字时的剪贴板 ─────────────

function textareaCommand(textarea: HTMLTextAreaElement | null, command: 'cut' | 'copy'): void {
  if (!textarea) return;
  textarea.focus({ preventScroll: true });
  // execCommand 已经不推荐，但在用户点击里对输入框的复制、剪切三个浏览器都还支持，而且不用权限
  document.execCommand(command);
}

async function pasteIntoTextarea(textarea: HTMLTextAreaElement | null): Promise<void> {
  if (!textarea) return;
  try {
    const text = await navigator.clipboard.readText();
    textarea.focus({ preventScroll: true });
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    toast(i18n.t('clipboard.readDenied'), 'error');
  }
}

function selectAllText(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.dispatchEvent(new Event('select', { bubbles: true }));
}
