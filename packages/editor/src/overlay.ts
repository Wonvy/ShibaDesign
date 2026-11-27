import { artboards, type NodeId, type Rect } from '@shiba/core';
import type { Editor } from './editor';
import { HANDLES, handleAnchor, type Handle } from './resize';

const HANDLE_SIZE = 8;
const HANDLE_HIT = 7;
const LABEL_FONT = '12px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const LABEL_HEIGHT = 18;

interface LabelBox extends Rect {
  id: NodeId;
}

/**
 * 覆盖层：画在场景之上的编辑辅助图形（选区框、控制柄、画板名、工具预览）。
 * 用普通的 Canvas 2D 绘制，这样能直接用系统字体，也不占用场景渲染的资源。
 */
export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private labels: LabelBox[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly editor: Editor,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  }

  draw(): void {
    const { ctx, editor } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawArtboardLabels();
    this.drawSelection();
    editor.tool.drawOverlay?.(ctx, editor);
  }

  /** 屏幕上的某个点是否落在画板名上 */
  hitArtboardLabel(x: number, y: number): NodeId | null {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const box = this.labels[i]!;
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return box.id;
    }
    return null;
  }

  /** 屏幕上的某个点是否落在选区的某个控制柄上 */
  hitHandle(x: number, y: number): Handle | null {
    const rect = this.selectionScreenRect();
    if (!rect) return null;
    for (const handle of HANDLES) {
      const anchor = handleAnchor(handle);
      const hx = rect.x + rect.w * anchor.x;
      const hy = rect.y + rect.h * anchor.y;
      if (Math.abs(x - hx) <= HANDLE_HIT && Math.abs(y - hy) <= HANDLE_HIT) return handle;
    }
    return null;
  }

  private toScreen(rect: Rect): Rect {
    const { camera } = this.editor;
    return {
      x: rect.x * camera.zoom + camera.x,
      y: rect.y * camera.zoom + camera.y,
      w: rect.w * camera.zoom,
      h: rect.h * camera.zoom,
    };
  }

  private selectionScreenRect(): Rect | null {
    const bounds = this.editor.selectionBounds();
    return bounds ? this.toScreen(bounds) : null;
  }

  private drawArtboardLabels(): void {
    const { ctx, editor } = this;
    this.labels = [];
    if (editor.viewMode !== 'canvas') return;
    const selected = new Set(editor.selection);
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'bottom';
    for (const board of artboards(editor.store)) {
      if (!board.visible) continue;
      const rect = this.toScreen(editor.geometry.worldBounds(board));
      const text = editor.labelOf(board);
      const width = Math.min(ctx.measureText(text).width, Math.max(24, rect.w));
      ctx.fillStyle = selected.has(board.id) ? editor.theme.accent : editor.theme.label;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y - LABEL_HEIGHT - 2, Math.max(24, rect.w), LABEL_HEIGHT + 2);
      ctx.clip();
      ctx.fillText(text, rect.x, rect.y - 5);
      ctx.restore();
      this.labels.push({ id: board.id, x: rect.x, y: rect.y - LABEL_HEIGHT - 2, w: width, h: LABEL_HEIGHT + 2 });
    }
  }

  private drawSelection(): void {
    const { ctx, editor } = this;
    const nodes = editor.selectedNodes();
    if (nodes.length === 0) return;
    ctx.strokeStyle = editor.theme.accent;
    ctx.lineWidth = 1;

    if (nodes.length > 1) {
      for (const node of nodes) {
        const r = this.toScreen(editor.geometry.worldBounds(node));
        ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
      }
    }

    const rect = this.selectionScreenRect();
    if (!rect) return;
    ctx.lineWidth = nodes.length > 1 ? 1 : 1.5;
    ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.round(rect.w), Math.round(rect.h));

    if (editor.getState().tool !== 'select') return;
    ctx.fillStyle = editor.theme.handleFill;
    ctx.lineWidth = 1.5;
    for (const handle of HANDLES) {
      const anchor = handleAnchor(handle);
      const x = Math.round(rect.x + rect.w * anchor.x) - HANDLE_SIZE / 2;
      const y = Math.round(rect.y + rect.h * anchor.y) - HANDLE_SIZE / 2;
      ctx.fillRect(x, y, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeRect(x + 0.5, y + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
    }
  }
}
