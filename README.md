# ShibaDesign

基于 Web 的跨平台设计工具：矢量绘图、演示、动画、轻量修图合在一起。

作者：Wonvy · 仓库：<https://github.com/wonvy/ShibaDesign>

产品范围、架构和路线图见 [docs/architecture.md](docs/architecture.md)。

## 运行

在 Node 24 上开发和验证，其他版本没有测过。

```bash
npm install
```

```bash
npm run dev
```

打开 http://localhost:5173 。

| 命令                | 作用                             |
| ------------------- | -------------------------------- |
| `npm run dev`       | 启动开发服务器                   |
| `npm run build`     | 生产构建，输出到 `apps/web/dist` |
| `npm test`          | 运行单元测试                     |
| `npm run typecheck` | 类型检查                         |
| `npm run format`    | 用 Prettier 格式化               |

## 目录结构

```
packages/core       数据模型、文档存储与撤销、矩阵、对齐分布。纯 TypeScript，无依赖
packages/renderer   CanvasKit 渲染器、节点类型注册表、几何缓存、布尔运算、命中测试、字体与文本排版；
                    导出 PDF、SVG（单独的入口 @shiba/renderer/pdf、@shiba/renderer/svg，用到时才加载）
packages/editor     编辑器内核：工具、命令、快捷键、选区、相机、视图模式
packages/io         .shiba 文件格式的打包、解包与校验；PDF 导入（解析指令 → 中间表示 → 节点）；
                    PDF 写出器（对象、内容流、字体、图片）；字体工具（子集、WOFF 封装、读字形轮廓）；
                    写 SVG 的小工具（元素树、网页字体）；MP4 装箱、GIF 编码。都不依赖渲染引擎
packages/player     HTML5 播放器：独立运行时，应用内演示和导出的网页都用它；按虚拟时钟逐帧录下画面，导出视频用
apps/web            React 界面：顶栏、图层、幻灯片条、属性面板、多语言、主题
docs                方案与架构
```

依赖方向是单向的：`web → editor → renderer → core`；`renderer` 导出 PDF、SVG 时用 `io` 里的写出器，`io` 只依赖 `core`；`player` 不依赖任何包。除了 `web`，其他包都不依赖 React。

## 怎么扩展

所有可扩展的东西都放在注册表里。新增功能是"加一个文件再注册"，不需要改已有代码。

| 想加什么 | 怎么加                                                                                     | 参考                                      |
| -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 工具     | 实现 `Tool` 接口，`editor.tools.register(tool)`；再到 `apps/web/src/toolbar.ts` 加一个按钮 | `packages/editor/src/tools/shape.ts`      |
| 命令     | 写一个 `Command`，`editor.commands.register(command)`。按钮和快捷键只引用命令 id           | `packages/editor/src/commands/arrange.ts` |
| 快捷键   | `editor.keymap.add({ key, command, args })`，后加的优先                                    | `packages/editor/src/keymap.ts`           |
| 节点类型 | 用声明合并往 `NodeTypeMap` 加类型；写一个 `NodeTypeDef`，`editor.nodeTypes.register(def)`  | `packages/renderer/src/nodes/boolean.ts`  |
| 属性面板 | 写一个接收 `PanelProps` 的组件，`registerPanel({ id, titleKey, order, when, component })`  | `apps/web/src/panels/index.ts`            |
| 内置语言 | 在 `apps/web/src/i18n/locales/` 加一个 JSON，并加进 `i18n/index.ts` 的 `BUILTIN`           | `locales/en.json`                         |
| 主题     | 在 `apps/web/src/theme/themes.ts` 的 `THEMES` 里加一项。样式表只用主题变量，不用改         | `themes.ts`                               |
| 内置字体 | 安装对应的 `@fontsource` 包，在 `apps/web/src/fonts.ts` 里仿照现有写法登记一个家族         | `apps/web/src/fonts.ts`                   |
| 动画效果 | 写一个 `EffectDef`，调用 `registerEffect(def)`；再到两个语言包的 `effect` 下加上它的名字   | `packages/core/src/animation.ts`          |

用户不改代码也能加语言：在语言菜单里导出当前语言包，翻译 `strings` 里的文字，把 `meta` 里的 `code` 和 `name` 改成新语言，再导入。

## 几条约定

- **内核不产生给人看的文字。** 内核只返回数据和 id，文字由界面层翻译。
- **所有文档修改都走事务。** `store.transact(label, fn)`，一次事务是一步撤销。拖动、滑块这类连续操作传同一个 `mergeKey`，结束时调用 `store.sealHistory()`。
- **节点是不可变的。** 修改会产生新对象，缓存靠"是不是同一个对象"判断是否过期。
- **CanvasKit 的对象要手动释放。** `Path`、`Paint`、`Surface` 等用完调用 `delete()`；交给 `GeometryCache` 的路径由它负责释放。

## 当前状态

已经能用的：自由画布与幻灯片双视图、矩形、椭圆、钢笔、文本（中英文混排、输入法输入、按字设置字体字号粗细斜体颜色下划线删除线、按段设置对齐段距缩进和列表）、图片（导入、作为任意形状的填充、调色与模糊）、选择与框选、移动、缩放、旋转、翻转、编组、蒙版（按形状、透明度或亮度遮）、对齐分布、层序、非破坏性布尔运算、纯色和渐变填充（线性、径向）、描边、不透明度、16 种混合模式、图层面板、撤销重做、幻灯片动画与页面切换、演示模式、导出可播放的 HTML（矢量，文字可以选中和搜索）、导出 MP4 视频和 GIF 动图、保存和打开 .shiba 文件、打开 PDF（每页一个画板，图形、图片、渐变转成对象，裁剪和透明蒙版还原成蒙版组，文字拼回段落、可以直接改字）、导出 PDF（矢量，文字可以搜索和复制）、导出 SVG（每个画板一个文件；文字可以保留成文字、内嵌字体子集，也可以转成轮廓）、导出 PNG、中英文界面、语言包导入导出、亮暗主题。

还没有的：抠图。
