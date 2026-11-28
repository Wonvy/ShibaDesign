# 给 AI 开发工具的说明

ShibaDesign 是基于 Web 的设计工具：矢量绘图、演示、动画、轻量修图合在一起。接手开发前先读这三份文档：

- [README.md](README.md)：怎么运行、目录结构、怎么扩展（各种注册表）、几条代码约定。
- [docs/architecture.md](docs/architecture.md)：产品范围、技术选型、每个子系统的做法、做到了哪一步、怎么验证的。以它为准。
- [docs/backlog.md](docs/backlog.md)：还没做的功能，每项写了现状、涉及的代码、注意事项、怎么算做完，以及建议的顺序。

## 沟通和写法

- 用户用中文沟通。代码注释、文档、提交信息都用中文，写成平实的大白话，照着现有代码的风格写：说清楚"为什么"，不写空话。
- 界面上给人看的文字全部走语言包（`apps/web/src/i18n/locales/`），`zh-CN.json` 和 `en.json` 两份都要加。内核包不产生给人看的文字。

## 命令

```bash
npm install
npm run dev          # 开发服务器，http://localhost:5173
npm test             # 全部单元测试（vitest，在 Node 里跑）
npm run typecheck
npm run build
npx prettier --check apps/web/src apps/web/test packages/*/src packages/*/test docs README.md
```

一项改动做完之前，类型检查、全部测试、格式检查都要通过。

## 验证

- 单元测试在 Node 里跑（`packages/*/test`，以及 `apps/web/test` 里不依赖浏览器的部分），CanvasKit（`canvaskit-wasm`）和 fontsource 的字体文件直接从 `node_modules` 读，可以真的排版、渲染、导出。导出类的功能尽量和画布逐像素比较，写明差异有多大、差在哪。
- 能在浏览器里看到的改动要实际打开看。开发版里 `window.shiba` 是编辑器实例，可以在控制台里造数据、调命令、导出。
- 只在 Chromium 内核的浏览器里验证过的，在文档里写明。

## 代码约定（详见 README 的"几条约定"）

- 依赖方向：`web → editor → renderer → core`，`renderer` 导出时用 `io`，`io` 只依赖 `core`，`player` 不依赖任何包。除了 `web`，其他包都不依赖 React。
- 所有文档修改都走 `store.transact(label, fn)`，一次事务是一步撤销；拖动这类连续操作传同一个 `mergeKey`，结束时 `store.sealHistory()`。节点是不可变的。
- CanvasKit 的对象（`Path`、`Paint`、`Paragraph`、`Image`、`Surface`、`Typeface` 等）用完要 `delete()`。
- 打开的文件（.shiba、PDF、字体、图片）一律按不可信输入处理：`core/src/validate.ts` 校验文档结构，限制大小，越界时报错而不是崩溃。
- 新加的数据字段尽量做成可选的，省略时等于以前的行为，旧文件不用迁移；同时更新 `validate.ts`。保真外观的指纹（`core/src/text-appearance.ts` 的 `textAppearanceBasis`）要包含新的排版参数。
- 播放器函数 `runPlayer`（`packages/player/src/player.ts`）的源码会原样写进导出的网页，函数体里不能引用函数外面的任何东西。它的元素带着 `data-shiba` 标记，导出视频时靠这些标记读画面（`packages/player/src/record.ts`），改结构时两边一起改。
- 只在导出时用到的代码单独打包、用到时才加载（`@shiba/renderer/pdf`、`@shiba/renderer/svg`、`apps/web/src/present/video.ts`）。

## 文档

做完一项功能：

1. 在 `docs/architecture.md` 里更新需求表的状态，在对应章节写明做法、验证结果和还没做的部分。
2. 更新 README 的"当前状态"（目录结构有变化时也更新）。
3. 从 `docs/backlog.md` 删掉做完的那一项，新发现没做的事加进去。

## Git

- 每个功能一个分支，从 `main` 拉出，命名 `feature/xxx`；做完快进合并回 `main`。
- 提交信息第一行写"新增……：……"这样一句概括，正文按模块分组列要点，最后写测试数量。看 `git log` 里的例子。
- 作者名是 Wonvy，仓库的 git 配置已经设好，不要改。
- 提交、合并、推送都要先得到用户的同意。
