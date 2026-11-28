import {
  applyToPoint,
  artboards,
  hasShapeStyle,
  maskParts,
  multiply,
  normalizeStops,
  toCssColor,
  worldTransform,
  type Matrix,
  type NodeId,
  type Point,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import type { Editor } from './editor';
import { gradientHandlePoints, imageRect, type GradientPoint } from './fill-handles';
import { drawCornerWidgets } from './corner-handles';
import { drawMotionPaths } from './motion-handles';
import {
  drawGuides,
  drawMeasure,
  drawPill,
  drawPixelGrid,
  drawRulers,
  drawSnapFeedback,
  formatNumber,
} from './overlay-guides';
import { HANDLES, handleAnchor, type Handle } from './resize';

const HANDLE_SIZE = 8;
const HANDLE_HIT = 7;
/** 旋转手柄离选区框上边的距离，屏幕像素 */
const ROTATE_OFFSET = 24;
const ROTATE_RADIUS = 4.5;
const ROTATE_HIT = 9;
/** 鼠标在选区框四个角外侧这么远以内时也能旋转（手柄被别的东西挡住时也转得了），屏幕像素 */
const ROTATE_CORNER_ZONE = 20;
const LABEL_FONT = '12px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const LABEL_HEIGHT = 18;

interface LabelBox extends Rect {
  id: NodeId;
}

export type HandleHit =
  | { kind: 'resize'; handle: Handle }
  | { kind: 'rotate' }
  /** 在画布上调整渐变时的手柄 */
  | { kind: 'gradient'; point: GradientPoint }
  /** 在画布上调整图片时，图片四个角的缩放手柄（0 左上、1 右上、2 右下、3 左下） */
  | { kind: 'image'; corner: number };

/** 填充手柄的半径、点中的范围，屏幕像素 */
const FILL_HANDLE_RADIUS = 6;
const FILL_HANDLE_HIT = 9;

/** 在画布上调整填充时，手柄在屏幕上的位置 */
type FillHandles =
  | {
      kind: 'gradient';
      start: Point;
      end: Point;
      aspect: Point | null;
      /** 起点和终点的颜色（第一个和最后一个色标），画在手柄里 */
      colors: [string, string];
    }
  | { kind: 'image'; corners: Point[] };

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
    drawPixelGrid(ctx, editor);
    drawGuides(ctx, editor);
    this.drawArtboardLabels();
    this.drawHover();
    this.drawSelection();
    // 选中对象的动作路径画在选区框上面，见 motion-handles.ts
    drawMotionPaths(ctx, editor);
    drawSnapFeedback(ctx, editor);
    drawMeasure(ctx, editor);
    editor.tool.drawOverlay?.(ctx, editor);
    drawRulers(ctx, editor);
  }

  /** 屏幕上的某个点是否落在画板名上 */
  hitArtboardLabel(x: number, y: number): NodeId | null {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const box = this.labels[i]!;
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return box.id;
    }
    return null;
  }

  /**
   * 屏幕上的某个点是否落在选区的缩放控制柄或旋转手柄上。
   * 在画布上调整填充时只有填充的手柄（缩放、旋转手柄不显示，也点不中）
   */
  hitHandle(x: number, y: number): HandleHit | null {
    const handles = this.fillHandles();
    if (handles) {
      const near = (p: Point | null): boolean => p !== null && Math.hypot(x - p.x, y - p.y) <= FILL_HANDLE_HIT;
      if (handles.kind === 'gradient') {
        // 手柄重叠时优先拿终点：起点终点重合时还能拖开
        if (near(handles.end)) return { kind: 'gradient', point: 'end' };
        if (near(handles.start)) return { kind: 'gradient', point: 'start' };
        if (near(handles.aspect)) return { kind: 'gradient', point: 'aspect' };
        return null;
      }
      const corner = handles.corners.findIndex((p) => near(p));
      return corner >= 0 ? { kind: 'image', corner } : null;
    }
    const frame = this.screenFrame();
    if (!frame) return null;
    for (const handle of HANDLES) {
      const p = handlePoint(frame, handle);
      if (Math.abs(x - p.x) <= HANDLE_HIT && Math.abs(y - p.y) <= HANDLE_HIT) return { kind: 'resize', handle };
    }
    if (frame.rotate && Math.hypot(x - frame.rotate.x, y - frame.rotate.y) <= ROTATE_HIT) return { kind: 'rotate' };
    if (frame.rotate && !insidePolygon(frame.corners, x, y)) {
      for (const corner of frame.corners) {
        const distance = Math.hypot(x - corner.x, y - corner.y);
        if (distance > HANDLE_HIT && distance <= ROTATE_CORNER_ZONE) return { kind: 'rotate' };
      }
    }
    return null;
  }

  /** 节点本地坐标 → 屏幕坐标 */
  private localToScreen(id: NodeId): Matrix {
    const { camera } = this.editor;
    return multiply([camera.zoom, 0, 0, camera.zoom, camera.x, camera.y], worldTransform(this.editor.store, id));
  }

  /** 正在画布上调整填充时，手柄在屏幕上的位置；没在调整时返回 null */
  private fillHandles(): FillHandles | null {
    const { editor } = this;
    const editing = editor.fillEditing;
    if (!editing || editor.getState().tool !== 'select') return null;
    const node = editor.store.get(editing.id);
    const fill = node && 'fill' in node ? node.fill : null;
    if (!node || !fill) return null;
    const box = editor.geometry.localBounds(node);
    const m = this.localToScreen(node.id);
    const screen = (p: Point): Point => {
      const [x, y] = applyToPoint(m, p.x, p.y);
      return { x, y };
    };
    if (fill.type === 'gradient') {
      const points = gradientHandlePoints(fill, box);
      const stops = normalizeStops(fill.stops);
      const color = (i: number): string => (stops[i] ? toCssColor({ ...stops[i]!.color, a: 1 }) : '#fff');
      return {
        kind: 'gradient',
        start: screen(points.start),
        end: screen(points.end),
        aspect: points.aspect ? screen(points.aspect) : null,
        colors: [color(0), color(stops.length - 1)],
      };
    }
    if (fill.type === 'image') {
      const meta = editor.assets.meta(fill.assetId);
      if (!meta || !meta.width || !meta.height) return null;
      const rect = imageRect(fill, box, { width: meta.width, height: meta.height });
      return {
        kind: 'image',
        corners: [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.w, y: rect.y },
          { x: rect.x + rect.w, y: rect.y + rect.h },
          { x: rect.x, y: rect.y + rect.h },
        ].map(screen),
      };
    }
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

  /** 填充的手柄：渐变是起点到终点的连线和两头的圆点（填着首尾的颜色），图片是整张图的范围和四个角 */
  private drawFillHandles(handles: FillHandles): void {
    const { ctx, editor } = this;
    ctx.save();
    const dot = (p: Point, fill: string, radius = FILL_HANDLE_RADIUS): void => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      // 白色内圈加主题色外圈，在什么颜色上都看得清
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = editor.theme.accent;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    };
    const line = (a: Point, b: Point, dashed: boolean): void => {
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = editor.theme.accent;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (handles.kind === 'gradient') {
      line(handles.start, handles.end, false);
      if (handles.aspect) {
        line(handles.start, handles.aspect, true);
        dot(handles.aspect, editor.theme.handleFill, FILL_HANDLE_RADIUS - 2);
      }
      dot(handles.start, handles.colors[0]);
      dot(handles.end, handles.colors[1]);
    } else {
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = editor.theme.accent;
      strokePolygon(ctx, handles.corners);
      ctx.setLineDash([]);
      for (const corner of handles.corners) dot(corner, editor.theme.handleFill, FILL_HANDLE_RADIUS - 1);
    }
    ctx.restore();
  }

  /**
   * 选中的是蒙版组里的内容时，用虚线画出蒙版的轮廓：内容在蒙版外面的部分看不见，靠它知道露出来的范围
   */
  private drawMaskOutline(nodes: readonly SceneNode[]): void {
    const { ctx, editor } = this;
    const only = nodes.length === 1 ? nodes[0]! : null;
    const parent = only?.parent ? editor.store.get(only.parent) : undefined;
    if (!only || parent?.type !== 'group' || !parent.mask) return;
    const { mask } = maskParts(editor.store, parent);
    if (!mask?.visible || mask.id === only.id) return;
    const path = new Path2D(editor.geometry.outlineOf(mask).toSVGString());
    const m = this.localToScreen(mask.id);
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.strokeStyle = editor.theme.accent;
    ctx.stroke(path);
    ctx.restore();
  }

  /** 鼠标停着的对象（单击会选中的那个）用细线描出来；已经选中的不描 */
  private drawHover(): void {
    const { ctx, editor } = this;
    const id = editor.hover;
    const node = id ? editor.store.get(id) : undefined;
    if (!node || !node.visible || editor.selection.includes(node.id)) return;
    ctx.save();
    ctx.strokeStyle = editor.theme.accent;
    ctx.lineWidth = 1.5;
    if (hasShapeStyle(node) && node.type !== 'boolean') {
      // 形状描它自己的轮廓
      const path = new Path2D(editor.geometry.outlineOf(node).toSVGString());
      const m = this.localToScreen(node.id);
      const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.lineWidth = 1.5 / scale;
      ctx.stroke(path);
    } else {
      strokePolygon(ctx, this.nodeCorners(node));
    }
    ctx.restore();
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
    this.drawMaskOutline(nodes);

    const handles = this.fillHandles();
    if (handles) {
      this.drawFillHandles(handles);
    } else if (editor.getState().tool === 'select') {
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
      drawCornerWidgets(ctx, editor, null);
      // 按住 Alt 测距时不画尺寸标签，免得和距离的数字叠在一起
      if (editor.view.sizeLabel && !editor.measuring) this.drawSizeLabel(frame);
    }
    ctx.restore();
  }

  /** 选区框下面的"宽 × 高"：一个对象时是它自己的大小（转过角度也是），几个对象时是整体的外框 */
  private drawSizeLabel(frame: ScreenFrame): void {
    const { editor } = this;
    const world = editor.selectionFrame();
    if (!world) return;
    let w: number;
    let h: number;
    if (world.single) {
      const m = world.single.world;
      w = world.single.box.w * Math.hypot(m[0], m[1]);
      h = world.single.box.h * Math.hypot(m[2], m[3]);
    } else {
      const bounds = editor.selectionBounds();
      if (!bounds) return;
      w = bounds.w;
      h = bounds.h;
    }
    const bottom = frame.corners.reduce((best, p) => (p.y > best.y ? p : best), frame.corners[0]);
    const center = frame.corners.reduce((sum, p) => sum + p.x, 0) / 4;
    const x = Math.abs(frame.angle) < 1e-3 ? center : bottom.x;
    drawPill(this.ctx, `${formatNumber(w)} × ${formatNumber(h)}`, x, bottom.y + 14, editor.theme.accent);
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

/** 点在不在一个凸多边形（选区框可能是斜的）里面 */
function insidePolygon(points: readonly Point[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
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
