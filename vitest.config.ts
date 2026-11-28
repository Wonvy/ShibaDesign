import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // apps/web/test 里只放不依赖浏览器的部分（比如内置模板），同样在 Node 里跑
    include: ['packages/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    environment: 'node',
  },
});
