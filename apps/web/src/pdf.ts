import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { importPdf, type PdfImportResult } from '@shiba/io';
import { PDF_FONTS } from './fonts';

/**
 * 打开 PDF 用到的解析库。这个模块只在用户第一次打开 PDF 时才加载（见 files.ts 里的动态 import），
 * 所以解析库不会拖慢平时的启动。
 *
 * 解析在单独的工作线程里进行，界面不会卡住。
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 附带资源的目录，由构建配置里的 pdfjsAssets 插件提供。工作线程里没有"当前页面"，所以要给完整地址 */
function assetUrl(directory: string): string {
  return new URL(`${import.meta.env.BASE_URL}pdfjs/${directory}/`, window.location.href).href;
}

export function importPdfBytes(
  bytes: Uint8Array,
  onProgress: (done: number, total: number) => void,
): Promise<PdfImportResult> {
  return importPdf(
    {
      pdfjs,
      cMapUrl: assetUrl('cmaps'),
      standardFontDataUrl: assetUrl('standard_fonts'),
      wasmUrl: assetUrl('wasm'),
      iccUrl: assetUrl('iccs'),
    },
    bytes,
    { fonts: PDF_FONTS, onProgress },
  );
}
