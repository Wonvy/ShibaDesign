import type { NodeId, Point } from '@shiba/core';
import {
  FragmentError,
  copyFragment,
  fragmentFromHtml,
  fragmentToHtml,
  pasteFragment,
  pastePlainText,
  type ClipboardFragment,
  type Editor,
  type PasteMode,
} from '@shiba/editor';
import { isDocumentFile, isImageFile, openDroppedDocument, placeImageFiles } from './files';
import { i18n } from './i18n';
import { selectionCss } from './inspect';
import { toast } from './ui/toast';

/**
 * 系统剪贴板和编辑器之间的桥。
 *
 * ⌘C / ⌘X / ⌘V 走浏览器的 copy、cut、paste 事件：同步、不弹权限提示，所以这三个键不放进快捷键表
 * （快捷键表命中时会拦住按键，事件就不来了）。菜单里的"粘贴"没有这个事件，只能用异步剪贴板接口，
 * Chrome 第一次会问权限，读不到时退回到这个页面里最近一次复制的内容。
 */

/** 最近一次复制的内容。读不了系统剪贴板（没给权限、浏览器不支持）时用 */
let lastCopied: ClipboardFragment | null = null;

const t = (key: string, options: Record<string, unknown> = {}): string => i18n.t(key, options);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** 粘贴到别的软件里时看到的文字：文本的内容，别的对象用名字 */
function plainTextOf(editor: Editor, fragment: ClipboardFragment): string {
  const roots = new Set(fragment.roots);
  const texts = fragment.nodes.filter((n) => n.type === 'text').map((n) => (n.type === 'text' ? n.text : ''));
  if (texts.length > 0) return texts.join('\n');
  return fragment.nodes
    .filter((n) => roots.has(n.id))
    .map((n) => editor.labelOf(n))
    .join('\n');
}

function encode(editor: Editor): { fragment: ClipboardFragment; html: string; plain: string } | null {
  const fragment = copyFragment(editor);
  if (!fragment) return null;
  const plain = plainTextOf(editor, fragment);
  return { fragment, html: fragmentToHtml(fragment, plain), plain };
}

async function paste(editor: Editor, fragment: ClipboardFragment, mode: PasteMode): Promise<void> {
  const result = await pasteFragment(editor, fragment, mode);
  if (result.missingAssets > 0) toast(t('clipboard.assetsMissing', { count: result.missingAssets }), 'warning');
}

function reportInvalid(error: unknown): void {
  if (error instanceof FragmentError) toast(t('clipboard.invalid'), 'error');
  else throw error;
}

/** 处理一份剪贴板数据（paste 事件里的，或者异步接口读出来的）。认出来并处理了返回 true */
async function pasteData(
  editor: Editor,
  data: { html: string; text: string; files: File[] },
  mode: PasteMode,
): Promise<boolean> {
  if (data.html) {
    try {
      const fragment = fragmentFromHtml(data.html);
      if (fragment) {
        await paste(editor, fragment, mode);
        return true;
      }
    } catch (error) {
      reportInvalid(error);
      return true;
    }
  }
  const document = data.files.find(isDocumentFile);
  if (document) {
    await openDroppedDocument(editor, document);
    return true;
  }
  const images = data.files.filter(isImageFile);
  if (images.length > 0) {
    await placeImageFiles(editor, images, mode.kind === 'at' ? mode.point : undefined);
    return true;
  }
  if (data.text.trim()) {
    pastePlainText(editor, data.text);
    return true;
  }
  return false;
}

/** 用异步剪贴板接口读出来再粘贴（菜单里的粘贴、原位粘贴）。读不了时用这个页面里最近复制的内容 */
async function pasteFromSystem(editor: Editor, mode: PasteMode): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    let html = '';
    let text = '';
    const files: File[] = [];
    for (const item of items) {
      if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
      if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      for (const type of item.types) {
        if (type.startsWith('image/')) files.push(new File([await item.getType(type)], 'image', { type }));
      }
    }
    if (await pasteData(editor, { html, text, files }, mode)) return;
  } catch {
    // 没给权限或者浏览器不支持：往下用页面里记着的
  }
  if (lastCopied) {
    await paste(editor, lastCopied, mode);
    return;
  }
  toast(t('clipboard.readDenied'), 'error');
}

/** 用异步剪贴板接口写（菜单里的复制、剪切） */
async function copyToSystem(editor: Editor): Promise<boolean> {
  const encoded = encode(editor);
  if (!encoded) return false;
  lastCopied = encoded.fragment;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([encoded.html], { type: 'text/html' }),
        'text/plain': new Blob([encoded.plain], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    // 写不了系统剪贴板时，这个页面里照样能粘贴
  }
  return true;
}

