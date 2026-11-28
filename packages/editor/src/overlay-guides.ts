import { clickInteraction, stripeBands, toCssColor, type Rect } from '@shiba/core';
import type { Editor } from './editor';
import { RULER_SIZE, rulerStep } from './guides';
import { measureBetween, type SpacingMark } from './snap';

/**
 * 覆盖层上和对齐有关的东西：像素格、辅助线、智能参考线和等间距标记、按住 Alt 测距、标尺。
 * 全部画在屏幕坐标里（CSS 像素）
 */

const LABEL_FONT = '11px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const SNAP_COLOR = '#e8338a';
const GUIDE_COLOR = '#0ea5e9';
/** 放大到这个倍数以上画像素格 */
const PIXEL_GRID_ZOOM = 8;

/** 数字的写法：整数不带小数，别的保留一位 */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 一个带底色的小标签，中心在 (x, y) */
export function drawPill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string): void {
  ctx.save();
  ctx.font = LABEL_FONT;
  const width = ctx.measureText(text).width + 8;
  const height = 16;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(Math.round(x - width / 2), Math.round(y - height / 2), width, height, 3);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, Math.round(x), Math.round(y) + 0.5);
  ctx.restore();
}

export function drawPixelGrid(ctx: CanvasRenderingContext2D, editor: Editor): void {
  const zoom = editor.camera.zoom;
  if (!editor.view.pixelGrid || zoom < PIXEL_GRID_ZOOM) return;
  const { width, height } = editor.viewport;
  const topLeft = editor.screenToWorld(0, 0);
  const bottomRight = editor.screenToWorld(width, height);
  ctx.save();
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.floor(topLeft.x); x <= bottomRight.x; x++) {
    const sx = Math.round(editor.worldToScreen(x, 0).x) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
  }
  for (let y = Math.floor(topLeft.y); y <= bottomRight.y; y++) {
    const sy = Math.round(editor.worldToScreen(0, y).y) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * 画框和画板上的版面网格：列和行画成半透明的色带，方格画成细线，都裁在容器里面。
 * 容器转过角度时网格跟着转（直接把容器的变换叠到画布上画）
 */
export function drawLayoutGrids(ctx: CanvasRenderingContext2D, editor: Editor): void {
  if (!editor.view.layoutGrids) return;
  const { zoom, x: camX, y: camY } = editor.camera;
  for (const { node, world, grids } of editor.layoutGridContainers()) {
    const [w, h] = node.size;
    ctx.save();
    // 本地坐标 → 屏幕坐标：相机乘上容器的世界变换
    ctx.transform(
      zoom * world[0],
      zoom * world[1],
      zoom * world[2],
      zoom * world[3],
      zoom * world[4] + camX,
      zoom * world[5] + camY,
    );
    const scale = Math.hypot(zoom * world[0], zoom * world[1]) || 1;
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    for (const grid of grids) {
      const { r, g, b, a } = grid.color;
      const rgb = `${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}`;
      if (grid.type === 'grid') {
        // 方格太密时（屏幕上不到 4 像素）不画
        if (grid.size * scale < 4) continue;
        // 细线比色带淡得看不清，透明度放大一些
        ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, a * 3)})`;
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        for (let x = grid.size; x < w; x += grid.size) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        }
        for (let y = grid.size; y < h; y += grid.size) {
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
        }
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = `rgba(${rgb}, ${a})`;
      const columns = grid.type === 'columns';
      for (const band of stripeBands(grid, columns ? w : h)) {
        if (columns) ctx.fillRect(band.start, 0, band.size, h);
        else ctx.fillRect(0, band.start, w, band.size);
      }
    }
    ctx.restore();
  }
}

/**
 * 原型的连线：选中的对象点击时跳到另一页、而那一页在画布上看得见时，从对象右边画一条弯曲的箭头连到那一页的左边
 */
export function drawPrototypeLinks(ctx: CanvasRenderingContext2D, editor: Editor): void {
  if (editor.viewMode !== 'canvas') return;
  for (const node of editor.selectedNodes()) {
    const interaction = clickInteraction(node);
    if (interaction?.action.type !== 'navigate') continue;
    const target = editor.store.get(interaction.action.target);
    if (!target || !target.visible) continue;
    const from = editor.geometry.worldBounds(node);
    const to = editor.geometry.worldBounds(target);
    const a = editor.worldToScreen(from.x + from.w, from.y + from.h / 2);
    const b = editor.worldToScreen(to.x, to.y + Math.min(to.h / 2, 60 * (1 / editor.camera.zoom)));
    const bend = Math.max(40, Math.abs(b.x - a.x) / 2);
    ctx.save();
    ctx.strokeStyle = editor.theme.accent;
    ctx.fillStyle = editor.theme.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(a.x + bend, a.y, b.x - bend, b.y, b.x - 6, b.y);
    ctx.stroke();
    // 箭头
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 9, b.y - 5);
    ctx.lineTo(b.x - 9, b.y + 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

export function drawGuides(ctx: CanvasRenderingContext2D, editor: Editor): void {
  if (!editor.view.guides) return;
  const color = editor.theme.guide ?? GUIDE_COLOR;
  const { width, height } = editor.viewport;
  const selected = editor.guides.selection;
  const line = (axis: 'x' | 'y', value: number, range: Rect | null, highlight: boolean): void => {
    ctx.strokeStyle = highlight ? (editor.theme.snap ?? SNAP_COLOR) : color;
    ctx.beginPath();
    if (axis === 'x') {
      const x = Math.round(editor.worldToScreen(value, 0).x) + 0.5;
      const from = range ? editor.worldToScreen(0, range.y).y : 0;
      const to = range ? editor.worldToScreen(0, range.y + range.h).y : height;
      ctx.moveTo(x, from);
      ctx.lineTo(x, to);
    } else {
      const y = Math.round(editor.worldToScreen(0, value).y) + 0.5;
      const from = range ? editor.worldToScreen(range.x, 0).x : 0;
      const to = range ? editor.worldToScreen(range.x + range.w, 0).x : width;
      ctx.moveTo(from, y);
      ctx.lineTo(to, y);
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.lineWidth = 1;
  for (const guide of editor.worldGuides()) {
    const isSelected = selected?.id === guide.id && selected.container === guide.container;
    line(guide.axis, guide.value, guide.range, isSelected);
  }
  const pending = editor.guides.pending;
  if (pending) line(pending.axis, pending.value, null, false);
  ctx.restore();
}

/** 一段距离：两头带短横的线，中间一个数字 */
function drawSpan(ctx: CanvasRenderingContext2D, editor: Editor, mark: SpacingMark, color: string): void {
  const a = mark.axis === 'x' ? editor.worldToScreen(mark.start, mark.at) : editor.worldToScreen(mark.at, mark.start);
  const b = mark.axis === 'x' ? editor.worldToScreen(mark.end, mark.at) : editor.worldToScreen(mark.at, mark.end);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  const tick = 4;
  if (mark.axis === 'x') {
    ctx.moveTo(a.x, a.y - tick);
    ctx.lineTo(a.x, a.y + tick);
    ctx.moveTo(b.x, b.y - tick);
    ctx.lineTo(b.x, b.y + tick);
  } else {
    ctx.moveTo(a.x - tick, a.y);
    ctx.lineTo(a.x + tick, a.y);
    ctx.moveTo(b.x - tick, b.y);
    ctx.lineTo(b.x + tick, b.y);
  }
  ctx.stroke();
  ctx.restore();
  drawPill(ctx, formatNumber(Math.abs(mark.end - mark.start)), (a.x + b.x) / 2, (a.y + b.y) / 2, color);
}

/** 拖动时的智能参考线（两头画小叉）和等间距标记 */
export function drawSnapFeedback(ctx: CanvasRenderingContext2D, editor: Editor): void {
  const feedback = editor.snapFeedback;
  if (!feedback) return;
  const color = editor.theme.snap ?? SNAP_COLOR;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (const line of feedback.lines) {
    const a = line.axis === 'x' ? editor.worldToScreen(line.at, line.from) : editor.worldToScreen(line.from, line.at);
    const b = line.axis === 'x' ? editor.worldToScreen(line.at, line.to) : editor.worldToScreen(line.to, line.at);
    const ax = Math.round(a.x) + 0.5;
    const ay = Math.round(a.y) + 0.5;
    const bx = Math.round(b.x) + 0.5;
    const by = Math.round(b.y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    const cross = 3;
    for (const [x, y] of [
      [ax, ay],
      [bx, by],
    ] as const) {
      ctx.moveTo(x - cross, y - cross);
      ctx.lineTo(x + cross, y + cross);
      ctx.moveTo(x + cross, y - cross);
      ctx.lineTo(x - cross, y + cross);
    }
    ctx.stroke();
  }
  ctx.restore();
  for (const mark of feedback.spacing) drawSpan(ctx, editor, mark, color);
}

/**
 * 按住 Alt 测距：选中的对象到鼠标下的对象（没有时到所在的画板）上下左右的距离，目标用虚线框出来
 */
export function drawMeasure(ctx: CanvasRenderingContext2D, editor: Editor): void {
  if (!editor.measuring) return;
  const from = editor.selectionBounds();
  if (!from) return;
  const hover = editor.hover ? editor.store.get(editor.hover) : undefined;
  let target: Rect | null = null;
  if (hover && !editor.selection.includes(hover.id)) target = editor.geometry.worldBounds(hover);
  else {
    const first = editor.selectedNodes()[0];
    let board = first?.parent ? editor.store.get(first.parent) : undefined;
    while (board && board.type !== 'artboard') board = board.parent ? editor.store.get(board.parent) : undefined;
    if (board) target = editor.geometry.worldBounds(board);
  }
  if (!target) return;
  const color = editor.theme.snap ?? SNAP_COLOR;
  const a = editor.worldToScreen(target.x, target.y);
  const b = editor.worldToScreen(target.x + target.w, target.y + target.h);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
  ctx.restore();
  for (const mark of measureBetween(from, target)) drawSpan(ctx, editor, mark, color);
}

/** 上边和左边的标尺：刻度、数字，选中对象的范围用浅色标出来 */
export function drawRulers(ctx: CanvasRenderingContext2D, editor: Editor): void {
  if (!editor.view.rulers) return;
  const { width, height } = editor.viewport;
  const zoom = editor.camera.zoom;
  const fill = editor.theme.rulerFill ?? toCssColor(editor.theme.background);
  const lineColor = editor.theme.rulerLine ?? editor.theme.label;
  const text = editor.theme.label;
  const origin = editor.guides.origin();
  const { major, minor } = rulerStep(zoom);
  const selection = editor.selectionBounds();

  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, width, RULER_SIZE);
  ctx.fillRect(0, 0, RULER_SIZE, height);

  // 选中对象的范围
  if (selection) {
    ctx.fillStyle = editor.theme.accent;
    ctx.globalAlpha = 0.18;
    const a = editor.worldToScreen(selection.x, selection.y);
    const b = editor.worldToScreen(selection.x + selection.w, selection.y + selection.h);
    ctx.fillRect(Math.max(RULER_SIZE, a.x), 0, b.x - Math.max(RULER_SIZE, a.x), RULER_SIZE);
    ctx.fillRect(0, Math.max(RULER_SIZE, a.y), RULER_SIZE, b.y - Math.max(RULER_SIZE, a.y));
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = lineColor;
  ctx.fillStyle = text;
  ctx.font = LABEL_FONT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // 上边：x 方向
  const left = editor.screenToWorld(RULER_SIZE, 0).x - origin.x;
  const right = editor.screenToWorld(width, 0).x - origin.x;
  for (let v = Math.floor(left / minor) * minor; v <= right; v += minor) {
    const x = Math.round(editor.worldToScreen(v + origin.x, 0).x) + 0.5;
    if (x < RULER_SIZE) continue;
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    ctx.moveTo(x, isMajor ? 0 : RULER_SIZE - 5);
    ctx.lineTo(x, RULER_SIZE);
    if (isMajor) ctx.fillText(formatNumber(v), x + 3, 10);
  }
  // 左边：y 方向，数字竖着写
  const top = editor.screenToWorld(0, RULER_SIZE).y - origin.y;
  const bottom = editor.screenToWorld(0, height).y - origin.y;
  for (let v = Math.floor(top / minor) * minor; v <= bottom; v += minor) {
    const y = Math.round(editor.worldToScreen(0, v + origin.y).y) + 0.5;
    if (y < RULER_SIZE) continue;
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    ctx.moveTo(isMajor ? 0 : RULER_SIZE - 5, y);
    ctx.lineTo(RULER_SIZE, y);
    if (isMajor) {
      ctx.save();
      ctx.translate(10, y + 3);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(formatNumber(v), 0, 0);
      ctx.restore();
    }
  }
  // 标尺和画布之间的分隔线
  ctx.moveTo(RULER_SIZE, RULER_SIZE + 0.5);
  ctx.lineTo(width, RULER_SIZE + 0.5);
  ctx.moveTo(RULER_SIZE + 0.5, RULER_SIZE);
  ctx.lineTo(RULER_SIZE + 0.5, height);
  ctx.stroke();
  // 左上角的空白
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);
  ctx.restore();
}
