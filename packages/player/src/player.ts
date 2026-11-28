import type {
  PlayerAnimation,
  PlayerHandle,
  PlayerLayer,
  PlayerOptions,
  PlayerSlide,
  PlayerState,
  PresentationData,
} from './types';

/**
 * HTML5 播放器。用浏览器原生的 Web Animations API 播放一份编译好的演示稿。
 *
 * ⚠️ 这个函数必须完全自给自足：函数体里不能引用函数外面的任何变量、函数或导入（类型除外）。
 * 导出成网页时，我们是把这个函数的源码原样写进 HTML 里的（见 export.ts），
 * 它在那里独立运行，外面什么都没有。需要的辅助函数一律定义在函数内部。
 *
 * 每个图层是三层嵌套的元素，各管一件事，互不干扰：
 *   mover  整体平移（飞入飞出），以及混合模式、显示与隐藏
 *   layer  把图层摆到幻灯片上的固定位置（"平滑"切换时补间的就是它）
 *   fx     以图层中心为原点的效果：缩放、旋转、透明度、裁剪
 */
export function runPlayer(root: HTMLElement, data: PresentationData, options: PlayerOptions = {}): PlayerHandle {
  interface LayerView {
    data: PlayerLayer;
    mover: HTMLElement;
    layer: HTMLElement;
    fx: HTMLElement;
    /** 图层内容：<img>，或者装着内联 SVG 的元素 */
    image: HTMLElement;
  }
  interface SlideView {
    data: PlayerSlide;
    /** 负责把幻灯片缩放到适合窗口的外框 */
    frame: HTMLElement;
    /** 幻灯片本身；切换效果作用在它上面 */
    el: HTMLElement;
    layers: Map<string, LayerView>;
  }
  interface Running {
    timer: number;
    animations: Animation[];
    done: boolean;
    begin(): void;
    end(): void;
  }

  const doc = root.ownerDocument;
  const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
  const stage = doc.createElement('div');
  stage.tabIndex = 0;
  stage.style.cssText =
    'position:absolute;inset:0;overflow:hidden;background:#000;outline:none;user-select:none;-webkit-user-select:none;cursor:default;';
  const counter = doc.createElement('div');
  counter.style.cssText =
    'position:absolute;right:14px;bottom:10px;z-index:10;font:12px/1 system-ui,sans-serif;color:#fff;opacity:.45;pointer-events:none;text-shadow:0 0 3px #000;';
  stage.appendChild(counter);
  if (data.fonts) {
    // @font-face 放在哪里都对整个页面生效；放在舞台里，播放器关掉时跟着移除
    const fonts = doc.createElement('style');
    fonts.textContent = data.fonts;
    stage.appendChild(fonts);
  }
  root.appendChild(stage);

  let slideIndex = -1;
  let stepIndex = 0;
  let current: SlideView | null = null;
  let running: Running[] = [];
  let transition: { finish(): void } | null = null;
  let destroyed = false;

  const matrixCss = (m: readonly number[]): string => `matrix(${m.join(',')})`;
  let contentCount = 0;

  /**
   * 图层的内容元素。SVG 里的 id 换成这一份独有的前缀：平滑切换时前后两页、淡出的残影里会有同样的图层，
   * id 重复的话，裁剪、蒙版、渐变的引用会指到别的那份上（比如已经隐藏的上一页），内容就看不见了
   */
  function makeContent(layerData: PlayerLayer): HTMLElement {
    if (layerData.svg) {
      const content = doc.createElement('div');
      content.innerHTML = layerData.svg.split('\u0001').join(`p${++contentCount}-`);
      // 内联的 SVG：放大不糊，文字可以选中、复制，也能被网页的查找搜到
      content.style.cssText = 'position:absolute;inset:0;user-select:text;-webkit-user-select:text;cursor:default;';
      content.dataset.layer = layerData.id;
      return content;
    }
    const img = doc.createElement('img');
    img.src = layerData.src || '';
    img.alt = '';
    img.draggable = false;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    return img;
  }

  function buildSlide(slide: PlayerSlide): SlideView {
    const frame = doc.createElement('div');
    frame.style.cssText = `position:absolute;left:0;top:0;width:${slide.width}px;height:${slide.height}px;transform-origin:0 0;overflow:hidden;`;
    const el = doc.createElement('div');
    el.style.cssText = `position:absolute;inset:0;overflow:hidden;background:${slide.background};`;
    frame.appendChild(el);

    const layers = new Map<string, LayerView>();
    for (const layerData of slide.layers) {
      const mover = doc.createElement('div');
      mover.style.cssText = `position:absolute;left:0;top:0;mix-blend-mode:${layerData.blend};`;
      if (layerData.hidden) mover.style.visibility = 'hidden';
      const layer = doc.createElement('div');
      layer.style.cssText = `position:absolute;left:0;top:0;width:${layerData.width}px;height:${layerData.height}px;transform-origin:0 0;transform:${matrixCss(layerData.matrix)};`;
      const fx = doc.createElement('div');
      fx.style.cssText = 'position:absolute;inset:0;transform-origin:50% 50%;';
      const image = makeContent(layerData);
      fx.appendChild(image);
      layer.appendChild(fx);
      mover.appendChild(layer);
      el.appendChild(mover);
      layers.set(layerData.id, { data: layerData, mover, layer, fx, image });
    }
    return { data: slide, frame, el, layers };
  }

  /** 把幻灯片等比缩放并居中到窗口里 */
  function fit(view: SlideView): void {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const scale = Math.min(width / view.data.width, height / view.data.height) || 1;
    const x = (width - view.data.width * scale) / 2;
    const y = (height - view.data.height * scale) / 2;
    view.frame.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  }

  function isBusy(): boolean {
    return transition !== null || running.some((entry) => !entry.done);
  }

  function state(): PlayerState {
    return {
      slide: Math.max(0, slideIndex),
      slides: data.slides.length,
      step: stepIndex,
      steps: current ? current.data.steps.length : 0,
      busy: isBusy(),
    };
  }

  function notify(): void {
    counter.textContent = data.slides.length > 0 ? `${slideIndex + 1} / ${data.slides.length}` : '';
    if (options.onChange) options.onChange(state());
  }

  // ───────────── 动画步骤 ─────────────

  function playStep(view: SlideView, index: number): void {
    const step: PlayerAnimation[] = view.data.steps[index] || [];
    running = [];
    for (const animation of step) {
      const target = view.layers.get(animation.layer);
      if (!target) continue;
      const entry: Running = {
        timer: 0,
        animations: [],
        done: false,
        begin() {
          entry.timer = 0;
          if (animation.show) target.mover.style.visibility = 'visible';
          const timing: KeyframeAnimationOptions = {
            duration: Math.max(1, animation.duration),
            easing: animation.easing,
            fill: 'forwards',
          };
          if (animation.duration > 0) {
            if (animation.fx) entry.animations.push(target.fx.animate(animation.fx as Keyframe[], timing));
            if (animation.move) entry.animations.push(target.mover.animate(animation.move as Keyframe[], timing));
          }
          if (entry.animations.length === 0) entry.end();
          else Promise.all(entry.animations.map((a) => a.finished)).then(entry.end, () => undefined);
        },
        end() {
          if (entry.done) return;
          entry.done = true;
          if (animation.hide) target.mover.style.visibility = 'hidden';
          if (!isBusy()) notify();
        },
      };
      running.push(entry);
      if (animation.start > 0) entry.timer = window.setTimeout(entry.begin, animation.start);
      else entry.begin();
    }
  }

  /** 把当前这一步直接播到结尾 */
  function finishStep(): void {
    for (const entry of running) {
      if (entry.done) continue;
      if (entry.timer) {
        window.clearTimeout(entry.timer);
        entry.begin();
      }
      for (const animation of entry.animations) animation.finish();
      entry.end();
    }
  }

  // ───────────── 页面切换 ─────────────

  function runTransition(previous: SlideView, next: SlideView, done: () => void): void {
    const spec = next.data.transition;
    const duration = Math.max(0, spec.duration);
    const active: Animation[] = [];
    const cleanup: (() => void)[] = [];
    const play = (el: Element, frames: Keyframe[], easing = EASE): void => {
      active.push(el.animate(frames, { duration, easing, fill: 'both' }));
    };

    if (spec.effect === 'fade') {
      play(next.el, [{ opacity: 0 }, { opacity: 1 }], 'ease');
    } else if (spec.effect === 'zoom') {
      play(next.el, [
        { opacity: 0, transform: 'scale(0.86)' },
        { opacity: 1, transform: 'scale(1)' },
      ]);
      play(previous.el, [{ opacity: 1 }, { opacity: 0 }], 'ease');
    } else if (spec.effect === 'push') {
      // direction 是新的一页从哪边进来；旧的一页往相反方向出去
      const from = spec.direction || 'right';
      const axis = from === 'left' || from === 'right' ? 'X' : 'Y';
      const sign = from === 'left' || from === 'top' ? -1 : 1;
      play(next.el, [{ transform: `translate${axis}(${sign * 100}%)` }, { transform: `translate${axis}(0)` }]);
      play(previous.el, [{ transform: `translate${axis}(0)` }, { transform: `translate${axis}(${-sign * 100}%)` }]);
    } else if (spec.effect === 'smooth') {
      // 平滑：两页上标识相同的图层视为同一个对象，从旧的位置补间到新的位置
      previous.frame.style.visibility = 'hidden';
      // 背景色跟着过渡；渐变背景没法逐帧过渡，直接换
      if (!/gradient/.test(previous.data.background + next.data.background)) {
        play(
          next.el,
          [{ backgroundColor: previous.data.background }, { backgroundColor: next.data.background }],
          'ease',
        );
      }

      const unmatched: LayerView[] = [];
      const pool = new Map<string, LayerView[]>();
      for (const view of previous.layers.values()) {
        if (view.mover.style.visibility === 'hidden') continue;
        const list = pool.get(view.data.key);
        if (list) list.push(view);
        else pool.set(view.data.key, [view]);
      }

      for (const view of next.layers.values()) {
        if (view.mover.style.visibility === 'hidden') continue;
        const candidates = pool.get(view.data.key);
        const source = candidates && candidates.length > 0 ? candidates.shift() : undefined;
        if (!source) {
          play(view.mover, [{ opacity: 0 }, { opacity: 1 }], 'ease');
          continue;
        }
        // 旧图层和新图层的盒子大小可能不同，先用缩放把新盒子"变成"旧盒子的样子
        const sx = source.data.width / view.data.width;
        const sy = source.data.height / view.data.height;
        const m = source.data.matrix;
        const start = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]];
        play(view.layer, [{ transform: matrixCss(start) }, { transform: matrixCss(view.data.matrix) }]);

        if ((source.data.svg || source.data.src) !== (view.data.svg || view.data.src)) {
          // 内容也变了：旧内容盖在上面淡出，露出新内容
          const ghost = makeContent(source.data);
          view.fx.appendChild(ghost);
          play(ghost, [{ opacity: 1 }, { opacity: 0 }], 'ease');
          play(view.image, [{ opacity: 0 }, { opacity: 1 }], 'ease');
          cleanup.push(() => ghost.remove());
        }
      }
      for (const list of pool.values()) unmatched.push(...list);

      // 新的一页上没有的对象：搬到新页的最下面，原地淡出
      for (const view of unmatched) {
        const ghost = view.mover.cloneNode(true) as HTMLElement;
        // 复制出来的 SVG 和原来的 id 一样，换成一份新的
        const copied = ghost.querySelector('[data-layer]');
        if (copied) copied.replaceWith(makeContent(view.data));
        next.el.insertBefore(ghost, next.el.firstChild);
        play(ghost, [{ opacity: 1 }, { opacity: 0 }], 'ease');
        cleanup.push(() => ghost.remove());
      }
    }

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      for (const animation of active) animation.cancel();
      for (const fn of cleanup) fn();
      previous.frame.remove();
      transition = null;
      done();
    };
    transition = {
      finish() {
        for (const animation of active) animation.finish();
        finish();
      },
    };
    if (active.length === 0 || duration === 0) finish();
    else Promise.all(active.map((a) => a.finished)).then(finish, () => undefined);
  }

  function showSlide(index: number, animated: boolean): void {
    if (destroyed || index < 0 || index >= data.slides.length) return;
    if (transition) transition.finish();
    finishStep();
    running = [];

    const previous = current;
    const next = buildSlide(data.slides[index]!);
    stage.insertBefore(next.frame, counter);
    fit(next);
    current = next;
    slideIndex = index;
    stepIndex = 0;

    const enter = (): void => {
      if (current !== next) return;
      playStep(next, 0);
      notify();
    };
    if (previous && animated && next.data.transition.effect !== 'none') {
      runTransition(previous, next, enter);
      notify();
    } else {
      if (previous) previous.frame.remove();
      enter();
    }
  }

  // ───────────── 控制 ─────────────

  function next(): void {
    if (destroyed || !current) return;
    if (transition) {
      transition.finish();
      return;
    }
    if (running.some((entry) => !entry.done)) {
      finishStep();
      return;
    }
    if (stepIndex + 1 < current.data.steps.length) {
      stepIndex += 1;
      playStep(current, stepIndex);
      notify();
    } else if (slideIndex + 1 < data.slides.length) {
      showSlide(slideIndex + 1, true);
    }
  }

  function previous(): void {
    showSlide(Math.max(0, slideIndex - (stepIndex === 0 && !isBusy() ? 1 : 0)), false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const key = event.key;
    if (key === 'ArrowRight' || key === 'ArrowDown' || key === ' ' || key === 'Enter' || key === 'PageDown') next();
    else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || key === 'Backspace') previous();
    else if (key === 'Home') showSlide(0, false);
    else if (key === 'End') showSlide(data.slides.length - 1, false);
    else if (key === 'Escape') {
      if (options.onExit) options.onExit();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onClick(): void {
    // 刚拖动鼠标选中了文字：这一下是选字，不是翻页
    const selection = doc.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && stage.contains(selection.anchorNode)) return;
    stage.focus();
    next();
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => current && fit(current));
  if (observer) observer.observe(stage);
  stage.addEventListener('click', onClick);
  stage.addEventListener('keydown', onKeyDown);
  stage.focus();
  showSlide(Math.min(Math.max(0, options.startSlide || 0), Math.max(0, data.slides.length - 1)), false);

  return {
    next,
    previous,
    goTo: (slide) => showSlide(slide, false),
    state,
    destroy() {
      if (destroyed) return;
      if (transition) transition.finish();
      for (const entry of running) {
        if (entry.timer) window.clearTimeout(entry.timer);
        for (const animation of entry.animations) animation.cancel();
      }
      destroyed = true;
      if (observer) observer.disconnect();
      stage.removeEventListener('click', onClick);
      stage.removeEventListener('keydown', onKeyDown);
      stage.remove();
    },
  };
}