/** 选中的对象画成 PNG：一个对象直接用渲染器导出，几个对象先导出成 SVG（文字转轮廓）再画到画布上 */
async function selectionPng(editor: Editor, ids: readonly NodeId[]): Promise<Blob> {
  if (ids.length === 1) {
    const bytes = await editor.exportPng(ids[0]!, 2);
    if (!bytes) throw new Error('export failed');
    return new Blob([bytes.slice().buffer], { type: 'image/png' });
  }
  const svg = await editor.exportSvgNodes(ids, { text: 'outline' });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * 2));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * 2));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 注册剪贴板相关的命令，开始监听 copy / cut / paste 事件。返回取消监听的函数（命令留着）。
 * 命令放在界面层是因为要用浏览器的剪贴板接口；菜单、命令面板照样按 id 引用它们
 */
export function installClipboard(editor: Editor): () => void {
  const hasSelection = (e: Editor): boolean => e.selection.length > 0;
  editor.commands
    .register({ id: 'edit.copy', enabled: hasSelection, run: (e) => void copyToSystem(e) })
    .register({
      id: 'edit.cut',
      enabled: hasSelection,
      run: (e) =>
        void copyToSystem(e).then((ok) => {
          if (ok) e.commands.run('edit.delete');
        }),
    })
    .register({ id: 'edit.paste', run: (e) => void pasteFromSystem(e, { kind: 'auto' }) })
    .register({ id: 'edit.pasteInPlace', run: (e) => void pasteFromSystem(e, { kind: 'inPlace' }) })
    .register<Point>({ id: 'edit.pasteHere', run: (e, point) => void pasteFromSystem(e, { kind: 'at', point }) })
    .register({
      id: 'edit.copyAsPng',
      enabled: hasSelection,
      run(e) {
        const ids = [...e.selection];
        // ClipboardItem 收一个 Promise：Safari 要求写剪贴板的调用发生在这次点击里，内容可以晚一点到
        navigator.clipboard
          .write([new ClipboardItem({ 'image/png': selectionPng(e, ids) })])
          .then(() => toast(t('clipboard.copiedPng')))
          .catch(() => toast(t('clipboard.writeFailed'), 'error'));
      },
    })
    .register({
      id: 'edit.copyAsCss',
      enabled: hasSelection,
      run(e) {
        navigator.clipboard
          .writeText(selectionCss(e))
          .then(() => toast(t('clipboard.copiedCss')))
          .catch(() => toast(t('clipboard.writeFailed'), 'error'));
      },
    })
    .register({
      id: 'edit.copyAsSvg',
      enabled: hasSelection,
      run(e) {
        e.exportSvgNodes([...e.selection], { text: 'text' })
          .then((svg) => navigator.clipboard.writeText(svg))
          .then(() => toast(t('clipboard.copiedSvg')))
          .catch(() => toast(t('clipboard.writeFailed'), 'error'));
      },
    });

  /** ⇧⌘V 原位粘贴：浏览器多半照样发 paste 事件，事件里按原位处理；没发的话自己去读剪贴板 */
  let inPlaceUntil = 0;
  let inPlaceTimer: ReturnType<typeof setTimeout> | null = null;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isEditable(event.target) || editor.keyboardTarget) return;
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === 'KeyV') {
      inPlaceUntil = performance.now() + 300;
      if (inPlaceTimer) clearTimeout(inPlaceTimer);
      inPlaceTimer = setTimeout(() => {
        inPlaceTimer = null;
        if (inPlaceUntil === 0) return;
        inPlaceUntil = 0;
        void pasteFromSystem(editor, { kind: 'inPlace' });
      }, 120);
    }
  };

  const onCopy = (event: ClipboardEvent): void => {
    // 输入框里（包括正在编辑的文字）交给浏览器自己处理
    if (isEditable(event.target) || editor.keyboardTarget || !event.clipboardData) return;
    const encoded = encode(editor);
    if (!encoded) return;
    event.preventDefault();
    lastCopied = encoded.fragment;
    event.clipboardData.setData('text/html', encoded.html);
    event.clipboardData.setData('text/plain', encoded.plain);
  };

  const onCut = (event: ClipboardEvent): void => {
    if (isEditable(event.target) || editor.keyboardTarget || !event.clipboardData) return;
    onCopy(event);
    if (event.defaultPrevented) editor.commands.run('edit.delete');
  };

  const onPaste = (event: ClipboardEvent): void => {
    if (isEditable(event.target) || editor.keyboardTarget || !event.clipboardData) return;
    const inPlace = performance.now() < inPlaceUntil;
    inPlaceUntil = 0;
    const data = {
      html: event.clipboardData.getData('text/html'),
      text: event.clipboardData.getData('text/plain'),
      files: [...event.clipboardData.files],
    };
    event.preventDefault();
    void pasteData(editor, data, { kind: inPlace ? 'inPlace' : 'auto' }).then((handled) => {
      // 剪贴板里是空的（或者只有这个页面认不出的东西）：用页面里记着的
      if (!handled && lastCopied) void paste(editor, lastCopied, { kind: inPlace ? 'inPlace' : 'auto' });
    });
  };

  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
    if (inPlaceTimer) clearTimeout(inPlaceTimer);
  };
}
