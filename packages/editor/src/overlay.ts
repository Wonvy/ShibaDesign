import {
  applyToPoint,
  artboards,
  worldTransform,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from './editor';
import { HANDLES, handleAnchor, type Handle } from './resize';

const HANDLE_SIZE = 8;
const HANDLE_HIT = 7;
/** 旋转手柄离选区框上边的距离，屏幕像素 */
const ROTATE_OFFSET = 24;
const ROTATE_RADIUS = 4.5;
const ROTATE_HIT = 9;
const LABEL_FONT = '12px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const LABEL_HEIGHT = 18;

interface LabelBox extends Rect {
  id: NodeId;
}

export type HandleHit = { kind: 'resize'; handle: Handle } | { kind: 'rotate' };

/** 选区框在屏幕上的样子：四个角、旋转手柄的位置、整体转了多少 */
interface ScreenFrame {
  /** 左上、右上、右下、左下 */
  corners: [Point, Point, Point, Point];
  /** 框转过的角度（弧度），用来让缩放指针的方向跟着转 */
  angle: number;
  /** 旋转手柄的位置；不能旋转时为 null */
  rotate: Point | null;
  topMiddle: Point;
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

  /** 屏幕上的某个点是否落在选区的缩放控制柄或旋转手柄上 */
  hitHandle(x: number, y: number): HandleHit | null {
    const frame = this.screenFrame();
    if (!frame) return null;
    for (const handle of HANDLES) {
      const p = handlePoint(frame, handle);
      if (Math.abs(x - p.x) <= HANDLE_HIT && Math.abs(y - p.y) <= HANDLE_HIT) return { kind: 'resize', handle };
    }
    if (frame.rotate && Math.hypot(x - frame.rotate.x, y - frame.rotate.y) <= ROTATE_HIT) return { kind: 'rotate' };
    return null;
  }

  /** 选区框当前转过的角度，弧度 */
  frameAngle(): number {
    return this.screenFrame()?.angle ?? 0;
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

  private screenFrame(): ScreenFrame | null {
    const frame = this.editor.selectionFrame();
    if (!frame) return null;
    const corners = frame.corners.map((c) => this.editor.worldToScreen(c.x, c.y)) as ScreenFrame['corners'];
    const [tl, tr, br] = corners;
    const topMiddle = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
    const centre = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
    // 旋转手柄在上边中点的外侧，方向是"从中心指向上边中点"；框被翻转过时它也会跟着到另一侧
    let nx = topMiddle.x - centre.x;
    let ny = topMiddle.y - centre.y;
    const length = Math.hypot(nx, ny);
    if (length < 0.001) {
      nx = 0;
      ny = -1;
    } else {
      nx /= length;
      ny /= length;
    }
    return {
      corners,
      angle: Math.atan2(tr.y - tl.y, tr.x - tl.x),
      topMiddle,
      rotate: frame.rotatable ? { x: topMiddle.x + nx * ROTATE_OFFSET, y: topMiddle.y + ny * ROTATE_OFFSET } : null,
    };
  }

  /** 一个节点自己的包围盒在屏幕上的四个角 */
  private nodeCorners(node: SceneNode): Point[] {
    const { editor } = this;
    const box = editor.geometry.localBounds(node);
    const world = worldTransform(editor.store, node.id);
    return [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h],
      [box.x, box.y + box.h],
    ].map(([x, y]) => {
      const [wx, wy] = applyToPoint(world, x!, y!);
      return editor.worldToScreen(wx, wy);
    });
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
    const frame = this.screenFrame();
    if (nodes.length === 0 || !frame) return;
    ctx.save();
    ctx.strokeStyle = editor.theme.accent;

    // 多选时先给每个对象各画一个贴合它自己方向的细框
    if (nodes.length > 1) {
      ctx.lineWidth = 1;
      for (const node of nodes) strokePolygon(ctx, this.nodeCorners(node));
    }

    ctx.lineWidth = nodes.length > 1 ? 1 : 1.5;
    strokePolygon(ctx, frame.corners);

    if (editor.getState().tool === 'select') {
      if (frame.rotate) {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(frame.topMiddle.x, frame.topMiddle.y);
        ctx.lineTo(frame.rotate.x, frame.rotate.y);
        ctx.stroke();
        ctx.fillStyle = editor.theme.handleFill;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(frame.rotate.x, frame.rotate.y, ROTATE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.fillStyle = editor.theme.handleFill;
      ctx.lineWidth = 1.5;
      for (const handle of HANDLES) {
        const p = handlePoint(frame, handle);
        // 控制柄跟着框一起转，看起来才是贴在框上的
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(frame.angle);
        ctx.fillRect(-HANDLE_SIZE / 2, -HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(-HANDLE_SIZE / 2 + 0.5, -HANDLE_SIZE / 2 + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

/** 某个控制柄在屏幕上的位置。框可能是斜的，所以用四个角插值，而不是按矩形算 */
function handlePoint(frame: ScreenFrame, handle: Handle): Point {
  const [tl, tr, , bl] = frame.corners;
  const anchor = handleAnchor(handle);
  return {
    x: tl.x + (tr.x - tl.x) * anchor.x + (bl.x - tl.x) * anchor.y,
    y: tl.y + (tr.y - tl.y) * anchor.x + (bl.y - tl.y) * anchor.y,
  };
}

function strokePolygon(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  const first = points[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
  ctx.closePath();
  ctx.stroke();
}
