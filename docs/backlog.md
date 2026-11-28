# 待开发功能清单

整理日期：2026-11-27（这一天 `main` 在 `63fa6ac`，段落样式刚合进去）。

这份清单给人看，也给接手的 AI 开发工具看：每一项写明现状、要做什么、涉及哪些代码、要注意什么、怎么算做完。产品范围和已经做到什么程度以 [architecture.md](architecture.md) 为准，代码结构和扩展方式见 [README](../README.md)，开发约定见 [AGENTS.md](../AGENTS.md)。

**怎么维护**：做完一项就从这里删掉，把做法和验证结果写进 architecture.md 对应的章节，更新它的需求表和 README 的"当前状态"。新发现没做的事加进对应的分组。编号只用来引用，不代表优先级。

## 建议的顺序

用户在 2026-11-27 同意的顺序：先把导出收齐（已完成：SVG、MP4、GIF），再补日常编辑（段落样式已完成），然后修图，再往后是动画和产品化。剩下的按这个顺序是：

1. 日常编辑：[EDIT-1 虚线描边](#edit-1-虚线描边端点和拐角样式) → [EDIT-2 画布上拖渐变](#edit-2-在画布上拖动渐变) → [EDIT-3 在蒙版里挪内容](#edit-3-在蒙版和图片框里直接挪动内容)
2. 修图：[IMG-1 抠图](#img-1-抠图) → [IMG-2 曲线、锐化、滤镜预设](#img-2-曲线锐化滤镜预设) → [EDIT-6 里的轮廓化描边、偏移路径](#edit-6-对象操作的补充)
3. 动画：[ANIM-1 动作路径](#anim-1-动作路径)、[ANIM-2 演讲者视图](#anim-2-演讲者视图)
4. 产品化（M4）：[PROD](#5-产品化m4和之后)

[QA 测试欠账](#6-测试和验证上的欠账)随时可以补，尤其是 Safari 和 Firefox。

---

## 1. 日常编辑

### EDIT-1 虚线描边（端点和拐角样式）

- **现状**：描边只有颜色和宽度（`core/src/model.ts` 的 `Stroke`），一律平头端点、尖角拐角（Skia 默认，斜接限制 4）。打开 PDF 时虚线改成实线并计数（`io/src/pdf/interpret.ts` 的 `dashed`，`PdfIssues.dashes`）。导出 PDF、SVG 也没有虚线。
- **要做**：
  - `Stroke` 加可选字段：虚线间隔数组、虚线起始偏移、端点（平头 / 圆头 / 方头）、拐角（尖角 / 圆角 / 斜角）。省略时和现在一样，旧文件不受影响；`core/src/validate.ts` 检查。
  - 渲染：`renderer/src/renderer.ts` 的 `drawShape`，用 `PathEffect.MakeDash` 和画笔的端点、拐角设置。
  - 外观面板（`apps/web/src/panels/AppearancePanel.tsx`）：实线、虚线、点线几个预设，加上自定义间隔、端点、拐角。
  - 导出 PDF：`io/src/pdf-export/content.ts` 加 `d`、`J`、`j` 指令，`renderer/src/pdf.ts` 写出来。
  - 导出 SVG：`renderer/src/svg.ts` 写 `stroke-dasharray`、`stroke-dashoffset`、`stroke-linecap`、`stroke-linejoin`。
  - 打开 PDF：`interpret.ts` 保留虚线数组和相位、线帽、线连接，`build.ts` 写进节点，不再计入 `issues.dashes`。
  - 网页播放器和视频用的是渲染结果或 SVG，不用单独处理。
- **注意**：虚线沿路径走，起点在哪决定了虚线的相位。导出 SVG 时矩形、椭圆写成 `<rect>`、`<ellipse>`，浏览器的起点约定和 Skia 不一定一样，有虚线时可能要改写成 `<path>` 才一致。点线是"间隔 0 + 圆头"。
- **怎么算做完**：画布、导出的 PDF（用 pdf.js 渲染）、导出的 SVG 三者逐像素比较；打开一份带虚线的 PDF，还原成虚线，提示里不再报"虚线改成实线"。

### EDIT-2 在画布上拖动渐变

- **现状**：渐变只能在外观面板里调（`apps/web/src/panels/GradientEditor.tsx`：类型、角度、色标）。数据是相对外框的起点终点，径向渐变还有压扁比例 `aspect`（`core/src/gradient.ts`）。
- **要做**：选中填了渐变的对象时，在画布上画出起点、终点手柄和连线（`editor/src/overlay.ts`），拖动改 `fill.start` / `fill.end`。径向渐变再加一个调压扁比例的手柄。按住 Shift 按 45° 吸附。拖动过程合成一步撤销（`mergeKey`，结束时 `sealHistory`）。可以顺便在连线上显示、拖动色标。画板背景的渐变也要能拖。
- **注意**：坐标要换算：世界坐标 → 节点本地坐标 → 外框的相对位置（`gradientGeometry` 的逆运算），旋转过的对象要算对。
- **怎么算做完**：拖完以后面板里显示的角度对得上；撤销一步回到拖之前。

### EDIT-3 在蒙版和图片框里直接挪动内容

- **现状**：画布上点中蒙版组选的是整个组。双击进组后可以选成员，但蒙版本身只能在图层列表里选。图片在形状里的缩放、平移（`ImageFill.zoom`、`panX`、`panY`）只能在图片面板里调。
- **要做**：双击蒙版组进入"编辑内容"：拖动的是被遮住的内容，蒙版不动（类似 Illustrator 的编辑内容）。双击填了图片的形状，可以在框里拖动、缩放图片，相当于在画布上裁剪。
- **涉及**：`editor/src/tools/select.ts`、`editor/src/commands/mask.ts`、`editor/src/commands/group.ts`、`editor/src/overlay.ts`、`apps/web/src/panels/ImagePanel.tsx`。
- **怎么算做完**：两种都能用鼠标完成，撤销一步回去，导出的结果和画布一致。

### EDIT-4 段落样式的补充

段落样式已经有对齐、段前段后距、左缩进、首行缩进、列表（`core/src/paragraphs.ts`、`renderer/src/text/layout.ts`），还缺：

- **悬挂缩进**（负的首行缩进，用在列表以外的段落）。Skia 的段落不支持负缩进，现在首行缩进是段首一个占位符。可能要先排一次找出第一行的断点，再把第一行和其余几行分开排。
- **右缩进**、**每段自己的行高**（现在行高是整个文本的）。
- **列表**：编号从几开始、自定义符号；全局快捷键（Shift+数字在不同键盘布局下字符不一样，要按 `event.code` 匹配，`editor/src/keymap.ts` 现在按 `event.key`）。
- **打开 PDF 时把项目符号还原成列表**：现在 PDF 里的符号和正文是分开的两个文本（`io/src/pdf/paragraphs.ts`）。要把同一条基线上的符号和段落配对，合成一个带列表样式的文本，同时保住改字之前按原字形显示（保真外观，见 architecture.md"文本"一节）。容易误判，要有足够的样本。

### EDIT-5 文本排版的补充

- **中英文混排的细节**：中英文之间自动加间距、标点挤压、行首行尾禁则。Skia 的段落不直接支持，要么预处理文字，要么自己断行（`renderer/src/text/layout.ts`）。
- **上标、下标**：字符样式加基线偏移（`core/src/text-spans.ts`）。打开 PDF 时的上标现在只保留了小字号，开始编辑后不再抬高。
- **复制粘贴时带上样式**：`editor/src/tools/text.ts` 现在只走纯文字；可以额外写 `text/html` 或自定义格式。
- **Home / End 按视觉行移动**：现在交给隐藏的输入框，按逻辑行移动。
- **表情符号字体**（彩色字体），在 `apps/web/src/fonts.ts` 登记。
- **竖排**、**沿路径排列**（M5）。
- **在画布上把文字转成轮廓**：一个命令把文本节点变成路径节点。读字形轮廓（`io/src/font/glyf.ts`）、把排版结果拆成一段段的字（`renderer/src/text/shaped.ts`）都有了，导出 SVG 的"转成轮廓"（`svg.ts` 的 `outlineRun`）做的就是同一件事。

### EDIT-6 对象操作的补充

- **对齐**：以某个对象为基准对齐（关键对象）、按视觉边界对齐、对齐锚点、拖动调整间距的手柄（`core/src/align.ts`、`apps/web/src/panels/ArrangePanels.tsx`）。
- **布尔运算**：拼合成普通路径、分割、修边；PathOps 算不出来时回退到 Clipper2；双击进入布尔组编辑子对象（`editor/src/commands/boolean.ts`、`renderer/src/nodes/boolean.ts`）。还没有边重合、极短线段这类刁钻情况的回归测试。
- **轮廓化描边、偏移路径**：生成新的路径节点。CanvasKit 有 `Path.stroke()`；偏移可以用描边再和原路径合并或相减来做。
- **渐变**：角度渐变（锥形；Skia 有 `MakeSweepGradient`，但 PDF 和 SVG 都没有原生的锥形渐变，导出时要拆成分段或者近似）、描边和文字的渐变（打开 PDF 时这两种现在改成平均色）。
- **描边位置**：内描边、外描边（现在只有居中）。

## 2. 修图（M2 剩下的）

### IMG-1 抠图

- **要做**：选中图片一键去背景，全在本地运行，不上传图片。按方案用 ONNX Runtime Web 在 Worker 里跑分割模型。结果要是非破坏的：把算出来的透明度蒙版存成资源，作为图片填充的一项调整，可以关掉、可以用画笔修。
- **注意**：
  - 模型必须是可商用的许可，比如 MIT 或 Apache 2.0；有的模型只许非商用，要逐个核实。
  - 模型文件大（几十 MB），第一次用时才下载，要缓存；先试 WebGPU，不行退回 WASM。
  - 导出 PDF、SVG 时把蒙版烤进像素（`renderer/src/bake.ts`）。
- **涉及**：`core/src/model.ts` 的 `ImageAdjustments`、`renderer/src/adjust.ts`、`renderer/src/bake.ts`、`apps/web/src/panels/ImagePanel.tsx`。
- **怎么算做完**：人像、商品图各几张，边缘看得过去；界面不卡；断网也能用（模型已经下载过的话）。

### IMG-2 曲线、锐化、滤镜预设

- 现在的调色合成一个颜色矩阵（`renderer/src/adjust.ts`），做不了曲线。曲线和 LUT 预设要用 SkSL 着色器或查找表纹理，锐化是卷积。
- 导出时同样烤进像素（`bake.ts`），PDF、SVG、视频都走那里。

### IMG-3 大图

- 现在长边超过 4096 像素的图片在导入时直接缩小（`apps/web/src/files.ts` 的 `MAX_IMAGE_SIDE`），会损失分辨率。
- 正式方案：保留原图，编辑时用缩小的代理图，导出时用原图；图片在 Worker 里解码。

### IMG-4 Photoshop 独有的混合模式

- 现在有 16 种标准混合模式。PS 独有的 11 种（线性加深、亮光、实色混合等）要用自定义着色器做；PDF、SVG 大多没有对应的写法，导出时只能烤成图片。

## 3. 动画与演示

### ANIM-1 动作路径

- 让对象沿一条路径移动。数据在 `core/src/animation.ts`：每个效果是一个注册函数，输出 Web Animations 的关键帧；可以用 CSS `offset-path`，或者把路径采样成一串 `translate` 关键帧（后者在录视频时一定能读到）。
- 画布上要能画、能改路径（复用钢笔工具的路径编辑）。

### ANIM-2 演讲者视图

- 数据里已经有每页的备注（`SlideDeck.notes`），但界面上还没有编辑备注的地方。
- 要做：备注编辑框；演示时另开一个窗口显示当前页、下一页、备注、计时，两个窗口同步翻页（`apps/web/src/present/Presenter.tsx`，播放器在 `packages/player`）。

### ANIM-3 文本动画、重复、自动翻页

- 按段落或逐字播放的文本动画；动画重复播放；每页定时自动翻页。
- 自动翻页的时间也给导出视频用：现在视频里每页停留的时间是统一的（`apps/web/src/present/video.ts`、`packages/player/src/record.ts`）。

### ANIM-4 其他

- 触屏滑动翻页。
- 对象被编进组之后，它原有的动画会失效（动画只能作用于幻灯片的直接子对象），界面上有标记，但不会自动转给所在的组。
- 视频里加声音（背景音乐、录音）。
- 自由关键帧时间轴（After Effects 式）放到 M5，与动画列表共用同一种关键帧数据。

## 4. 导入导出

### IO-1 打开 PDF

- **用原文件内嵌的字体直接画字**：现在字形按路径画，几十页的字同时出现在屏幕上时很吃力，所以导入时有总量上限（150 万个点）。pdf.js 能交出字体文件，Skia 能按字形编号画字。
- **改字之后继续用原文件的字体**：要把内嵌字体的字符映射改写成 Unicode，再交给排版引擎。
- 表格、多栏（现在拼段落不会跨列，但也不还原成表格）；项目符号还原成列表（见 EDIT-4）。
- 虚线（见 EDIT-1）、图案填充、网格渐变。
- 软蒙版的背景色（BC）和转换函数（TR）。
- 有密码保护的 PDF。
- 设计软件导出的 PDF 还没有系统地测过，样本还少（见 QA）。

### IO-2 导出 PDF

- 中文两端对齐拉开的字距：有的阅读器（比如 pdf.js）复制文字时会把它当成词间隔，复制出来是"导 出 文 字"。
- 改过的文字用回原文件的字体（依赖 IO-1）。
- 虚线（EDIT-1）。
- 画板以外的对象不导出；PDF/A、PDF/X、超链接、书签、无障碍标签都没有。

### IO-3 导出 SVG

- 导出选中的对象（现在只能导出整个画板）。
- 复制文字时会断开的两种情况：模拟斜体所在的家族同时用到了真正的斜体文件；从 PDF 导入的、方向不同的几段字。
- 排版用的 WOFF2 和嵌入用的 WOFF 字形编号不一致的分片里，连字、变体这类查不到字符的字形可能写错（`renderer/src/text/shaped.ts` 的 `remapToEmbedded`）。
- 用 Safari、Firefox，以及 Illustrator、Figma、Inkscape 打开看效果。

### IO-4 其他格式和存储

- JPEG 导出：渲染引擎的默认构建不带 JPEG 编码器，可以用浏览器画布的 `convertToBlob`。
- .shiba 文件里内嵌缩略图；本地存储改用 OPFS。
- 打开 PPTX、PSD（M4）。和 AI、PPTX 的完整双向保真不做（见 architecture.md"不做"）。

## 5. 产品化（M4）和之后

- **桌面版**：Electron（方案见 architecture.md 的技术选型）。
- **组件与样式**：组件实例（architecture.md 里列为待做的 `instance` 节点类型，代码里还没有），可复用的颜色、文字样式。
- **模板**。
- **云同步**；之后是**实时协同**（文档存储的接口按 Yjs 设计，`core/src/store.ts`）。
- **加载和体积**：CanvasKit 的 WASM 7.3MB（gzip 后约 3MB），首屏要优化；正式构建 41MB，其中导出用的 WOFF 字体占了 15MB。
- M5：AI、插件、平板、像素画笔、OCR、竖排、自由关键帧时间轴。

## 6. 测试和验证上的欠账

- **浏览器**：输入法、播放器、导出 SVG、导出视频都只在 Chromium 内核的浏览器里测过，Safari、Firefox 还没有。中文输入法只用一种真实的输入法实测过。
- **性能**：只测过 504 × 724 的视口、设备像素比 1、一万个简单形状；高分屏和复杂内容没测。iPad Safari 的内存限制没测。
- **布尔运算**：缺刁钻情况的回归测试集（边重合、极短线段）。
- **PDF 样本**：手写的小文件、浏览器生成的文件、系统自带的几份 TeX 和插画文件；设计软件导出的文件还没有系统地测。

## 7. 已知的小问题

- 窗口较窄时（800 像素宽），文本面板"文本框"一行的"自动宽度 / 固定宽度"分段按钮超出了面板，"固定宽度"被截掉一截。
- 英文界面的数量词没有区分单复数，用的是中性的写法（比如"All artboards (3)"）。
