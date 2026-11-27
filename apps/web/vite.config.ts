import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * pdf.js 解析某些 PDF 时要按需下载的附带资源：字符映射表（东亚文字）、标准字体（PDF 没有内嵌的 Helvetica、Times 等）、
 * 图片解码器（JPEG 2000、JBIG2）和色彩配置。它们放在 /pdfjs/ 下：开发时直接从 node_modules 里读，构建时拷进产物。
 */
function pdfjsAssets(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const directories = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  // 脚本沙箱是给 PDF 表单里的 JavaScript 用的，我们不执行 PDF 里的脚本
  const wanted = (file: string): boolean => !file.startsWith('quickjs');
  const contentType = (file: string): string =>
    file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';

  return {
    name: 'shiba:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const [directory, file, ...rest] = decodeURIComponent((request.url ?? '').split('?')[0]!)
          .replace(/^\/+/, '')
          .split('/');
        // 只放行这几个目录下的单个文件，不允许借路径跳到别处
        const allowed =
          directory !== undefined &&
          file !== undefined &&
          rest.length === 0 &&
          directories.includes(directory) &&
          path.basename(file) === file &&
          wanted(file);
        if (!allowed) return next();
        try {
          const data = readFileSync(path.join(root, directory, file));
          response.setHeader('Content-Type', contentType(file));
          response.end(data);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const directory of directories) {
        for (const file of readdirSync(path.join(root, directory))) {
          if (!wanted(file)) continue;
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${directory}/${file}`,
            source: readFileSync(path.join(root, directory, file)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  server: { port: 5173, strictPort: true },
  optimizeDeps: { include: ['canvaskit-wasm'] },
});
