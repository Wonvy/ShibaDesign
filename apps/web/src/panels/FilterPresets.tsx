import { useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IMAGE_PRESETS, type ImageFill } from '@shiba/core';
import type { Editor } from '@shiba/editor';
import { useEditorState } from '../editor/context';

/** 缩略图的边长：显示 52 像素，按两倍画 */
const THUMB = 104;
/** 最多缓存几张图片的缩略图 */
const CACHE_LIMIT = 24;

/**
 * 缩略图缓存：图片资源按内容寻址，同一个 id 永远是同一张图，所以按 id 缓存就行。
 * 每张图片一组：原图和每个预设各一张（null 表示原图）
 */
const cache = new Map<string, Map<string | null, ImageData>>();

function thumbnails(editor: Editor, assetId: string): Map<string | null, ImageData> | null {
  const hit = cache.get(assetId);
  if (hit) return hit;
  const base: ImageFill = { type: 'image', assetId, fit: 'cover' };
  const out = new Map<string | null, ImageData>();
  for (const preset of [null, ...IMAGE_PRESETS.map((p) => p.id)]) {
    const fill = preset ? { ...base, filter: { preset, amount: 100 } } : base;
    const bitmap = editor.imagePreview(fill, THUMB, THUMB);
    // 图片还没解码好：先不缓存，资源到了会重画
    if (!bitmap) return null;
    out.set(preset, new ImageData(bitmap.data, bitmap.width, bitmap.height));
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(assetId, out);
  return out;
}

function Thumbnail(props: { image: ImageData | undefined }): ReactNode {
  const { image } = props;
  const draw = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas && image) canvas.getContext('2d')?.putImageData(image, 0, 0);
    },
    [image],
  );
  return <canvas ref={draw} className="preset-thumb" width={THUMB} height={THUMB} aria-hidden />;
}

/**
 * 滤镜预设：每个预设一个缩略图（这张图套上预设、强度 100 的样子），第一个是原图。
 * 点一下选中，再点"原图"去掉滤镜
 */
export function FilterPresets(props: {
  editor: Editor;
  fill: ImageFill;
  onSelect: (preset: string | null) => void;
}): ReactNode {
  const { t } = useTranslation();
  const { editor, fill, onSelect } = props;
  // 图片解码好之后资源版本会变，缩略图跟着重画
  const resourceEpoch = useEditorState((s) => s.resourceEpoch);
  const thumbs = useMemo(
    () => (resourceEpoch >= 0 ? thumbnails(editor, fill.assetId) : null),
    [editor, fill.assetId, resourceEpoch],
  );
  const current = fill.filter?.preset ?? null;

  return (
    <div className="preset-grid" role="radiogroup" aria-label={t('adjust.filter')}>
      {[null, ...IMAGE_PRESETS.map((p) => p.id)].map((preset) => (
        <button
          key={preset ?? 'none'}
          type="button"
          role="radio"
          aria-checked={current === preset}
          className={`preset${current === preset ? ' is-active' : ''}`}
          onClick={() => onSelect(preset)}
        >
          <Thumbnail image={thumbs?.get(preset)} />
          <span className="preset-name">{t(preset ? `imagePreset.${preset}` : 'adjust.filterNone')}</span>
        </button>
      ))}
    </div>
  );
}
