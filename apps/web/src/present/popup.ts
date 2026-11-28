/** 演讲者视图窗口的名字：再打开时找回同一个窗口，不会开出一堆 */
const WINDOW_NAME = 'shiba-presenter-view';

/**
 * 打开（或者找回）放演讲者视图的窗口，把主窗口的样式表和主题搬过去，返回里面给 React 渲染的容器。
 * 界面用 React 的 portal 渲染进去，和主窗口共用同一份状态和语言包。浏览器拦了弹窗时返回 null。
 * 要在用户刚点过按钮时调用，否则会被当成广告弹窗拦掉
 */
export function openPresenterWindow(title: string): { win: Window; container: HTMLElement } | null {
  const win = window.open('', WINDOW_NAME, 'popup,width=1200,height=760');
  if (!win) return null;
  const doc = win.document;

  // 样式表：开发时是 <style>，构建之后是 <link>。新窗口的地址是 about:blank，链接改成绝对地址
  const styles = [...document.head.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]')].map((node) => {
    const copy = doc.importNode(node, true);
    if (node instanceof HTMLLinkElement) copy.setAttribute('href', node.href);
    return copy;
  });
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  // 标题和样式表一起放进新的 <head>（先设 document.title 再换 <head> 的话，标题会被换掉）
  const heading = doc.createElement('title');
  heading.textContent = title;
  doc.head.replaceChildren(charset, heading, ...styles);

  // 主题是写在 <html> 上的一组 CSS 变量（见 theme/index.ts），照搬过去
  const root = doc.documentElement;
  root.setAttribute('style', document.documentElement.getAttribute('style') ?? '');
  root.lang = document.documentElement.lang;
  if (document.documentElement.dataset.theme) root.dataset.theme = document.documentElement.dataset.theme;

  const container = doc.createElement('div');
  container.className = 'presenter-view-root';
  doc.body.className = 'presenter-view-body';
  doc.body.replaceChildren(container);
  return { win, container };
}
