import type { Canvas, CanvasKit, GrDirectContext, Paint, SkPicture, Surface } from 'canvaskit-wasm';
import {
  IDENTITY,
  hasShapeStyle,
  invert,
  multiply,
  rectsIntersect,
  transformRect,
  worldTransform,
  type Color,
  type DocStore,
  type Matrix,
  type NodeId,
  type Rect,
  type SceneNode,
} from '@shiba/core';
import type { GeometryCache } from './geometry';
import { makeImageShader, type ImageCache } from './images';
import type { DrawContext, NodeTypeDef, NodeTypeRegistry } from './node-types';
import { toSkBlendMode, toSkColor, toSkMatrix } from './skia';

/** 屏幕坐标 = 世界坐标 × zoom + (x, y)，单位是 CSS 像素 */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface FrameOptions {
  background: Color;
  /** 只绘制这些节点及其后代。幻灯片视图里就是当前画板 */
  roots: readonly NodeId[];
}

export interface FrameStats {
  /** 实际绘制的节点数（被视口裁掉的不算） */
  drawn: number;
  /** 这一帧在 JS 侧花的时间，毫秒 */
  ms: number;
  /** 这一帧是否直接回放了场景缓存 */
  cached: boolean;
}

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA，未预乘 */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * 场景渲染器。只负责把文档画到画布上，不知道选区、工具这些编辑概念。
 * 节点怎么画由 NodeTypeRegistry 决定。
 */
export class Renderer {
  private surface: Surface | null = null;
  private grContext: GrDirectContext | null = null;
  private triedGL = false;
  private dpr = 1;
  private readonly paint: Paint;
  private readonly layerPaint: Paint;
  private drawn = 0;
  private cache: { version: number; roots: string; picture: SkPicture; count: number } | null = null;
  private lastVersion = -1;
  private lastRoots = '';
  stats: FrameStats = { drawn: 0, ms: 0, cached: false };
  /** 'webgl' 或 'software'，在第一次 resize 之后才有值 */
  backend: 'webgl' | 'software' | null = null;

  constructor(
    private readonly ck: CanvasKit,
    private readonly element: HTMLCanvasElement,
    private readonly store: DocStore,
    private readonly registry: NodeTypeRegistry,
    private readonly geometry: GeometryCache,
    private readonly images: ImageCache | null = null,
  ) {
    this.paint = new ck.Paint();
    this.paint.setAntiAlias(true);
    this.layerPaint = new ck.Paint();
  }

