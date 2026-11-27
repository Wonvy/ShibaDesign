import CanvasKitInit, { type CanvasKit } from 'canvaskit-wasm';

let pending: Promise<CanvasKit> | null = null;

/**
 * 加载 CanvasKit（Skia 的 WASM 版）。整个应用只加载一次。
 * @param wasmUrl canvaskit.wasm 的地址，由宿主（浏览器打包器或 Node）提供
 */
export function loadCanvasKit(wasmUrl: string): Promise<CanvasKit> {
  pending ??= CanvasKitInit({ locateFile: () => wasmUrl });
  return pending;
}

export type { CanvasKit } from 'canvaskit-wasm';
