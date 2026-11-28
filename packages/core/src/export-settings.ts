/**
 * 导出设置：对象和画框、画板上可以记几条"导出成什么"（倍率、格式、文件名后缀），存进文档。
 * 文件菜单的"导出全部…"一次把所有设置了导出的对象导出来，打成一个 ZIP
 */

export const EXPORT_FORMATS = ['png', 'jpeg', 'svg', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportSetting {
  /** 倍率，1 表示一个文档单位一个像素。SVG、PDF 是矢量，不看倍率 */
  scale: number;
  format: ExportFormat;
  /** 文件名后缀，加在名字后面（比如 @2x）。省略时按倍率自动加 */
  suffix?: string;
}

export const MAX_EXPORTS = 16;
export const EXPORT_SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

/** 一条导出设置对应的文件名：名字 + 后缀 + 扩展名。没写后缀时，倍率不是 1 的位图加上 @2x 这样的后缀 */
export function exportFileName(name: string, setting: ExportSetting): string {
  const vector = setting.format === 'svg' || setting.format === 'pdf';
  const suffix = setting.suffix ?? (vector || setting.scale === 1 ? '' : `@${setting.scale}x`);
  const extension = setting.format === 'jpeg' ? 'jpg' : setting.format;
  return `${name}${suffix}.${extension}`;
}

export function isExportList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_EXPORTS) return false;
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const e = item as Record<string, unknown>;
    return (
      typeof e.scale === 'number' &&
      Number.isFinite(e.scale) &&
      e.scale > 0 &&
      e.scale <= 8 &&
      (EXPORT_FORMATS as readonly unknown[]).includes(e.format) &&
      (e.suffix === undefined || (typeof e.suffix === 'string' && e.suffix.length <= 64))
    );
  });
}
