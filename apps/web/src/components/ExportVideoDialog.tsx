import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor } from '../editor/context';
import { exportVideo } from '../files';
import {
  DEFAULT_VIDEO,
  GIF_FPS,
  GIF_SIZES,
  MP4_FPS,
  MP4_SIZES,
  canEncodeVideo,
  firstSlideSize,
  videoSize,
  type VideoFormat,
  type VideoSettings,
} from '../present/video-settings';
import { Dialog, DialogOption } from '../ui/Dialog';

/** 上次的设置记在浏览器里，下次打开还是它 */
const STORAGE_KEY = 'shiba.videoExport';

const choices = (format: VideoFormat): { sizes: number[]; fps: number[] } =>
  format === 'mp4' ? { sizes: MP4_SIZES, fps: MP4_FPS } : { sizes: GIF_SIZES, fps: GIF_FPS };

/** 换格式、或者存下来的值不在可选范围里时，改成这个格式的默认值 */
function normalize(settings: VideoSettings): VideoSettings {
  const { sizes, fps } = choices(settings.format);
  const seconds = (value: number, fallback: number, max: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
  return {
    format: settings.format,
    size: sizes.includes(settings.size) ? settings.size : sizes[0]!,
    fps: fps.includes(settings.fps) ? settings.fps : fps[0]!,
    dwell: seconds(settings.dwell, DEFAULT_VIDEO.dwell, 60),
    clickDelay: seconds(settings.clickDelay, DEFAULT_VIDEO.clickDelay, 30),
  };
}

function load(): VideoSettings {
  let saved: Partial<VideoSettings> | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<VideoSettings> | null;
  } catch {
    saved = null;
  }
  const format: VideoFormat = saved?.format === 'gif' || !canEncodeVideo() ? 'gif' : 'mp4';
  return normalize({ ...DEFAULT_VIDEO, ...saved, format });
}

function save(settings: VideoSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式下存不了，下次用默认值
  }
}

/** 导出视频的设置：格式、画面大小、帧率、每页停多久、单击的动画多久自动接上 */
export function ExportVideoDialog(props: { onClose: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const { onClose } = props;
  const slide = useMemo(() => firstSlideSize(editor), [editor]);
  const [settings, setSettings] = useState<VideoSettings>(load);
  const set = (patch: Partial<VideoSettings>): void => setSettings((s) => normalize({ ...s, ...patch }));
  const encoder = canEncodeVideo();
  const { sizes, fps } = choices(settings.format);

  const sizeLabel = (size: number): string => {
    if (!slide) return String(size);
    const { width, height } = videoSize(slide, settings.format, size);
    return `${width} × ${height}`;
  };

  const seconds = (key: 'dwell' | 'clickDelay', max: number): ReactNode => (
    <label className="dialog-row">
      <span className="dialog-option-text">
        <span>{t(`videoExport.${key}`)}</span>
        <span className="dialog-hint">{t(`videoExport.${key}Hint`)}</span>
      </span>
      <span className="field dialog-number">
        <input
          className="field-input"
          type="number"
          min={0}
          max={max}
          step={0.5}
          value={settings[key]}
          onChange={(event) => {
            const value = event.target.valueAsNumber;
            if (Number.isFinite(value)) set({ [key]: value });
          }}
        />
        <span className="field-suffix">{t('videoExport.seconds')}</span>
      </span>
    </label>
  );

  return (
    <Dialog
      title={t('videoExport.title')}
      submitLabel={t('videoExport.export')}
      cancelLabel={t('videoExport.cancel')}
      onClose={onClose}
      onSubmit={() => {
        save(settings);
        onClose();
        // 保存位置的对话框只能在用户刚点过按钮时弹出，所以直接在这一下里开始导出
        void exportVideo(editor, settings);
      }}
    >
      <fieldset className="dialog-field">
        <legend>{t('videoExport.format')}</legend>
        <DialogOption
          name="format"
          checked={settings.format === 'mp4'}
          onSelect={() => set({ format: 'mp4' })}
          label={t('videoExport.mp4')}
          hint={encoder ? t('videoExport.mp4Hint') : t('videoExport.noEncoder')}
          disabled={!encoder}
        />
        <DialogOption
          name="format"
          checked={settings.format === 'gif'}
          onSelect={() => set({ format: 'gif' })}
          label={t('videoExport.gif')}
          hint={t('videoExport.gifHint')}
        />
      </fieldset>
      <fieldset className="dialog-field">
        <legend>{t('videoExport.size')}</legend>
        <div className="segmented segmented-small" role="radiogroup" aria-label={t('videoExport.size')}>
          {sizes.map((size) => (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={settings.size === size}
              className={settings.size === size ? 'is-active' : ''}
              onClick={() => set({ size })}
            >
              {sizeLabel(size)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="dialog-field">
        <legend>{t('videoExport.fps')}</legend>
        <div className="segmented segmented-small" role="radiogroup" aria-label={t('videoExport.fps')}>
          {fps.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={settings.fps === value}
              className={settings.fps === value ? 'is-active' : ''}
              onClick={() => set({ fps: value })}
            >
              {t('videoExport.fpsValue', { fps: value })}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="dialog-field">
        <legend>{t('videoExport.timing')}</legend>
        {seconds('dwell', 60)}
        {seconds('clickDelay', 30)}
      </fieldset>
    </Dialog>
  );
}
