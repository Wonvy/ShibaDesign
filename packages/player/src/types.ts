/**
 * 播放器吃的数据。这是一份"编译好"的演示稿：
 * 每个对象已经写成一段 SVG（或者渲染成一张图片），每条动画已经算成浏览器能直接执行的关键帧和时刻。
 * 播放器本身不认识文档模型，也不依赖编辑器的任何代码。
 */

/** 一帧关键帧：CSS 属性名 → 值 */
export type PlayerKeyframe = Record<string, string | number>;

export interface PlayerLayer {
  id: string;
  /** 跨页配对用的标识。两页上标识相同的图层，在"平滑"切换时会被当成同一个对象补间 */
  key: string;
  /**
   * 图层的内容：一段 SVG（矢量，文字可以选中和搜索），或者一张图片的地址（data: 或 blob:）。两者有一个就行，
   * 都有时用 SVG。SVG 的 viewBox 对应图层的盒子，宽高写成 100%。
   * SVG 里元素的 id 以字符 U+0001 开头，播放器每次放进网页时把它换成唯一的前缀，免得几份同样的图层 id 冲突
   */
  svg?: string;
  src?: string;
  /** 图层盒子的大小，幻灯片坐标 */
  width: number;
  height: number;
  /** 把图层盒子放到幻灯片上的仿射变换 [a, b, c, d, e, f]，以盒子左上角为原点 */
  matrix: [number, number, number, number, number, number];
  /** CSS mix-blend-mode 的取值 */
  blend: string;
  /** 进入这一页时先不显示，等它的进入动画开始 */
  hidden: boolean;
}

export interface PlayerAnimation {
  /** 作用的图层 id */
  layer: string;
  /** 相对这一步开始的时刻，毫秒 */
  start: number;
  duration: number;
  easing: string;
  /** 作用在图层自身上的关键帧：缩放、旋转、透明度、裁剪 */
  fx?: PlayerKeyframe[];
  /** 让图层在幻灯片上整体平移的关键帧 */
  move?: PlayerKeyframe[];
  /** 开始时显示图层 */
  show: boolean;
  /** 结束时隐藏图层 */
  hide: boolean;
}

export interface PlayerTransition {
  effect: 'none' | 'fade' | 'push' | 'zoom' | 'smooth';
  duration: number;
  direction?: 'left' | 'right' | 'top' | 'bottom';
}

/** 原型的热区：点它跳到另一页 */
export interface PlayerLink {
  /** 热区在幻灯片坐标里的外框 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 跳到第几页（从 0 数）；-1 表示回到上一个看过的页 */
  target: number;
  /** 过渡效果；省略时用目标页自己的切换效果 */
  transition?: PlayerTransition;
}

export interface PlayerSlide {
  width: number;
  height: number;
  /** CSS 颜色 */
  background: string;
  /** 从下到上 */
  layers: PlayerLayer[];
  /** 原型的热区，从下到上。省略表示没有 */
  links?: PlayerLink[];
  /** 第 0 步进入页面后自动播放，之后每前进一次播放一步 */
  steps: PlayerAnimation[][];
  /** 进入这一页时的切换效果 */
  transition: PlayerTransition;
}

export interface PresentationData {
  title: string;
  slides: PlayerSlide[];
  /** SVG 图层里的文字用到的字体（@font-face 规则），所有图层共用一份 */
  fonts?: string;
}

export interface PlayerOptions {
  /** 从第几页开始，从 0 数 */
  startSlide?: number;
  /**
   * 时间不自己走，由 PlayerHandle.advance 推进（导出视频时逐帧取画面用）。
   * 这时动画按虚拟的时钟播放，播放器也不会抢焦点
   */
  manual?: boolean;
  /** 用户按了 Esc */
  onExit?: () => void;
  /** 页码或步骤变化时 */
  onChange?: (state: PlayerState) => void;
}

export interface PlayerState {
  slide: number;
  slides: number;
  /** 当前页已经播到第几步 */
  step: number;
  /** 当前页一共有几步（含自动播放的第 0 步） */
  steps: number;
  /** 是否有动画或切换正在进行 */
  busy: boolean;
}

export interface PlayerHandle {
  /** 前进：播下一步动画，没有了就翻到下一页。动画进行中时先把它直接播完 */
  next(): void;
  /** 回到上一页的开头 */
  previous(): void;
  goTo(slide: number): void;
  state(): PlayerState;
  /** 把时间往前推这么多毫秒。只在 manual 模式下有用，平时什么都不做 */
  advance(ms: number): void;
  /** 停止播放并移除播放器创建的所有元素 */
  destroy(): void;
}
