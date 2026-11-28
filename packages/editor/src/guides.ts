import { createId, type Guide, type NodeId, type PageNode, type Rect, type Transaction } from '@shiba/core';
import type { Editor } from './editor';
import { snapPoint } from './snap';
import type { PointerInfo } from './types';

/**
 * 标尺和辅助线的操作：从标尺上拖出辅助线、拖动已有的辅助线、拖回标尺上删除、单击选中、双击改位置。
 * 输入控制器在交给工具之前先问这里（标尺区域、辅助线附近的按下由这里处理）。
 *
 * 辅助线是文档的一部分（画板或页面的 guides 字段），改动走事务、可以撤销。
 * 放在画板里的辅助线坐标相对画板，只画在画板里，跟着画板移动；放在画板外的属于页面，画满画布
 */

/** 标尺的宽度，屏幕像素 */
export const RULER_SIZE = 20;
/** 鼠标离辅助线多近算点中，屏幕像素 */
const GUIDE_HIT = 3;

export type GuideHit =
  /** 上边的标尺拖出横线，左边的标尺拖出竖线 */
  { kind: 'ruler'; axis: 'x' | 'y' } | { kind: 'guide'; container: NodeId; id: string; axis: 'x' | 'y' };

interface GuideDrag {
  axis: 'x' | 'y';
  /** 正在拖的已有辅助线；从标尺上新拖出来的为 null */
  existing: { container: NodeId; id: string } | null;
  /** 当前位置（世界坐标） */
  value: number;
  key: string;
  moved: boolean;
  /** 从标尺上拖出来时一开始的方向（按着 Alt 时换成另一个方向） */
  fromRuler: 'x' | 'y' | null;
}

export class GuideController {
  private drag: GuideDrag | null = null;
  private selected: { container: NodeId; id: string } | null = null;

  constructor(private readonly editor: Editor) {}

  /** 正在从标尺上拖出、还没放进文档的那条辅助线（覆盖层画它） */
  get pending(): { axis: 'x' | 'y'; value: number } | null {
    return this.drag && !this.drag.existing ? { axis: this.drag.axis, value: this.drag.value } : null;
  }

  /** 选中的辅助线（画成另一个颜色，按 ⌫ 删除） */
  get selection(): { container: NodeId; id: string } | null {
    return this.selected;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  clearSelection(): void {
    if (!this.selected) return;
    this.selected = null;
    this.editor.requestRender();
  }

  /** 屏幕上的这一点落在标尺上或者辅助线附近吗 */
  hit(x: number, y: number): GuideHit | null {
    const { editor } = this;
    const view = editor.view;
    if (view.rulers) {
      if (y < RULER_SIZE && x >= RULER_SIZE) return { kind: 'ruler', axis: 'y' };
      if (x < RULER_SIZE && y >= RULER_SIZE) return { kind: 'ruler', axis: 'x' };
      if (x < RULER_SIZE && y < RULER_SIZE) return null;
    }
    if (!view.guides || view.guidesLocked) return null;
    const world = editor.screenToWorld(x, y);
    const tolerance = GUIDE_HIT / editor.camera.zoom;
    let best: (GuideHit & { distance: number }) | null = null;
    for (const guide of editor.worldGuides()) {
      if (guide.range && !inRange(guide.range, world, guide.axis, tolerance)) continue;
      const distance = Math.abs((guide.axis === 'x' ? world.x : world.y) - guide.value);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { kind: 'guide', container: guide.container, id: guide.id, axis: guide.axis, distance };
      }
    }
    return best ? { kind: 'guide', container: best.container, id: best.id, axis: best.axis } : null;
  }

  /** 鼠标停在这里时的指针样子；不在标尺、辅助线上时为 null */
  cursorAt(x: number, y: number): string | null {
    const hit = this.hit(x, y);
    if (!hit) return null;
    return hit.axis === 'x' ? 'col-resize' : 'row-resize';
  }

  begin(hit: GuideHit, e: PointerInfo): void {
    const { editor } = this;
    if (hit.kind === 'ruler') {
      this.selected = null;
      this.drag = {
        axis: hit.axis,
        existing: null,
        value: hit.axis === 'x' ? e.world.x : e.world.y,
        key: editor.newMergeKey('guide'),
        moved: false,
        fromRuler: hit.axis,
      };
    } else {
      const guide = editor.worldGuides().find((g) => g.id === hit.id && g.container === hit.container);
      if (!guide) return;
      this.selected = { container: hit.container, id: hit.id };
      this.drag = {
        axis: hit.axis,
        existing: { container: hit.container, id: hit.id },
        value: guide.value,
        key: editor.newMergeKey('guide'),
        moved: false,
        fromRuler: null,
      };
    }
    editor.requestRender();
  }

  move(e: PointerInfo): void {
    const drag = this.drag;
    if (!drag) return;
    const { editor } = this;
    drag.moved = true;
    // 从标尺上拖的时候按着 Alt 换方向（Illustrator 的习惯）
    if (drag.fromRuler) drag.axis = e.alt ? (drag.fromRuler === 'x' ? 'y' : 'x') : drag.fromRuler;
    let value = drag.axis === 'x' ? e.world.x : e.world.y;
    if (e.shift) {
      // 按着 Shift 吸附到标尺的刻度
      const step = rulerStep(editor.camera.zoom).minor;
      const origin = this.origin();
      const base = drag.axis === 'x' ? origin.x : origin.y;
      value = base + Math.round((value - base) / step) * step;
      editor.setSnapFeedback(null);
    } else if (editor.snapping && !e.mod) {
      const hit = snapPoint(editor.snapTargets([]), e.world, {
        threshold: editor.snapThreshold,
        axes: { x: drag.axis === 'x', y: drag.axis === 'y' },
        pixels: editor.view.snapPixels,
      });
      value = drag.axis === 'x' ? hit.point.x : hit.point.y;
      editor.setSnapFeedback({ lines: hit.lines, spacing: [] });
    }
    drag.value = value;
    if (drag.existing) {
      const { container, id } = drag.existing;
      editor.store.transact('move guide', (tx) => this.setOffset(tx, container, id, value), { mergeKey: drag.key });
    }
    editor.requestRender();
  }

