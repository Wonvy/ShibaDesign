# ShibaDesign

基于 Web 的跨平台设计工具：矢量绘图、演示、动画、轻量修图合在一起。

作者：Wonvy · 仓库：<https://github.com/wonvy/ShibaDesign>

产品范围、架构和路线图见 [docs/architecture.md](docs/architecture.md)，还没做的功能见 [docs/backlog.md](docs/backlog.md)，操作和界面的改版方案（右键菜单、快捷键、面板、吸附、圆角、UI 设计）见 [docs/interaction-plan.md](docs/interaction-plan.md)。用 AI 开发工具接手时先看 [AGENTS.md](AGENTS.md)。

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
packages/core       数据模型、文档存储与撤销（带整理器：样式和组件的同步）、颜色样式和文字样式、组件与实例、幻灯片版式、
                    矩阵、对齐分布、路径数据转锚点、曲线、滤镜预设。纯 TypeScript，无依赖
packages/renderer   CanvasKit 渲染器、节点类型注册表、几何缓存、布尔运算、命中测试、字体与文本排版、描边转轮廓和偏移路径、
                    图片的曲线锐化滤镜（SkSL 着色器）；
                    导出 PDF、SVG，文字转轮廓（单独的入口 @shiba/renderer/pdf、@shiba/renderer/svg、
                    @shiba/renderer/text-outline，用到时才加载）
packages/editor     编辑器内核：工具、命令、快捷键、选区、相机、视图模式
packages/io         .shiba 文件格式的打包、解包与校验；PDF 导入（解析指令 → 中间表示 → 节点）；
                    PDF 写出器（对象、内容流、字体、图片）；字体工具（子集、WOFF 封装、读字形轮廓）；
                    写 SVG 的小工具（元素树、网页字体）；MP4 装箱、GIF 编码。都不依赖渲染引擎
packages/player     HTML5 播放器：独立运行时，应用内演示和导出的网页都用它；按虚拟时钟逐帧录下画面，导出视频用
apps/web            React 界面：顶栏和菜单栏、面板系统（dock：停靠区、选项卡、浮动窗）、图层、资源（组件、样式）、
                    幻灯片条、属性面板、右键菜单和命令面板（menus）、剪贴板、模板（新建对话框、内置模板、我的模板）、
                    多语言、主题；test 里是不依赖浏览器的部分的测试（内置模板、面板布局、菜单的名字、快捷键的显示）
