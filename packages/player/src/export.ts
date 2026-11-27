import { runPlayer } from './player';
import type { PresentationData } from './types';

/**
 * 把一份演示稿导出成一个可以独立播放的 HTML 文件。
 *
 * 文件里有三样东西：一个空的舞台元素、演示数据（图片以 data: 地址内嵌）、播放器函数的源码。
 * 不引用任何外部资源，断网也能播，发给别人双击就能打开。
 *
 * 播放器的源码是直接从正在运行的那个函数上取下来的（Function.prototype.toString），
 * 所以网页里跑的和编辑器里预览的是同一份代码，不存在"预览和导出不一致"。
 */
export function buildPresentationHtml(data: PresentationData): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#stage{position:fixed;inset:0}</style>
</head>
<body>
<div id="stage"></div>
<script>
(${runPlayer.toString()})(document.getElementById("stage"), ${serialize(data)}, {});
</script>
</body>
</html>
`;
}

/**
 * 把数据写成可以安全放进 <script> 标签里的 JSON。
 * 数据里如果出现 "</script>" 会提前结束脚本，所以把所有 "<" 换成转义写法；
 * 行分隔符和段分隔符这两个字符在旧浏览器里会被当成换行，同样转义掉。
 */
function serialize(data: unknown): string {
  const escapes: [string, string][] = [
    ['<', '\\u003c'],
    [String.fromCharCode(0x2028), '\\u2028'],
    [String.fromCharCode(0x2029), '\\u2029'],
  ];
  let json = JSON.stringify(data);
  for (const [character, escaped] of escapes) json = json.split(character).join(escaped);
  return json;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
