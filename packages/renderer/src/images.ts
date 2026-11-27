import type { CanvasKit, Image, Shader } from 'canvaskit-wasm';
import type { AssetStore, ImageFill, Rect } from '@shiba/core';

/**
 * 图片缓存：把资源库里的图片字节解码成 Skia 图片，用到时才解码，之后一直复用。
 *
 * 目前在主线程同步解码，够用但大图会卡一下；以后改成在 Worker 里解码并生成缩小的代理图。
 */
export class ImageCache {
  private images = new Map<string, Image>();
  /** 字节在手但解不出来的资源，记下来避免每一帧都重试 */
  private broken = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ck: CanvasKit,
    private readonly assets: AssetStore,
  ) {
    // 资源库整体替换（打开了另一个文件）后，旧的解码结果可能已经对不上了
    this.unsubscribe = assets.subscribe(() => {
      for (const [id, image] of this.images) {
        if (assets.has(id)) continue;
        image.delete();
        this.images.delete(id);
      }
      this.broken.clear();
    });
  }

  /** 解码后的图片；资源还没到或者解不出来时返回 null */
  get(assetId: string): Image | null {
    const cached = this.images.get(assetId);
    if (cached) return cached;
    if (this.broken.has(assetId)) return null;
    const bytes = this.assets.get(assetId);
    if (!bytes) return null;
    const image = this.decode(bytes);
    if (!image) {
      this.broken.add(assetId);
      return null;
    }
    this.images.set(assetId, image);
    return image;
  }

  /** 试着解码一段字节，只为了知道它是不是能用的图片以及尺寸 */
  probe(bytes: Uint8Array): { width: number; height: number } | null {
    const image = this.ck.MakeImageFromEncoded(bytes);
    if (!image) return null;
    const size = { width: image.width(), height: image.height() };
    image.delete();
    return size.width > 0 && size.height > 0 ? size : null;
  }

  dispose(): void {
    this.unsubscribe();
    for (const image of this.images.values()) image.delete();
    this.images.clear();
  }

  private decode(bytes: Uint8Array): Image | null {
    const decoded = this.ck.MakeImageFromEncoded(bytes);
    if (!decoded) return null;
    // 生成多级缩小图：画布缩得很小时图片不会出现锯齿和闪烁
    const withMipmaps = decoded.makeCopyWithDefaultMipmaps();
    decoded.delete();
    return withMipmaps;
  }
}

/** 图片在形状里的摆放：图片像素坐标 → 节点本地坐标的缩放和平移 */
export interface ImagePlacement {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

/**
 * 算出图片铺进一个矩形区域时的摆放。
 * 铺放方式决定基础的缩放；在此之上还可以再放大（zoom）并移动图片在框里的位置（panX / panY）。
 * @param box 要铺的区域，节点本地坐标
 */
export function placeImage(width: number, height: number, box: Rect, fill: ImageFill): ImagePlacement {
  let sx = box.w / width;
  let sy = box.h / height;
  if (fill.fit !== 'stretch') {
    const uniform = fill.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = uniform;
    sy = uniform;
  }
  const zoom = Math.max(1, fill.zoom ?? 1);
  sx *= zoom;
  sy *= zoom;
  // 图片比框大（或小）出来的那部分就是可以移动的余量：pan 为 ±1 时正好移到头
  const slackX = box.w - width * sx;
  const slackY = box.h - height * sy;
  return {
    sx,
    sy,
    tx: box.x + slackX / 2 + (clampUnit(fill.panX) * Math.abs(slackX)) / 2,
    ty: box.y + slackY / 2 + (clampUnit(fill.panY) * Math.abs(slackY)) / 2,
  };
}

/**
 * 把图片铺进一个矩形区域的着色器，摆放见 placeImage。调用方用完要 delete。
 * @param box 要铺的区域，节点本地坐标
 */
export function makeImageShader(ck: CanvasKit, image: Image, box: Rect, fill: ImageFill): Shader {
  const { sx, sy, tx, ty } = placeImage(image.width(), image.height(), box, fill);
  // contain 模式下图片四周可能留空，留空处应该透明；其余模式用边缘延伸，避免边界出现半透明的缝
  const tile = fill.fit === 'contain' ? ck.TileMode.Decal : ck.TileMode.Clamp;
  const matrix = [sx, 0, tx, 0, sy, ty, 0, 0, 1];
  return image.makeShaderOptions(tile, tile, ck.FilterMode.Linear, ck.MipmapMode.Linear, matrix);
}

function clampUnit(value: number | undefined): number {
  return Math.max(-1, Math.min(1, value ?? 0));
}