docs                方案与架构
```

依赖方向是单向的：`web → editor → renderer → core`；`renderer` 导出 PDF、SVG 时用 `io` 里的写出器，`io` 只依赖 `core`；`player` 不依赖任何包。除了 `web`，其他包都不依赖 React。

## 怎么扩展

所有可扩展的东西都放在注册表里。新增功能是"加一个文件再注册"，不需要改已有代码。

| 想加什么   | 怎么加                                                                                        | 参考                                      |
| ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 工具       | 实现 `Tool` 接口，`editor.tools.register(tool)`；再到 `apps/web/src/toolbar.ts` 加一个按钮    | `packages/editor/src/tools/shape.ts`      |
| 命令       | 写一个 `Command`，`editor.commands.register(command)`。按钮和快捷键只引用命令 id              | `packages/editor/src/commands/arrange.ts` |
| 快捷键     | `editor.keymap.add({ key, command, args })`，后加的优先                                       | `packages/editor/src/keymap.ts`           |
| 节点类型   | 用声明合并往 `NodeTypeMap` 加类型；写一个 `NodeTypeDef`，`editor.nodeTypes.register(def)`     | `packages/renderer/src/nodes/boolean.ts`  |
| 属性面板   | 写一个接收 `PanelProps` 的组件，`registerPanel({ id, titleKey, order, when, component })`     | `apps/web/src/panels/index.ts`            |
| 内置语言   | 在 `apps/web/src/i18n/locales/` 加一个 JSON，并加进 `i18n/index.ts` 的 `BUILTIN`              | `locales/en.json`                         |
| 主题       | 在 `apps/web/src/theme/themes.ts` 的 `THEMES` 里加一项。样式表只用主题变量，不用改            | `themes.ts`                               |
| 内置字体   | 安装对应的 `@fontsource` 包，在 `apps/web/src/fonts.ts` 里仿照现有写法登记一个家族            | `apps/web/src/fonts.ts`                   |
| 动画效果   | 写一个 `EffectDef`，调用 `registerEffect(def)`；再到两个语言包的 `effect` 下加上它的名字      | `packages/core/src/animation.ts`          |
| 幻灯片版式 | 写一个 `SlideLayout`，调用 `registerLayout(layout)`；再到两个语言包的 `layout` 下加上它的名字 | `packages/core/src/layouts.ts`            |
| 内置模板   | 在 `BUILTIN_TEMPLATES` 里加一项；再到两个语言包的 `template` 下加名字、说明和示例文字         | `apps/web/src/templates/builtin.ts`       |

用户不改代码也能加语言：在语言菜单里导出当前语言包，翻译 `strings` 里的文字，把 `meta` 里的 `code` 和 `name` 改成新语言，再导入。

## 几条约定

- **内核不产生给人看的文字。** 内核只返回数据和 id，文字由界面层翻译。
- **所有文档修改都走事务。** `store.transact(label, fn)`，一次事务是一步撤销。拖动、滑块这类连续操作传同一个 `mergeKey`，结束时调用 `store.sealHistory()`。
- **节点是不可变的。** 修改会产生新对象，缓存靠"是不是同一个对象"判断是否过期。
- **CanvasKit 的对象要手动释放。** `Path`、`Paint`、`Surface` 等用完调用 `delete()`；交给 `GeometryCache` 的路径由它负责释放。

## 当前状态

已经能用的：自由画布与幻灯片双视图、矩形（四个角分别圆角、反向圆角、倒角、平滑度，画布上拖圆角控件）、椭圆、钢笔（尖角也能圆角，钢笔在选中的路径上加删锚点）、直接选择工具（改锚点和控制柄）、多边形和星形、直线和箭头（五种端点样式）、铅笔（手画后拟合成平滑曲线）、吸管、视图缩放工具、等比缩放（描边、圆角、字号一起变）、工具栏分组和锁定（双击工具连续画）、画框（做界面用的容器，可以嵌套、裁剪内容、有圆角和描边，F 画画框，⌥⌘G 用画框包起来，把东西拖进拖出）、约束（画框、画板改大小时里面的东西靠右、拉伸、居中、按比例跟着变，按住 ⌘ 不变）、效果（投影、内阴影、图层模糊、背景模糊，可以叠好几个，导出 SVG 写成滤镜，导出 PDF 时阴影烤成图片）、自动布局（⇧A，画框里的东西按方向、间距、内边距自动排列，宽高可以包住内容或填满，拖动调整顺序，和组件一起用）、版面网格（列、行、方格，⇧G 开关，吸附到列和行的边，导出不画）、检查面板和复制为 CSS、导出设置（倍率、格式、后缀，一次导出全部打成 ZIP）、原型（演示时点对象跳到另一页、返回，导出的网页里也能点）、界面设计的起步（手机、平板、桌面等屏幕尺寸，lucide 图标库，登录页模板）、数字输入框能算式和拖标签改数值、颜色框的吸管和色板、可以折叠的属性分区、撤销历史面板和"撤销移动"这样的菜单名、自定义快捷键、文本（中英文混排、输入法输入、按字设置字体字号粗细斜体颜色下划线删除线、按段设置对齐段距缩进和列表）、图片（导入、作为任意形状的填充、调色、曲线、锐化、模糊、滤镜预设）、选择与框选、移动、缩放、旋转、翻转、编组、蒙版（按形状、透明度或亮度遮，双击可以单独移动里面的内容）、对齐分布、层序、非破坏性布尔运算、文字转轮廓、轮廓化描边、偏移路径、纯色和渐变填充（线性、径向，可以在画布上拖动起点终点）、描边（虚线、端点、拐角）、在画布上挪动缩放形状里的图片、不透明度、16 种混合模式、图层面板、组件（主组件和实例，实例里可以改颜色文字等属性、整体缩放、嵌套，主组件改了实例跟着变）、颜色样式和文字样式、模板（新建时选空白尺寸或内置模板，存为模板，新建幻灯片时选版式）、图层面板（拖动排序和改归属、折叠、锁定、只显示一个、搜索）、幻灯片条（拖动排序、多选、插入、隐藏幻灯片、网格排列）、可以拖动的面板选项卡、停靠区和浮动窗（属性栏的分区能弹出，图片调整是单独的浮动面板，工作区预设）、吸附（对象、画板、辅助线、等间距、像素）与智能参考线、按住 Alt 测距、尺寸标签、标尺和辅助线、像素网格、右键菜单（画布、文字、画板、幻灯片、图层、资源）、顶部菜单栏、命令面板（⌘K）、快捷键表（?）、撤销重做（拖动到一半可以按 Esc 取消，修饰键按下就生效）、复制粘贴（在幻灯片之间、文档之间搬对象，原位粘贴，复制属性，复制为 PNG / SVG）、快捷键按物理键匹配（Mac 上 Option 加字母也能用），对齐、布尔、锁定、选择父级子级同级等九十多条快捷键，⌘ 单击深选、悬停高亮、按住 Alt 拖动复制、从中心缩放和画形状、拼合、幻灯片动画（进入、强调、退出、动作路径）与页面切换、演示模式（可以另开窗口显示演讲者视图：当前页、下一页、备注、计时）、导出可播放的 HTML（矢量，文字可以选中和搜索）、导出 MP4 视频和 GIF 动图、保存和打开 .shiba 文件、打开 PDF（每页一个画板，图形、图片、渐变转成对象，裁剪和透明蒙版还原成蒙版组，文字拼回段落、可以直接改字）、导出 PDF（矢量，文字可以搜索和复制）、导出 SVG（选中的对象，或者每个画板一个文件；文字可以保留成文字、内嵌字体子集，也可以转成轮廓）、导出 PNG 和 JPEG、中英文界面、语言包导入导出、亮暗主题。

还没有的：抠图，以及 [docs/backlog.md](docs/backlog.md) 里列的其他功能。
