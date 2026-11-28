import { useSyncExternalStore } from 'react';
import { activateTab, moveTab, type DropTarget, type ZoneId } from './layout';
import { getDockPanel } from './registry';
import { setLayout } from './store';

/**
 * 拖选项卡：按下后挪出 8 像素才算开始拖，之前是普通的点击（切到这个面板）。
 * 拖动中按指针下面的元素决定放到哪里：选项卡栏上是并进那一组，停靠区里一组的上下边缘是拆出新组，
 * 别的地方（画布上）是变成浮动窗。用指针事件实现，不用 HTML5 拖放：拖影没法控制，自动化测试也触发不了
 */

const START_DISTANCE = 8;

export interface TabDragState {
  tab: string;
  x: number;
  y: number;
  target: DropTarget | null;
  /** 放下的位置在屏幕上的提示（一条线或者一块区域） */
  indicator: { left: number; top: number; width: number; height: number } | null;
}

let state: TabDragState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function useTabDrag(): TabDragState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** 在选项卡上按下：开始跟踪，挪够了就开始拖 */
export function beginTabPointer(tab: string, event: PointerEvent | React.PointerEvent): void {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let started = false;

  const onMove = (e: PointerEvent): void => {
    if (!started) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < START_DISTANCE) return;
      started = true;
    }
    const hit = dropTargetAt(tab, e.clientX, e.clientY);
    state = { tab, x: e.clientX, y: e.clientY, target: hit.target, indicator: hit.indicator };
    emit();
  };
  const finish = (apply: boolean): void => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    const target = state?.target ?? null;
    state = null;
    emit();
    if (!apply) return;
    if (started && target) setLayout((current) => moveTab(current, tab, target));
    else if (!started) setLayout((current) => activateTab(current, tab));
  };
  const onUp = (): void => finish(true);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('keydown', onKey, true);
}

/** 指针下面能放到哪里 */
function dropTargetAt(tab: string, x: number, y: number): { target: DropTarget; indicator: TabDragState['indicator'] } {
  const element = document.elementFromPoint(x, y);
  // 选项卡栏：按指针在哪两个选项卡之间算插入的位置
  const bar = element?.closest<HTMLElement>('[data-dock-tabs]');
  if (bar) {
    const tabs = [...bar.querySelectorAll<HTMLElement>('[data-dock-tab]')];
    let index = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i]!.getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    const barRect = bar.getBoundingClientRect();
    const ref = tabs[index]?.getBoundingClientRect();
    const lineX = ref ? ref.left - 1 : (tabs.at(-1)?.getBoundingClientRect().right ?? barRect.left) + 1;
    return {
      target: { kind: 'tabs', group: bar.dataset.dockTabs!, index },
      indicator: { left: lineX - 1, top: barRect.top + 4, width: 2, height: barRect.height - 8 },
    };
  }
  // 收起的停靠区那条细边：放进这个停靠区
  const strip = element?.closest<HTMLElement>('[data-dock-strip]');
  if (strip) {
    const r = strip.getBoundingClientRect();
    return {
      target: { kind: 'split', zone: strip.dataset.dockStrip as ZoneId, index: 0 },
      indicator: { left: r.left, top: r.top, width: r.width, height: r.height },
    };
  }
  // 停靠区里：一组的上（左）四分之一是拆到它前面，下（右）四分之一是拆到它后面，中间是并进这一组
  const zoneElement = element?.closest<HTMLElement>('[data-dock-zone]');
  if (zoneElement) {
    const zone = zoneElement.dataset.dockZone as ZoneId;
    const horizontal = zone === 'bottom';
    const groups = [...zoneElement.querySelectorAll<HTMLElement>(':scope > [data-dock-group]')];
    const zr = zoneElement.getBoundingClientRect();
    if (groups.length === 0) {
      return {
        target: { kind: 'split', zone, index: 0 },
        indicator: { left: zr.left, top: zr.top, width: zr.width, height: zr.height },
      };
    }
    for (let i = 0; i < groups.length; i++) {
      const r = groups[i]!.getBoundingClientRect();
      const along = horizontal ? x : y;
      const start = horizontal ? r.left : r.top;
      const size = horizontal ? r.width : r.height;
      if (along < start || along > start + size) continue;
      const edge = Math.min(48, size / 4);
      const line = (pos: number): TabDragState['indicator'] =>
        horizontal
          ? { left: pos - 1, top: r.top, width: 3, height: r.height }
          : { left: r.left, top: pos - 1, width: r.width, height: 3 };
      if (along < start + edge) return { target: { kind: 'split', zone, index: i }, indicator: line(start) };
      if (along > start + size - edge)
        return { target: { kind: 'split', zone, index: i + 1 }, indicator: line(start + size) };
      return {
        target: { kind: 'tabs', group: groups[i]!.dataset.dockGroup!, index: Number.MAX_SAFE_INTEGER },
        indicator: { left: r.left, top: r.top, width: r.width, height: r.height },
      };
    }
  }
  // 别的地方：变成浮动窗，左上角在指针附近
  const size = getDockPanel(tab)?.floatSize ?? { w: 280, h: 420 };
  return {
    target: { kind: 'float', x: Math.max(0, x - 40), y: Math.max(0, y - 14), w: size.w, h: size.h },
    indicator: { left: Math.max(0, x - 40), top: Math.max(0, y - 14), width: size.w, height: size.h },
  };
}
