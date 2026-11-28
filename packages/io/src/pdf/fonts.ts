import type { PdfTextFont } from './ir';

/**
 * 字体匹配：PDF 里用的字体我们通常没有，按字体名猜它属于哪一类、多粗，
 * 换成我们手里同一类的字体。宿主可以给每一类指定一组西文和中文字体；
 * 西文最好用和常见字体等宽的替代品（比如和 Arial 等宽的 Arimo），这样换过去之后每行的长度不变，折行也不变。
 */

export type FontCategory = 'sans' | 'serif' | 'mono';

export interface FontPair {
  latin: string;
  cjk: string;
}

export type FontChoices = Record<FontCategory, FontPair>;

/** 去掉子集前缀（"ABCDEF+"），转成小写，去掉分隔符 */
function normalize(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/, '')
    .toLowerCase()
    .replace(/[\s_\-,.]+/g, '');
}

// TeX 文档常用的 Computer Modern、Latin Modern 等字体名比较隐晦，单独列出来
const MONO = /mono|courier|consol|menlo|monaco|code|fixed|typewriter|^cmtt|^sftt|lmmono/;
/** 名字里明确说了是无衬线的 */
const SANS =
  /sans|gothic|hei|yahei|pingfang|arial|helvetica|verdana|tahoma|segoe|roboto|inter|grotesk|futura|avenir|gill|myriad|frutiger|univers|dengxian|calibri|lato|opensans|sfpro|^cmss|^sfss|lmsans|nimbussan|黑/;
const SERIF =
  /serif|times|roman|georgia|garamond|baskerville|cambria|palatino|minion|caslon|bodoni|didot|antiqua|century|song|ming|mincho|fangsong|kai|simsun|^cm[a-z]*\d|^sf[a-z]{2}\d|lmroman|nimbusrom|utopia|charter|stix|libertine|宋|楷|明朝|仿宋/;

export function fontCategory(font: PdfTextFont): FontCategory {
  const name = normalize(font.name);
  if (MONO.test(name)) return 'mono';
  if (SANS.test(name)) return 'sans';
  if (SERIF.test(name)) return 'serif';
  // 名字看不出来时，用解析库从字体描述里读到的标志
  if (font.monospace && !font.serif) return 'mono';
  if (font.serif) return 'serif';
  return 'sans';
}

/** 按字体名里的字重词猜粗细，100 到 900 */
export function fontWeight(font: PdfTextFont): number {
  const raw = font.name.replace(/^[A-Z]{6}\+/, '');
  // 日文字体常用 W3、W6 这样的写法
  const numbered = /(?:^|[-_ ,])W([1-9])(?:$|[-_ ,])/i.exec(raw);
  if (numbered) return Number(numbered[1]) * 100;
  const name = normalize(raw);
  if (/hairline|thin/.test(name)) return 100;
  if (/extralight|ultralight/.test(name)) return 200;
  if (/semilight|light/.test(name)) return 300;
  if (/extrabold|ultrabold/.test(name)) return 800;
  if (/black|heavy/.test(name)) return 900;
  if (/semibold|demibold|demi/.test(name)) return 600;
  if (/bold|粗/.test(name)) return 700;
  if (/medium/.test(name)) return 500;
  return font.bold ? 700 : 400;
}

/**
 * 是不是斜体：先看字体名（Times-Italic、Helvetica-Oblique、Arial-ItalicMT、MinionPro-It、
 * TeX 的 cmti 斜体和 cmsl 倾斜体），再看解析库读到的标志。解析库常常不给这个标志，所以名字更可靠
 */
export function fontItalic(font: PdfTextFont): boolean {
  const raw = font.name.replace(/^[A-Z]{6}\+/, '');
  if (/italic|oblique|斜/i.test(raw)) return true;
  if (/[-_ ,](?:bold|semibold|light|medium|black)?it$/i.test(raw)) return true;
  if (/^(?:cmti|cmsl|cmbxti|cmbxsl|sfti|sfsl|lmroman\d*-italic)/i.test(raw)) return true;
  return font.italic;
}
