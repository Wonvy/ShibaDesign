import {
  applyToPoint,
  createNode,
  hasLiveAppearance,
  invert,
  multiply,
  nextSeq,
  textAppearanceBasis,
  rectFromPoints,
  rgba,
  solid,
  translation,
  worldTransform,
  type Color,
  type NodeId,
  type Point,
  type Matrix,
  type Rect,
  type TextAppearance,
  type TextNode,
} from '@shiba/core';
import type { Command } from '../commands/command';
import type { Editor } from '../editor';
import { localOrigin } from '../ops';
import type { PointerInfo } from '../types';
import type { Tool } from './tool';

/**
 * 文本工具与文本编辑。
 *
 * 文字画在画布上，但键盘输入交给一个看不见的 <textarea>：
 * 它负责输入法、组合键、剪贴板、左右移动光标这些浏览器已经做得很好的事，
 * 我们只把它的内容和选区同步到文档，再自己在画布上画光标和选区。
 * 输入法的候选窗跟着这个输入框走，所以每次都把它挪到光标所在的位置。
 *
 * 浏览器自带的"上下行移动"按输入框自己的折行来算，和画布上的排版对不上，
 * 所以上下方向键由我们接管，用真实的排版结果计算。
 *
 * 从 PDF 导入的文字平时按原文件的字形显示（保真外观）。开始编辑时先换成正常排版（"解冻"），
 * 并把文本框挪一下，让新排版的第一行基线正好落在原来的位置上；
 * 如果什么都没改就退出编辑，再换回原样，撤销历史里也不留痕迹。
 */

const DEFAULT_TEXT_COLOR: Color = rgba(0.1, 0.1, 0.1);
const DRAG_THRESHOLD = 3;
const MIN_BOX_WIDTH = 20;
const BLINK_INTERVAL = 530;
const TYPING_PAUSE = 1000;
/** 解冻前最多等字体加载这么久；超时就先用已有的字体排版 */
const FONT_WAIT = 3000;

/** 解冻前的样子，退出编辑时如果什么都没改，就按它换回去 */
interface Thawed {
  appearance: TextAppearance;
  transform: Matrix;
}

interface Session {
  nodeId: NodeId;
  textarea: HTMLTextAreaElement;
  abort: AbortController;
  /** 输入法正在组字时，组字开始的字符位置 */
  composing: { start: number } | null;
  /** 连续上下移动时要保持的横坐标 */
  desiredX: number | null;
  /** 鼠标拖选时的起点 */
  dragAnchor: number | null;
  /** 当前这一段连续输入共用的撤销合并键 */
  mergeKey: string;
  /** 上次封存撤销历史之后有没有输入过 */
  typed: boolean;
  /** 这次编辑中改过文字 */
  changed: boolean;
  /** 这段文字是开始编辑时从保真外观解冻的 */
  thawed: Thawed | null;
  idleTimer: number;
  blinkTimer: number;
  blinkOn: boolean;
}

interface Pending {
  start: Point;
  current: Point;
  x: number;
  y: number;
  dragging: boolean;
}

interface Selection {
  anchor: number;
  focus: number;
}

function readSelection(textarea: HTMLTextAreaElement): Selection {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  return textarea.selectionDirection === 'backward' ? { anchor: end, focus: start } : { anchor: start, focus: end };
}

function writeSelection(textarea: HTMLTextAreaElement, anchor: number, focus: number): void {
  textarea.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? 'backward' : 'forward');
}