  /** 画布尺寸变化时调用；宽高是 CSS 像素 */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    this.dpr = dpr;
    if (this.surface && this.element.width === width && this.element.height === height) return;
    this.element.width = width;
    this.element.height = height;
    this.surface?.delete();
    this.surface = this.createSurface(width, height);
  }

  render(camera: Camera, options: FrameOptions): void {
    const surface = this.surface;
    if (!surface) return;
    const start = performance.now();
    this.drawn = 0;
    const canvas = surface.getCanvas();
    canvas.clear(toSkColor(this.ck, options.background));
    canvas.save();
    canvas.scale(this.dpr, this.dpr);
    canvas.translate(camera.x, camera.y);
    canvas.scale(camera.zoom, camera.zoom);

    // 场景缓存。只动相机（平移、缩放）时文档没变，直接回放上次录好的图片，
    // 省掉逐节点遍历的全部 JS 开销；录制时让 Skia 建好空间索引，回放时自动跳过视口外的内容。
    // 文档正在连续变化（比如拖动对象）时不录制，否则每帧都要白录一次。
    const rootsKey = options.roots.join(',');
    const version = this.store.version;
    const cached = this.cache?.version === version && this.cache.roots === rootsKey ? this.cache : null;
    const stable = this.lastVersion === version && this.lastRoots === rootsKey;
    this.lastVersion = version;
    this.lastRoots = rootsKey;

    if (cached) {
      canvas.drawPicture(cached.picture);
      this.drawn = cached.count;
    } else if (stable) {
      const recorder = new this.ck.PictureRecorder();
      this.drawRoots(recorder.beginRecording(this.ck.LTRBRect(-1e7, -1e7, 1e7, 1e7), true), options.roots, null);
      const picture = recorder.finishRecordingAsPicture();
      recorder.delete();
      this.cache?.picture.delete();
      this.cache = { version, roots: rootsKey, picture, count: this.drawn };
      canvas.drawPicture(picture);
    } else {
      this.drawRoots(canvas, options.roots, {
        x: -camera.x / camera.zoom,
        y: -camera.y / camera.zoom,
        w: this.element.width / this.dpr / camera.zoom,
        h: this.element.height / this.dpr / camera.zoom,
      });
    }

    canvas.restore();
    surface.flush();
    this.stats = { drawn: this.drawn, ms: performance.now() - start, cached: cached !== null };
  }

  private drawRoots(canvas: Canvas, roots: readonly NodeId[], viewport: Rect | null): void {
    for (const id of roots) {
      const node = this.store.get(id);
      if (!node) continue;
      const parentWorld = node.parent ? worldTransform(this.store, node.parent) : IDENTITY;
      canvas.save();
      canvas.concat(toSkMatrix(parentWorld));
      this.drawNode(canvas, node, parentWorld, viewport);
      canvas.restore();
    }
  }

  /**
   * 把一个节点单独画成位图（缩略图用）。
   * 节点被放在原点，等比缩放到不超过给定尺寸。
   */
  renderToBitmap(id: NodeId, maxWidth: number, maxHeight: number): Bitmap | null {
    const node = this.store.get(id);
    if (!node) return null;
    const bounds = this.geometry.localBounds(node);
    if (bounds.w <= 0 || bounds.h <= 0) return null;
    const raster = this.rasterize(node, bounds, Math.min(maxWidth / bounds.w, maxHeight / bounds.h));
    if (!raster) return null;
    const { ck } = this;
    const image = raster.surface.makeImageSnapshot();
    const pixels = image.readPixels(0, 0, {
      width: raster.width,
      height: raster.height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    image.delete();
    raster.surface.delete();
    if (!pixels) return null;
    return { width: raster.width, height: raster.height, data: new Uint8ClampedArray(pixels) };
  }

  /**
   * 把一个节点导出成 PNG 文件的字节。
   * @param scale 导出倍率，1 表示一个文档单位对应一个像素
   * @returns 节点为空、或导出尺寸超过上限时返回 null
   */
  renderToPng(id: NodeId, scale: number): Uint8Array | null {
    const node = this.store.get(id);
    if (!node) return null;
    const bounds = this.geometry.localBounds(node);
    if (bounds.w <= 0 || bounds.h <= 0) return null;
    if (bounds.w * scale > MAX_EXPORT_SIZE || bounds.h * scale > MAX_EXPORT_SIZE) return null;
    const raster = this.rasterize(node, bounds, scale);
    if (!raster) return null;
    const image = raster.surface.makeImageSnapshot();
    const bytes = image.encodeToBytes();
    image.delete();
    raster.surface.delete();
    // 编码结果在 WASM 内存里，拷出来再返回，免得之后被覆盖
    return bytes ? bytes.slice() : null;
  }

  private rasterize(
    node: SceneNode,
    bounds: Rect,
    scale: number,
  ): { surface: Surface; width: number; height: number } | null {
    const width = Math.max(1, Math.round(bounds.w * scale));
    const height = Math.max(1, Math.round(bounds.h * scale));
    const surface = this.ck.MakeSurface(width, height);
    if (!surface) return null;
    const canvas = surface.getCanvas();
    canvas.clear(this.ck.TRANSPARENT);
    canvas.scale(scale, scale);
    canvas.translate(-bounds.x, -bounds.y);
    const inverse = invert(node.transform);
    if (inverse) canvas.concat(toSkMatrix(inverse));
    this.drawNode(canvas, node, IDENTITY, null);
    return { surface, width, height };
  }

  /** 丢弃场景缓存。文档没变但画面该变的时候调用，比如字体加载完成 */
  invalidate(): void {
    this.cache?.picture.delete();
    this.cache = null;
    this.lastVersion = -1;
  }

  dispose(): void {
    this.cache?.picture.delete();
    this.cache = null;
    this.surface?.delete();
    this.surface = null;
    this.grContext?.delete();
    this.grContext = null;
    this.paint.delete();
    this.layerPaint.delete();
  }

  private createSurface(width: number, height: number): Surface | null {
    const { ck } = this;
    if (!this.triedGL) {
      this.triedGL = true;
      try {
        const handle = ck.GetWebGLContext(this.element);
        this.grContext = handle ? ck.MakeWebGLContext(handle) : null;
      } catch {
        this.grContext = null;
      }
    }
    if (this.grContext) {
      const surface = ck.MakeOnScreenGLSurface(this.grContext, width, height, ck.ColorSpace.SRGB);
      if (surface) {
        this.backend = 'webgl';
        return surface;
      }
    }
    this.backend = 'software';
    return ck.MakeSWCanvasSurface(this.element);
  }

  /**
   * @param parentWorld 父节点的世界变换，只用来做视口裁剪
   * @param viewport 世界坐标下的可见区域；为 null 时不裁剪
   */
  private drawNode(canvas: Canvas, node: SceneNode, parentWorld: Matrix, viewport: Rect | null): void {
    if (!node.visible) return;
    const def = this.registry.get(node.type);
    if (!def) return;
    const world = multiply(parentWorld, node.transform);
    const isContainer = def.children === 'draw' || def.children === 'clip';

    if (viewport && def.children !== 'draw') {
      const local = this.geometry.localBounds(node);
      const pad = hasShapeStyle(node) && node.stroke ? node.stroke.width : 0;
      const padded = { x: local.x - pad, y: local.y - pad, w: local.w + pad * 2, h: local.h + pad * 2 };
      if (!rectsIntersect(transformRect(world, padded), viewport)) return;
    }

    const { ck } = this;
    canvas.save();
    canvas.concat(toSkMatrix(node.transform));

    const special = node.opacity < 1 || node.blendMode !== 'normal';
    const layered = special && (isContainer || def.draw !== undefined || paintCount(node) > 1);
    if (layered) {
      this.layerPaint.setAlphaf(node.opacity);
      this.layerPaint.setBlendMode(toSkBlendMode(ck, node.blendMode));
      canvas.saveLayer(this.layerPaint);
    }

    const outline = this.geometry.outlineOf(node);
    const ctx: DrawContext = {
      ck,
      canvas,
      outline,
      paint: this.paint,
      opacity: layered ? 1 : node.opacity,
      blendMode: layered ? ck.BlendMode.SrcOver : toSkBlendMode(ck, node.blendMode),
      images: this.images,
      bounds: () => this.geometry.localBounds(node),
    };
    this.drawn += 1;
    if (def.draw) (def as NodeTypeDef).draw!(node, ctx);
    else drawShape(node, ctx);

    if (isContainer) {
      if (def.children === 'clip') canvas.clipPath(outline, ck.ClipOp.Intersect, true);
      for (const child of this.store.children(node.id)) this.drawNode(canvas, child, world, viewport);
    }

    if (layered) canvas.restore();
    canvas.restore();
  }
}

const MAX_EXPORT_SIZE = 8192;
const MISSING_IMAGE_COLOR: Color = { r: 0.82, g: 0.83, b: 0.85, a: 1 };

function paintCount(node: SceneNode): number {
  if (!hasShapeStyle(node)) return 0;
  return (node.fill ? 1 : 0) + (node.stroke && node.stroke.width > 0 ? 1 : 0);
}

/** 默认绘制：先填充，再描边（描边居中） */
function drawShape(node: SceneNode, ctx: DrawContext): void {
  if (!hasShapeStyle(node)) return;
  const { ck, canvas, outline, paint } = ctx;
  paint.setBlendMode(ctx.blendMode);
  if (node.fill?.type === 'solid') {
    paint.setStyle(ck.PaintStyle.Fill);
    paint.setColor(toSkColor(ck, node.fill.color, ctx.opacity));
    canvas.drawPath(outline, paint);
  } else if (node.fill?.type === 'image') {
    paint.setStyle(ck.PaintStyle.Fill);
    const image = ctx.images?.get(node.fill.assetId) ?? null;
    if (image) {
      // 着色器决定每个点的颜色，画笔的颜色只贡献不透明度
      const shader = makeImageShader(ck, image, ctx.bounds(), node.fill.fit);
      paint.setColor(ck.Color4f(1, 1, 1, ctx.opacity));
      paint.setShader(shader);
      canvas.drawPath(outline, paint);
      paint.setShader(null);
      shader.delete();
    } else {
      // 图片还没到，或者文件里缺了这张图：画一块浅灰占位，让用户看得出这里有东西
      paint.setColor(toSkColor(ck, MISSING_IMAGE_COLOR, ctx.opacity));
      canvas.drawPath(outline, paint);
    }
  }
  if (node.stroke && node.stroke.width > 0) {
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(node.stroke.width);
    paint.setColor(toSkColor(ck, node.stroke.color, ctx.opacity));
    canvas.drawPath(outline, paint);
  }
}