  end(e: PointerInfo): void {
    const drag = this.drag;
    this.drag = null;
    const { editor } = this;
    editor.setSnapFeedback(null);
    if (!drag) return;
    const overRuler = editor.view.rulers && (e.x < RULER_SIZE || e.y < RULER_SIZE);
    if (drag.existing) {
      if (overRuler && drag.moved) {
        // 拖回标尺上：删掉
        const { container, id } = drag.existing;
        editor.store.transact('remove guide', (tx) => removeGuide(tx, container, id), { mergeKey: drag.key });
        this.selected = null;
      }
      editor.store.sealHistory();
      editor.requestRender();
      return;
    }
    if (!drag.moved || overRuler) {
      editor.requestRender();
      return;
    }
    // 松手在画板里：属于这个画板；在画板外：属于页面
    const board = this.boardAt(e);
    const offset = board ? drag.value - (drag.axis === 'x' ? board.rect.x : board.rect.y) : drag.value;
    const container = board?.id ?? editor.store.root.id;
    const guide: Guide = { id: createId(), axis: drag.axis, offset };
    editor.store.transact('add guide', (tx) => {
      const node = tx.get(container) as { guides?: readonly Guide[] } | undefined;
      tx.update(container, { guides: [...(node?.guides ?? []), guide] });
    });
    editor.store.sealHistory();
    this.selected = { container, id: guide.id };
    editor.requestRender();
  }

  cancel(): void {
    const drag = this.drag;
    this.drag = null;
    this.editor.setSnapFeedback(null);
    if (drag?.existing) this.editor.store.abandon(drag.key);
    this.editor.requestRender();
  }

  /** 删掉选中的辅助线；没有选中时返回 false */
  removeSelected(): boolean {
    const selected = this.selected;
    if (!selected) return false;
    const { editor } = this;
    editor.store.transact('remove guide', (tx) => removeGuide(tx, selected.container, selected.id));
    editor.store.sealHistory();
    this.selected = null;
    editor.requestRender();
    return true;
  }

  /** 标尺的原点：幻灯片视图里是当前这一页的左上角；画布视图里是选中对象所在的画板，没有就是页面原点 */
  origin(): { x: number; y: number } {
    const board = this.originBoard();
    return board ? { x: board.x, y: board.y } : { x: 0, y: 0 };
  }

  originBoard(): Rect | null {
    const { editor } = this;
    if (editor.viewMode === 'slides') {
      const board = editor.activeArtboard;
      return board ? editor.geometry.worldBounds(board) : null;
    }
    for (const node of editor.selectedNodes()) {
      let current: typeof node | undefined = node;
      while (current && current.type !== 'artboard')
        current = current.parent ? editor.store.get(current.parent) : undefined;
      if (current) return editor.geometry.worldBounds(current);
    }
    return null;
  }

  private boardAt(e: PointerInfo): { id: NodeId; rect: Rect } | null {
    const { editor } = this;
    const container = editor.containerAt(e.world);
    if (container.type !== 'artboard') return null;
    return { id: container.id, rect: editor.geometry.worldBounds(container) };
  }

  private setOffset(tx: Transaction, container: NodeId, id: string, value: number): void {
    const { editor } = this;
    const node = tx.get(container);
    if (!node) return;
    const guides = (node as { guides?: readonly Guide[] }).guides ?? [];
    const base = node.type === 'artboard' ? editor.geometry.worldBounds(node) : null;
    const offset = base ? value - (guides.find((g) => g.id === id)?.axis === 'x' ? base.x : base.y) : value;
    tx.update(container, { guides: guides.map((g) => (g.id === id ? { ...g, offset } : g)) });
  }
}

function inRange(range: Rect, world: { x: number; y: number }, axis: 'x' | 'y', tolerance: number): boolean {
  return axis === 'x'
    ? world.y >= range.y - tolerance && world.y <= range.y + range.h + tolerance
    : world.x >= range.x - tolerance && world.x <= range.x + range.w + tolerance;
}

function removeGuide(tx: Transaction, container: NodeId, id: string): void {
  const node = tx.get(container) as { guides?: readonly Guide[] } | undefined;
  const next = (node?.guides ?? []).filter((g) => g.id !== id);
  tx.update(container, { guides: next.length > 0 ? next : undefined });
}

/** 去掉一个画板（或页面）上的所有辅助线 */
export function clearGuides(tx: Transaction, container: NodeId): void {
  tx.update(container, { guides: undefined });
}

/** 页面上有没有辅助线（清除的命令能不能用） */
export function hasGuides(node: { guides?: readonly Guide[] } | PageNode | undefined): boolean {
  return !!node && 'guides' in node && (node.guides?.length ?? 0) > 0;
}

/** 标尺的刻度：主刻度（标数字）的间隔让相邻两个数字隔开至少 60 屏幕像素，小刻度是它的五分之一或十分之一 */
export function rulerStep(zoom: number): { major: number; minor: number } {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000];
  const major = steps.find((s) => s * zoom >= 60) ?? steps.at(-1)!;
  const minor = major % 5 === 0 && (major / 5) * zoom >= 6 ? major / 5 : major / 2;
  return { major, minor };
}