/** 注册文本工具，以及让别的工具进入文本编辑的 text.edit 命令 */
export function registerTextTool(editor: Editor): void {
  let session: Session | null = null;
  let pending: Pending | null = null;
  /** 正在进行的"解冻后开始编辑"的编号。换了工具或者又点了别的文字，之前那次就作废 */
  let opening = 0;

  const nodeOf = (): TextNode | null => {
    const node = session ? editor.store.get(session.nodeId) : undefined;
    return node?.type === 'text' ? node : null;
  };

  const toLocal = (node: TextNode, world: Point): Point => {
    const inverse = invert(worldTransform(editor.store, node.id));
    if (!inverse) return world;
    const [x, y] = applyToPoint(inverse, world.x, world.y);
    return { x, y };
  };

  const offsetAt = (node: TextNode, world: Point): number => {
    const local = toLocal(node, world);
    return editor.textLayouts.offsetAt(node, local.x, local.y);
  };

  const resetBlink = (): void => {
    if (!session) return;
    session.blinkOn = true;
    clearInterval(session.blinkTimer);
    session.blinkTimer = window.setInterval(() => {
      if (!session) return;
      session.blinkOn = !session.blinkOn;
      editor.requestRender();
    }, BLINK_INTERVAL);
  };

  /** 结束当前这段连续输入：之后的输入算新的一步撤销。没输入过就不用封存 */
  const sealTyping = (): void => {
    if (!session || session.composing || !session.typed) return;
    session.typed = false;
    clearTimeout(session.idleTimer);
    editor.store.sealHistory();
    session.mergeKey = editor.newMergeKey('type');
  };

  const refresh = (): void => {
    resetBlink();
    editor.requestRender();
  };

  /** 把输入框里的内容同步到文档 */
  const syncText = (): void => {
    const node = nodeOf();
    if (!session || !node) return;
    const text = session.textarea.value.replace(/\r\n?/g, '\n');
    if (text !== node.text) {
      editor.store.transact('type', (tx) => tx.update(node.id, { text }), { mergeKey: session.mergeKey });
      session.typed = true;
      session.changed = true;
    }
    session.desiredX = null;
    clearTimeout(session.idleTimer);
    session.idleTimer = window.setTimeout(sealTyping, TYPING_PAUSE);
    refresh();
  };

  /** 撤销或重做之后，让输入框跟上文档 */
  const syncFromDocument = (): void => {
    const node = nodeOf();
    if (!session) return;
    // 节点没了，或者撤销到了开始编辑之前（文字又按原样显示了）：退出编辑
    if (!node || hasLiveAppearance(node)) {
      end();
      editor.setTool('select');
      return;
    }
    const caret = Math.min(readSelection(session.textarea).focus, node.text.length);
    session.textarea.value = node.text;
    writeSelection(session.textarea, caret, caret);
    session.mergeKey = editor.newMergeKey('type');
    refresh();
  };

  const moveVertically = (direction: -1 | 1, extend: boolean): void => {
    const node = nodeOf();
    if (!session || !node) return;
    const { anchor, focus } = readSelection(session.textarea);
    const x = session.desiredX ?? editor.textLayouts.caretRect(node, focus).x;
    const next = editor.textLayouts.verticalMove(node, focus, direction, x);
    writeSelection(session.textarea, extend ? anchor : next, next);
    session.desiredX = x;
    sealTyping();
    refresh();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // 输入法组字期间的按键全部留给输入法
    if (!session || event.isComposing || event.keyCode === 229) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (event.key === 'Escape' || (mod && event.key === 'Enter')) {
      event.preventDefault();
      end();
      editor.setTool('select');
      return;
    }
    if (mod && (key === 'z' || key === 'y')) {
      // 输入框自带的撤销和文档的撤销是两套历史，只保留文档的
      event.preventDefault();
      clearTimeout(session.idleTimer);
      if (key === 'y' || event.shiftKey) editor.store.redo();
      else editor.store.undo();
      syncFromDocument();
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !mod && !event.altKey) {
      event.preventDefault();
      moveVertically(event.key === 'ArrowUp' ? -1 : 1, event.shiftKey);
      return;
    }
    if (event.key === 'Tab') event.preventDefault();
  };

  const begin = (nodeId: NodeId, caret: number | null, mergeKey?: string, thawed: Thawed | null = null): void => {
    end();
    const container = editor.container;
    const node = editor.store.get(nodeId);
    if (!container || node?.type !== 'text') return;

    const textarea = document.createElement('textarea');
    textarea.value = node.text;
    textarea.spellcheck = false;
    textarea.tabIndex = -1;
    textarea.wrap = 'off';
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('aria-label', editor.labelOf(node));
    // 必须是真正可聚焦、参与布局的元素，输入法才会工作；所以用透明而不是隐藏
    textarea.style.cssText =
      'position:absolute;left:0;top:0;width:2px;height:1em;margin:0;padding:0;border:0;outline:none;' +
      'resize:none;overflow:hidden;opacity:0;pointer-events:none;white-space:pre;' +
      'background:transparent;color:transparent;caret-color:transparent;z-index:1;';
    container.appendChild(textarea);

    const abort = new AbortController();
    const options = { signal: abort.signal };
    session = {
      nodeId,
      textarea,
      abort,
      composing: null,
      desiredX: null,
      dragAnchor: null,
      mergeKey: mergeKey ?? editor.newMergeKey('type'),
      typed: false,
      changed: false,
      thawed,
      idleTimer: 0,
      blinkTimer: 0,
      blinkOn: true,
    };

    textarea.addEventListener('input', syncText, options);
    textarea.addEventListener('keydown', onKeyDown, options);
    textarea.addEventListener('keyup', refresh, options);
    textarea.addEventListener('select', refresh, options);
    textarea.addEventListener('focus', refresh, options);
    textarea.addEventListener('blur', () => editor.requestRender(), options);
    textarea.addEventListener(
      'compositionstart',
      () => {
        if (session) session.composing = { start: textarea.selectionStart };
      },
      options,
    );
    textarea.addEventListener(
      'compositionend',
      () => {
        if (!session) return;
        session.composing = null;
        // 各浏览器里 compositionend 和最后一次 input 的先后顺序不一致，这里再同步一次保证不丢字
        syncText();
      },
      options,
    );
    document.addEventListener(
      'selectionchange',
      () => {
        if (document.activeElement === textarea) refresh();
      },
      options,
    );

    editor.keyboardTarget = textarea;
    editor.select([nodeId]);
    textarea.focus({ preventScroll: true });
    const position = Math.min(caret ?? node.text.length, node.text.length);
    writeSelection(textarea, position, position);
    resetBlink();
    editor.requestRender();
  };

  function end(): void {
    const finished = session;
    if (!finished) return;
    session = null;
    finished.abort.abort();
    clearTimeout(finished.idleTimer);
    clearInterval(finished.blinkTimer);
    finished.textarea.remove();
    if (editor.keyboardTarget === finished.textarea) editor.keyboardTarget = null;

    // 什么都没写的文本框不留在文档里。用同一个合并键，
    // 这样"新建后直接离开"会和创建那一步互相抵消，不在撤销历史里留下痕迹
    const node = editor.store.get(finished.nodeId);
    if (node?.type === 'text' && node.text.length === 0) {
      editor.store.transact('remove empty text', (tx) => tx.remove(node.id), { mergeKey: finished.mergeKey });
    } else if (
      node?.type === 'text' &&
      finished.thawed &&
      !finished.changed &&
      !node.appearance &&
      textAppearanceBasis(node) === finished.thawed.appearance.basis
    ) {
      // 解冻了但什么都没改：换回原样。用同一个合并键，和解冻那一步互相抵消
      const { appearance, transform } = finished.thawed;
      editor.store.transact('restore text', (tx) => tx.update(node.id, { appearance, transform }), {
        mergeKey: finished.mergeKey,
      });
    }
    editor.store.sealHistory();
    editor.requestRender();
  }

  /**
   * 把按保真外观显示的文字换成正常排版，返回换之前的样子。
   * 先等需要的字体加载完，这样量出来的基线才准；然后把文本框沿自己的竖直方向挪一下，
   * 让新排版的第一行基线和原文件里的重合，文字看起来只是换了字体，不会上下跳。
   */
  const thaw = async (id: NodeId, mergeKey: string): Promise<Thawed | null> => {
    const before = editor.store.get(id);
    if (before?.type !== 'text' || !hasLiveAppearance(before)) return null;
    const { style } = before;
    let timer = 0;
    await Promise.race([
      editor.fonts.ensure([style.fontFamily.latin, style.fontFamily.cjk], before.text, style.fontWeight),
      new Promise((resolve) => (timer = window.setTimeout(resolve, FONT_WAIT))),
    ]).catch(() => {});
    clearTimeout(timer);

    const node = editor.store.get(id);
    if (node?.type !== 'text' || !hasLiveAppearance(node) || !node.appearance) return null;
    const appearance = node.appearance;
    const baseline = editor.textLayouts.get(node).lines[0]?.baseline ?? appearance.baseline;
    const transform = multiply(node.transform, translation(0, appearance.baseline - baseline));
    editor.store.sealHistory();
    editor.store.transact('edit text', (tx) => tx.update(id, { appearance: undefined, transform }), { mergeKey });
    return { appearance, transform: node.transform };
  };

  /** 开始编辑一段已有的文字。world 是点击位置，光标放到离它最近的字符上；没有就放到末尾 */
  const open = (id: NodeId, world: Point | null, onReady?: (caret: number) => void): void => {
    const token = ++opening;
    const start = (mergeKey?: string, thawed: Thawed | null = null): void => {
      const node = editor.store.get(id);
      if (token !== opening || node?.type !== 'text') return;
      const caret = world ? offsetAt(node, world) : node.text.length;
      begin(id, caret, mergeKey, thawed);
      onReady?.(caret);
    };
    const node = editor.store.get(id);
    if (node?.type === 'text' && hasLiveAppearance(node)) {
      const mergeKey = editor.newMergeKey('type');
      void thaw(id, mergeKey).then((thawed) => start(mergeKey, thawed));
    } else {
      start();
    }
  };

  /** 新建一个空文本并进入编辑。box 为 null 时是点一下创建的自动宽度文本 */
  const create = (at: Point, box: Rect | null): void => {
    const { store } = editor;
    const style = editor.defaultTextStyle;
    const container = editor.containerAt(at);
    // 点一下创建时，让点击位置落在第一行的中线上，而不是文本框的左上角
    const rect: Rect = box ?? { x: at.x, y: at.y - (style.fontSize * style.lineHeight) / 2, w: 0, h: 0 };
    const origin = localOrigin(store, container.id, rect);
    const node = createNode('text', {
      parent: container.id,
      index: store.indexOnTop(container.id),
      seq: nextSeq(store, 'text'),
      transform: translation(origin.x, origin.y),
      size: [box ? Math.max(box.w, MIN_BOX_WIDTH) : 0, 0],
      text: '',
      style,
      align: 'left',
      sizing: box ? 'fixed' : 'auto',
      fill: solid(DEFAULT_TEXT_COLOR),
    });
    const mergeKey = editor.newMergeKey('type');
    store.sealHistory();
    store.transact('create text', (tx) => tx.create(node), { mergeKey });
    begin(node.id, 0, mergeKey);
  };

  /** 把节点本地坐标里的矩形画到屏幕上（节点可能被旋转，所以按四个角画） */
  const tracePath = (ctx: CanvasRenderingContext2D, node: TextNode, rect: Rect): void => {
    const world = worldTransform(editor.store, node.id);
    const corner = (x: number, y: number): Point => {
      const [wx, wy] = applyToPoint(world, x, y);
      return editor.worldToScreen(wx, wy);
    };
    const a = corner(rect.x, rect.y);
    const b = corner(rect.x + rect.w, rect.y);
    const c = corner(rect.x + rect.w, rect.y + rect.h);
    const d = corner(rect.x, rect.y + rect.h);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
  };

  /** 把输入框挪到光标所在的屏幕位置，输入法的候选窗才会出现在正确的地方 */
  const placeTextarea = (node: TextNode, caret: Rect): void => {
    if (!session) return;
    const [wx, wy] = applyToPoint(worldTransform(editor.store, node.id), caret.x, caret.y);
    const screen = editor.worldToScreen(wx, wy);
    const zoom = editor.camera.zoom;
    const { style } = session.textarea;
    style.transform = `translate(${Math.round(screen.x)}px, ${Math.round(screen.y)}px)`;
    style.height = `${Math.max(1, caret.h * zoom)}px`;
    style.fontSize = `${Math.max(1, node.style.fontSize * zoom)}px`;
    style.lineHeight = `${Math.max(1, caret.h * zoom)}px`;
  };

  const tool: Tool = {
    id: 'text',
    cursor: 'text',

    onDeactivate() {
      pending = null;
      opening++;
      end();
    },

    onPointerDown(e: PointerInfo) {
      const node = nodeOf();
      if (session && node) {
        const local = toLocal(node, e.world);
        const layout = editor.textLayouts.get(node);
        const pad = 6 / editor.camera.zoom;
        const inside =
          local.x >= -pad && local.x <= layout.width + pad && local.y >= -pad && local.y <= layout.height + pad;
        if (!inside) {
          // 点在文本外面：结束编辑。这一下点击不再做别的事
          end();
          editor.setTool('select');
          return;
        }
        const offset = editor.textLayouts.offsetAt(node, local.x, local.y);
        const anchor = e.shift ? readSelection(session.textarea).anchor : offset;
        writeSelection(session.textarea, anchor, offset);
        session.dragAnchor = anchor;
        session.desiredX = null;
        sealTyping();
        refresh();
        return;
      }

      const hit = editor.pick(e.world).node;
      if (hit?.type === 'text') {
        open(hit.id, e.world, (caret) => {
          if (session) session.dragAnchor = caret;
        });
        return;
      }
      pending = { start: e.world, current: e.world, x: e.x, y: e.y, dragging: false };
    },

    onPointerMove(e: PointerInfo) {
      const node = nodeOf();
      if (session && node && session.dragAnchor !== null && e.down) {
        writeSelection(session.textarea, session.dragAnchor, offsetAt(node, e.world));
        refresh();
        return;
      }
      if (pending && e.down) {
        pending.current = e.world;
        if (Math.hypot(e.x - pending.x, e.y - pending.y) >= DRAG_THRESHOLD) pending.dragging = true;
        editor.requestRender();
      }
    },

    onPointerUp() {
      if (session) {
        session.dragAnchor = null;
        session.textarea.focus({ preventScroll: true });
        return;
      }
      const drag = pending;
      pending = null;
      if (!drag) return;
      const box = drag.dragging ? rectFromPoints(drag.start.x, drag.start.y, drag.current.x, drag.current.y) : null;
      create(drag.start, box);
    },

    onDoubleClick(e: PointerInfo) {
      const node = nodeOf();
      if (!session || !node) return;
      const word = editor.textLayouts.wordAt(node, offsetAt(node, e.world));
      writeSelection(session.textarea, word.start, word.end);
      refresh();
    },

    drawOverlay(ctx) {
      if (pending?.dragging) {
        const a = editor.worldToScreen(pending.start.x, pending.start.y);
        const b = editor.worldToScreen(pending.current.x, pending.current.y);
        const rect = rectFromPoints(a.x, a.y, b.x, b.y);
        ctx.save();
        ctx.strokeStyle = editor.theme.accent;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.round(rect.w), Math.round(rect.h));
        ctx.restore();
      }

      const current = session;
      if (!current) return;
      const node = nodeOf();
      const stillSelected = editor.selection.length === 1 && editor.selection[0] === current.nodeId;
      if (!node || !stillSelected) {
        // 节点被删掉了，或者用户在别处改了选择：退出编辑。不能在绘制过程中改状态，所以排到下一拍
        queueMicrotask(() => {
          if (session === current) end();
        });
        return;
      }

      const layouts = editor.textLayouts;
      const { anchor, focus } = readSelection(current.textarea);
      ctx.save();
      ctx.strokeStyle = editor.theme.accent;
      ctx.fillStyle = editor.theme.accent;

      ctx.globalAlpha = 0.28;
      for (const rect of layouts.selectionRects(node, anchor, focus)) {
        tracePath(ctx, node, rect);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (current.composing) {
        // 输入法组字中的文字加下划线，和系统输入框的习惯一致
        ctx.lineWidth = 1.5;
        for (const rect of layouts.selectionRects(node, current.composing.start, focus)) {
          tracePath(ctx, node, { x: rect.x, y: rect.y + rect.h - 2 / editor.camera.zoom, w: rect.w, h: 0 });
          ctx.stroke();
        }
      }

      const caret = layouts.caretRect(node, focus);
      if (anchor === focus && current.blinkOn && document.activeElement === current.textarea) {
        ctx.lineWidth = 1.5;
        tracePath(ctx, node, caret);
        ctx.stroke();
      }
      ctx.restore();
      placeTextarea(node, caret);
    },
  };

  const editText: Command<{ id: NodeId; world?: Point }> = {
    id: 'text.edit',
    enabled: (_editor, args) => editor.store.get(args.id)?.type === 'text',
    run(_editor, args) {
      const node = editor.store.get(args.id);
      if (node?.type !== 'text') return;
      editor.setTool('text');
      open(node.id, args.world ?? null);
    },
  };

  editor.tools.register(tool);
  editor.commands.register(editText);
}
