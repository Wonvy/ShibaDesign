import type { CanvasKit } from 'canvaskit-wasm';
import {
  AssetStore,
  DocStore,
  ancestors,
  applyToPoint,
  artboardOf,
  artboards,
  descendants,
  hasShapeStyle,
  rectContainsPoint,
  slides,
  unionRects,
  worldTransform,
  type ArtboardNode,
  type AssetMeta,
  type Matrix,
  type NodeId,
  type NodePatch,
  type Point,
  type Rect,
  type SceneNode,
  type TextNode,
  type TextStyle,
} from '@shiba/core';
import {
  FontManager,
  GeometryCache,
  ImageCache,
  NodeTypeRegistry,
  Renderer,
  TextLayouts,
  createTextNodeType,
  TextAppearances,
  ensureTextFonts,
  registerBuiltinNodeTypes,
  type Bitmap,
  type Camera,
  type FrameStats,
} from '@shiba/renderer';
import type { PdfExportContext, PdfExportOptions } from '@shiba/renderer/pdf';
import type { SvgExportOptions, SvgLayers } from '@shiba/renderer/svg';
import type { TextOutlinePart } from '@shiba/renderer/text-outline';
import { replaceTextWithOutlines } from './commands/path';
import { CommandRegistry } from './commands/command';
import { InputController } from './input';
import { DEFAULT_BINDINGS, Keymap } from './keymap';
import { Overlay } from './overlay';
import { Registry } from './registry';
import type { Tool } from './tools/tool';
import type { CanvasTheme, EditorState, TextEditing, ViewMode } from './types';
import type { FillEditing } from './fill-handles';

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
const FIT_PADDING = 48;

export interface SelectionFrame {
  /** 框的四个角，世界坐标，依次是左上、右上、右下、左下（按对象自己的方向） */
  corners: [Point, Point, Point, Point];
  /** 只选了一个对象时：它的 id、本地包围盒、本地到世界的变换 */
  single: { id: NodeId; box: Rect; world: Matrix } | null;
  /** 是否显示旋转手柄。画板不能旋转 */
  rotatable: boolean;
}

export interface EditorOptions {
  ck: CanvasKit;
  store: DocStore;
  theme: CanvasTheme;
  /** 新建文本时默认使用的字体家族。宿主负责用 editor.fonts.addFamily 登记这些家族 */
  defaultFonts: { latin: string; cjk: string };
  /** 图片等资源的存放处。不传时编辑器自己建一个空的 */
  assets?: AssetStore;
}

/**
 * 编辑器内核。持有文档、相机、选区和当前工具，不依赖任何界面框架。
 * 具体功能都通过三张注册表接入：nodeTypes（节点类型）、tools（工具）、commands（命令）。
 */
export class Editor {
  readonly ck: CanvasKit;
  readonly store: DocStore;
  readonly nodeTypes = new NodeTypeRegistry();
  readonly geometry: GeometryCache;
  readonly fonts: FontManager;
  readonly textLayouts: TextLayouts;
  /** 从 PDF 导入、还没改过的文字按原字形显示，见 core 的 text-appearance.ts */
  readonly textAppearances: TextAppearances;
  readonly assets: AssetStore;
  readonly images: ImageCache;
  readonly tools = new Registry<Tool>('工具');
  readonly commands: CommandRegistry;
  readonly keymap = new Keymap().add(...DEFAULT_BINDINGS);

  camera: Camera = { x: 0, y: 0, zoom: 1 };
  theme: CanvasTheme;
  /** 画布区域的大小，CSS 像素 */
  viewport = { width: 0, height: 0 };
  /** 节点显示名。界面层注入带翻译的版本，内核本身不产生给人看的文字 */
  labelOf: (node: SceneNode) => string = (node) => node.name ?? `${node.type} ${node.seq}`;
  /** 新建文本时使用的样式 */
  defaultTextStyle: TextStyle;
  /**
   * 需要接收键盘输入的元素。文本编辑时是那个隐藏的输入框：
   * 点击画布后焦点要回到它身上，而不是画布，否则输入法会断开。
   */
  keyboardTarget: HTMLElement | null = null;

  private state: EditorState;
  private listeners = new Set<() => void>();
  private renderer: Renderer | null = null;
  private overlay: Overlay | null = null;
  private input: InputController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame = 0;
  private autoFit = true;
  private mountedElements: HTMLElement[] = [];
  private mountContainer: HTMLElement | null = null;
  private mergeCounter = 0;

  constructor(options: EditorOptions) {
    this.ck = options.ck;
    this.store = options.store;
    this.theme = options.theme;
    this.defaultTextStyle = {
      fontFamily: options.defaultFonts,
      fontSize: 48,
      fontWeight: 400,
      lineHeight: 1.4,
      letterSpacing: 0,
    };
    this.assets = options.assets ?? new AssetStore();
    this.fonts = new FontManager(this.ck);
    this.textLayouts = new TextLayouts(this.ck, this.store, this.fonts);
    this.textAppearances = new TextAppearances(this.ck, this.store, this.assets);
    registerBuiltinNodeTypes(this.nodeTypes);
    this.nodeTypes.register(createTextNodeType(this.textLayouts, this.textAppearances));
    this.geometry = new GeometryCache(this.ck, this.store, this.nodeTypes);
    this.fonts.onChange(() => this.onFontsChange());
    this.images = new ImageCache(this.ck, this.assets);
    this.assets.subscribe(() => this.onAssetsChange());
    this.commands = new CommandRegistry(this);
    this.state = {
      tool: 'select',
      selection: [],
      viewMode: 'canvas',
      activeArtboardId: slides(this.store)[0]?.id ?? null,
      zoom: 1,
      canUndo: this.store.canUndo,
      canRedo: this.store.canRedo,
      docVersion: this.store.version,
      resourceEpoch: 0,
      textEditing: null,
      fillEditing: null,
    };
    this.store.subscribe(() => this.onDocumentChange());
  }

  /** 有字体加载完成：文本的大小和样子都可能变了，相关缓存全部作废 */
  private onFontsChange(): void {
    this.textLayouts.clear();
    this.geometry.invalidate((node) => node.type === 'text');
    this.onResourcesReady();
  }

  /** 字体或图片到位了：文档没变，但画面该变 */
  /** 资源库变了：图片要重新解码，保真文字的字形库可能刚到，文本框的范围也跟着变 */
  private onAssetsChange(): void {
    this.geometry.invalidate((node) => node.type === 'text' && node.appearance !== undefined);
    this.onResourcesReady();
  }

  private onResourcesReady(): void {
    this.renderer?.invalidate();
    this.setState({ resourceEpoch: this.state.resourceEpoch + 1 });
  }

  // ───────────── 状态订阅 ─────────────

  getState = (): EditorState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
    this.requestRender();
  }

  private onDocumentChange(): void {
    const selection = this.state.selection.filter((id) => this.store.has(id));
    let active = this.state.activeArtboardId;
    if (!active || !this.store.has(active)) active = slides(this.store)[0]?.id ?? artboards(this.store)[0]?.id ?? null;
    this.setState({
      selection: selection.length === this.state.selection.length ? this.state.selection : selection,
      activeArtboardId: active,
      canUndo: this.store.canUndo,
      canRedo: this.store.canRedo,
      docVersion: this.store.version,
      fillEditing: this.validFillEditing(this.state.fillEditing),
    });
  }

  /** 在画布上调整的填充还在不在（节点删了、撤销到了别的填充，就退出） */
  private validFillEditing(editing: FillEditing | null): FillEditing | null {
    if (!editing) return null;
    const node = this.store.get(editing.id);
    const fill = node && 'fill' in node ? node.fill : null;
    return fill && typeof fill === 'object' && fill.type === editing.kind ? editing : null;
  }

  get fillEditing(): FillEditing | null {
    return this.state.fillEditing;
  }

  /**
   * 进入或退出"在画布上调整填充"。进入时把选区换成这个节点；节点没有这种填充时不进入
   */
  setFillEditing(next: FillEditing | null): void {
    const valid = this.validFillEditing(next);
    if (valid && !(this.state.selection.length === 1 && this.state.selection[0] === valid.id)) {
      this.select([valid.id]);
    }
    const current = this.state.fillEditing;
    if (current?.id === valid?.id && current?.kind === valid?.kind) return;
    this.setState({ fillEditing: valid });
  }

  /** 文本工具在编辑文字、选中范围变化时调用。范围没变时不通知，免得界面跟着光标闪烁时也重画 */
  setTextEditing(next: TextEditing | null): void {
    const current = this.state.textEditing;
    if (
      current === next ||
      (current &&
        next &&
        current.nodeId === next.nodeId &&
        current.start === next.start &&
        current.end === next.end &&
        current.typing === next.typing)
    ) {
      return;
    }
    this.setState({ textEditing: next });
  }

  // ───────────── 选区 ─────────────

  get selection(): readonly NodeId[] {
    return this.state.selection;
  }

  selectedNodes(): SceneNode[] {
    return this.state.selection.map((id) => this.store.get(id)).filter((n): n is SceneNode => n !== undefined);
  }

  select(ids: readonly NodeId[]): void {
    const unique = [...new Set(ids)].filter((id) => this.store.has(id));
    const first = unique[0];
    const board = first ? artboardOf(this.store, first) : null;
    const editing = this.state.fillEditing;
    this.setState({
      selection: unique,
      activeArtboardId: board && this.state.viewMode === 'canvas' ? board.id : this.state.activeArtboardId,
      // 换了选区就不再调整原来那个节点的填充
      fillEditing: editing && unique.length === 1 && unique[0] === editing.id ? editing : null,
    });
  }

  clearSelection(): void {
    if (this.state.selection.length > 0) this.setState({ selection: [], fillEditing: null });
  }

  /**
   * 选区框：画在画布上、带控制柄的那个框。
   * 只选一个对象时，框跟着对象一起倾斜，缩放沿对象自己的方向进行；
   * 多选时是一个不倾斜的外接矩形。
   */
  selectionFrame(): SelectionFrame | null {
    const nodes = this.selectedNodes();
    const only = nodes.length === 1 ? nodes[0]! : null;
    if (only) {
      const box = this.geometry.localBounds(only);
      const world = worldTransform(this.store, only.id);
      const corner = (x: number, y: number): Point => {
        const [wx, wy] = applyToPoint(world, x, y);
        return { x: wx, y: wy };
      };
      return {
        corners: [
          corner(box.x, box.y),
          corner(box.x + box.w, box.y),
          corner(box.x + box.w, box.y + box.h),
          corner(box.x, box.y + box.h),
        ],
        single: { id: only.id, box, world },
        rotatable: only.type !== 'artboard',
      };
    }
    const bounds = this.selectionBounds();
    if (!bounds) return null;
    return {
      corners: [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.w, y: bounds.y },
        { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
        { x: bounds.x, y: bounds.y + bounds.h },
      ],
      single: null,
      rotatable: nodes.some((n) => n.type !== 'artboard'),
    };
  }

  /** 选区在世界坐标下的整体外接矩形 */
  selectionBounds(): Rect | null {
    return unionRects(this.selectedNodes().map((n) => this.geometry.worldBounds(n)));
  }

  /** 对选中的每个节点应用修改；fn 返回 null 表示跳过该节点 */
  updateSelection(label: string, fn: (node: SceneNode) => NodePatch | null, mergeKey?: string): void {
    this.store.transact(
      label,
      (tx) => {
        for (const node of this.selectedNodes()) {
          const patch = fn(node);
          if (patch) tx.update(node.id, patch);
        }
      },
      { mergeKey },
    );
  }

  /** 生成一个新的合并键：一次拖动内的所有事务用同一个键 */
  newMergeKey(prefix: string): string {
    this.mergeCounter += 1;
    return `${prefix}:${this.mergeCounter}`;
  }

  // ───────────── 工具 ─────────────

  get tool(): Tool {
    return this.tools.require(this.state.tool);
  }

  setTool(id: string): void {
    if (!this.tools.has(id) || id === this.state.tool) return;
    this.tool.onDeactivate?.(this);
    this.setState({ tool: id, fillEditing: null });
    this.tool.onActivate?.(this);
    this.setCursor(this.tool.cursor);
  }

  setCursor(cursor: string): void {
    this.input?.setCursor(cursor);
  }

  // ───────────── 视图 ─────────────

  get viewMode(): ViewMode {
    return this.state.viewMode;
  }

  get activeArtboard(): ArtboardNode | null {
    const node = this.state.activeArtboardId ? this.store.get(this.state.activeArtboardId) : undefined;
    return node?.type === 'artboard' ? node : null;
  }

  /** 当前视图下参与绘制和命中的根节点 */
  roots(): NodeId[] {
    if (this.state.viewMode === 'slides') {
      const board = this.activeArtboard;
      return board ? [board.id] : [];
    }
    return [this.store.root.id];
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.state.viewMode) return;
    const selection =
      mode === 'slides'
        ? this.state.selection.filter((id) => artboardOf(this.store, id)?.id === this.state.activeArtboardId)
        : this.state.selection;
    this.setState({ viewMode: mode, selection });
    this.zoomToFit();
  }

  setActiveArtboard(id: NodeId): void {
    if (this.store.get(id)?.type !== 'artboard') return;
    const selection =
      this.state.viewMode === 'slides'
        ? this.state.selection.filter((sel) => artboardOf(this.store, sel)?.id === id)
        : this.state.selection;
    this.setState({ activeArtboardId: id, selection });
    if (this.state.viewMode === 'slides') this.zoomToFit();
  }

  screenToWorld(x: number, y: number): Point {
    return { x: (x - this.camera.x) / this.camera.zoom, y: (y - this.camera.y) / this.camera.zoom };
  }

  worldToScreen(x: number, y: number): Point {
    return { x: x * this.camera.zoom + this.camera.x, y: y * this.camera.zoom + this.camera.y };
  }

  panBy(dx: number, dy: number): void {
    this.autoFit = false;
    this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy };
    this.requestRender();
  }

  /** 以屏幕上的某个点为中心缩放 */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.zoom * factor));
    const world = this.screenToWorld(screenX, screenY);
    this.autoFit = false;
    this.camera = { zoom, x: screenX - world.x * zoom, y: screenY - world.y * zoom };
    this.setState({ zoom });
  }

  zoomBy(factor: number): void {
    this.zoomAt(this.viewport.width / 2, this.viewport.height / 2, factor);
  }

  /** 让一个世界坐标矩形正好显示在视口里；不传时显示当前视图的全部内容 */
  zoomToFit(target?: Rect): void {
    const rect = target ?? this.contentBounds();
    this.autoFit = target === undefined;
    if (!rect || rect.w <= 0 || rect.h <= 0 || this.viewport.width === 0) {
      this.requestRender();
      return;
    }
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min((this.viewport.width - FIT_PADDING * 2) / rect.w, (this.viewport.height - FIT_PADDING * 2) / rect.h),
      ),
    );
    this.camera = {
      zoom,
      x: (this.viewport.width - rect.w * zoom) / 2 - rect.x * zoom,
      y: (this.viewport.height - rect.h * zoom) / 2 - rect.y * zoom,
    };
    this.setState({ zoom });
  }

  private contentBounds(): Rect | null {
    if (this.state.viewMode === 'slides') {
      const board = this.activeArtboard;
      return board ? this.geometry.worldBounds(board) : null;
    }
    const rect = this.geometry.worldBounds(this.store.root);
    return rect.w > 0 && rect.h > 0 ? rect : null;
  }

  // ───────────── 命中 ─────────────

  /**
   * 点中的"可选对象"。默认是画板或页面的直接子节点：点中编组或布尔组内部时，选中的是整个组。
   * 但如果当前选中的对象本身就在某个组里（说明用户已经"进入"了这个组），
   * 那么点这个组里的其他成员，选中的是那个成员而不是整个组。
   * artboard 是该点所在的画板，点在画板外时为 null。
   */
  pick(world: Point): { node: SceneNode | null; artboard: ArtboardNode | null } {
    const tolerance = 4 / this.camera.zoom;
    const hit = this.geometry.hitTest(world.x, world.y, this.roots(), tolerance);
    if (!hit) return { node: null, artboard: null };
    if (hit.type === 'artboard') return { node: null, artboard: hit };
    const entered = new Set<NodeId>();
    for (const selected of this.selectedNodes()) {
      const parent = selected.parent ? this.store.get(selected.parent) : undefined;
      if (parent?.type === 'group' || parent?.type === 'boolean') entered.add(parent.id);
    }
    const chain = [hit, ...ancestors(this.store, hit.id)];
    let node: SceneNode = hit;
    for (const candidate of chain) {
      const parent = candidate.parent ? this.store.get(candidate.parent) : undefined;
      if (!parent || parent.type === 'page' || parent.type === 'artboard' || entered.has(parent.id)) {
        node = candidate;
        break;
      }
    }
    return { node, artboard: artboardOf(this.store, node.id) };
  }

  /**
   * 某个容器里、位于这个点下面的那个直接子节点。双击编组"进入"它时用。
   * 这个点下面没有该容器的内容时返回 null。
   */
  pickInside(world: Point, containerId: NodeId): SceneNode | null {
    const hit = this.geometry.hitTest(world.x, world.y, this.roots(), 4 / this.camera.zoom);
    if (!hit) return null;
    return [hit, ...ancestors(this.store, hit.id)].find((n) => n.parent === containerId) ?? null;
  }

  /** 新建对象时应该放进哪个容器：所在画板，否则是页面 */
  containerAt(world: Point): SceneNode {
    if (this.state.viewMode === 'slides') return this.activeArtboard ?? this.store.root;
    const boards = artboards(this.store);
    for (let i = boards.length - 1; i >= 0; i--) {
      const board = boards[i]!;
      if (board.visible && rectContainsPoint(this.geometry.worldBounds(board), world.x, world.y)) return board;
    }
    return this.store.root;
  }

  /** 框选等操作的候选对象：当前视图里所有画板和页面的直接子节点（不含画板本身） */
  selectableNodes(): SceneNode[] {
    const out: SceneNode[] = [];
    for (const rootId of this.roots()) {
      const root = this.store.get(rootId);
      if (!root) continue;
      const containers = root.type === 'page' ? [root, ...artboards(this.store)] : [root];
      for (const container of containers) {
        for (const child of this.store.children(container.id)) {
          if (child.type !== 'artboard' && child.visible && !child.locked) out.push(child);
        }
      }
    }
    return out;
  }

  // ───────────── 挂载与绘制 ─────────────

  /** 把编辑器画布挂到一个 DOM 容器里 */
  mount(container: HTMLElement): void {
    this.unmount();
    this.mountContainer = container;
    const scene = document.createElement('canvas');
    const top = document.createElement('canvas');
    for (const el of [scene, top]) {
      el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;';
      container.appendChild(el);
    }
    top.tabIndex = 0;
    top.style.outline = 'none';
    this.mountedElements = [scene, top];
    this.renderer = new Renderer(this.ck, scene, this.store, this.nodeTypes, this.geometry, this.images);
    this.overlay = new Overlay(top, this);
    this.input = new InputController(top, this);
    this.input.setCursor(this.tool.cursor);

    this.resizeObserver = new ResizeObserver(() => this.onResize(container));
    this.resizeObserver.observe(container);
    this.onResize(container);
  }

  unmount(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.input?.dispose();
    this.input = null;
    this.overlay = null;
    this.renderer?.dispose();
    this.renderer = null;
    for (const el of this.mountedElements) el.remove();
    this.mountedElements = [];
    this.mountContainer = null;
  }

  /** 画布所在的 DOM 容器；未挂载时为 null。工具需要往里放自己的元素时用它 */
  get container(): HTMLElement | null {
    return this.mountContainer;
  }

  private onResize(container: HTMLElement): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.viewport = { width, height };
    this.renderer?.resize(width, height, dpr);
    this.overlay?.resize(width, height, dpr);
    if (this.autoFit) this.zoomToFit();
    // 尺寸变化后画布内容被清空，必须同步重画，否则会闪一帧空白
    this.renderNow();
  }

  setTheme(theme: CanvasTheme): void {
    this.theme = theme;
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame || !this.renderer) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderNow();
    });
  }

  private renderNow(): void {
    if (!this.renderer || !this.overlay) return;
    this.renderer.render(this.camera, { background: this.theme.background, roots: this.roots() });
    this.overlay.draw();
  }

  get overlayLayer(): Overlay | null {
    return this.overlay;
  }

  /** 最近一帧的绘制统计，用于性能观察 */
  get frameStats(): FrameStats | null {
    return this.renderer?.stats ?? null;
  }

  get renderBackend(): string | null {
    return this.renderer?.backend ?? null;
  }

  /**
   * 把一段图片字节收进资源库。不是能解码的图片时返回 null。
   * 内容相同的图片只存一份，重复导入会得到同一个资源。
   */
  async importImage(bytes: Uint8Array, info: { mime: string; name?: string }): Promise<AssetMeta | null> {
    const size = this.images.probe(bytes);
    if (!size) return null;
    return this.assets.add(bytes, { ...info, ...size });
  }

  /** 等某个节点（含后代）里所有文本用到的字体加载完。导出之前调用，否则可能缺字 */
  async fontsReady(id: NodeId): Promise<void> {
    const root = this.store.get(id);
    if (!root) return;
    const waits: Promise<void>[] = [];
    for (const node of [root, ...descendants(this.store, id)]) {
      if (node.type === 'text') waits.push(ensureTextFonts(this.fonts, node));
    }
    await Promise.all(waits);
    // 字体的"加载完成"通知排在微任务里，等它把排版缓存清掉再继续
    await Promise.resolve();
  }

  /**
   * 把一个节点导出成 PNG（导出 JPEG 时先导出 PNG 再转）。编辑器未挂载、节点不存在或尺寸超过上限时返回 null。
   * @param scale 导出倍率，2 表示两倍图
   */
  async exportPng(id: NodeId, scale: number): Promise<Uint8Array | null> {
    await this.fontsReady(id);
    const node = this.store.get(id);
    if (!node || !this.renderer) return null;
    // 画板按自己的大小导出；别的对象按画出来的范围，描边不会被切掉一半
    return this.renderer.renderToPng(id, scale, node.type === 'artboard' ? 0 : this.geometry.drawnBounds(node));
  }

  /**
   * 把一个节点渲染成透明背景的图片，播放器用它作图层的内容。
   * 图片范围比节点的几何边界大一圈，这样描边不会被切掉；box 是这张图片对应的本地坐标范围。
   * @param scale 希望的倍率；节点太大时会自动降低，保证图片单边不超过 4096 像素
   */
  async snapshot(id: NodeId, scale: number): Promise<{ png: Uint8Array; box: Rect } | null> {
    await this.fontsReady(id);
    return this.rasterize(id, scale);
  }

  /**
   * 把一组画板导出成矢量 PDF，每个画板一页。见渲染器的 pdf.ts。
   * 字体要先加载完，排版结果才是最终的；嵌进 PDF 的字体文件在导出时另取。
   */
  async exportPdf(artboards: readonly NodeId[], options: PdfExportOptions = {}): Promise<Uint8Array> {
    // 导出器只在这里用到，用到时才加载
    const [{ exportPdf }] = await Promise.all([
      import('@shiba/renderer/pdf'),
      ...artboards.map((id) => this.fontsReady(id)),
    ]);
    return exportPdf(this.exportContext(), artboards, options);
  }

  /** 把一个画板导出成 SVG 文件的内容。见渲染器的 svg.ts */
  async exportSvg(artboard: NodeId, options: SvgExportOptions): Promise<string> {
    const [{ exportSvg }] = await Promise.all([import('@shiba/renderer/svg'), this.fontsReady(artboard)]);
    return exportSvg(this.exportContext(), artboard, options);
  }

  /**
   * 把选中的几个对象导出成一个 SVG 文件的内容，画面正好框住它们。见渲染器 svg.ts 的 exportSvgNodes。
   * ids 按从下到上的顺序给
   */
  async exportSvgNodes(ids: readonly NodeId[], options: SvgExportOptions): Promise<string> {
    const [{ exportSvgNodes }] = await Promise.all([
      import('@shiba/renderer/svg'),
      ...ids.map((id) => this.fontsReady(id)),
    ]);
    return exportSvgNodes(this.exportContext(), ids, options);
  }

  /**
   * 把一批节点各自写成可以内联进网页的 SVG，网页播放器用它们当图层。用完要 dispose
   */
  async svgLayers(nodes: readonly NodeId[]): Promise<SvgLayers> {
    const [{ SvgLayers }] = await Promise.all([
      import('@shiba/renderer/svg'),
      ...nodes.map((id) => this.fontsReady(id)),
    ]);
    return SvgLayers.create(this.exportContext(), nodes);
  }

  /**
   * 文字转轮廓：把这些文本节点换成它们转出来的路径，样子不变，之后可以当形状改。一步撤销。
   * 要等字体加载完、取字体文件读字形，所以是异步的；读不出字形的文字（字体文件取不到、不是 TrueType 轮廓）保持原样。
   * 返回换掉了的节点，它们的 id 不变，换完会被选中
   */
  async outlineText(ids: readonly NodeId[]): Promise<NodeId[]> {
    const [{ outlineTexts }] = await Promise.all([
      import('@shiba/renderer/text-outline'),
      ...ids.map((id) => this.fontsReady(id)),
    ]);
    // 字体加载完之后再取节点：等的这段时间里可能改过
    const nodes = ids.map((id) => this.store.get(id)).filter((node): node is TextNode => node?.type === 'text');
    const results = await outlineTexts(
      { ck: this.ck, layouts: this.textLayouts, fonts: this.fonts, appearances: this.textAppearances },
      nodes,
    );
    const outlines = new Map<TextNode, TextOutlinePart[]>();
    for (const node of nodes) {
      const parts = results.get(node.id);
      if (parts) outlines.set(node, parts);
    }
    try {
      const replaced = replaceTextWithOutlines(this, outlines);
      if (replaced.length > 0) this.select(replaced);
      return replaced;
    } finally {
      for (const parts of results.values()) for (const part of parts ?? []) part.path.delete();
    }
  }

  /** 导出 PDF、SVG 共用的上下文 */
  private exportContext(): PdfExportContext {
    return {
      ck: this.ck,
      store: this.store,
      registry: this.nodeTypes,
      geometry: this.geometry,
      layouts: this.textLayouts,
      fonts: this.fonts,
      appearances: this.textAppearances,
      images: this.images,
      assets: this.assets,
      // 不知道怎么写成矢量的节点画成两倍图放进去
      rasterize: (node) => this.rasterize(node.id, 2),
    };
  }

  /** snapshot 的同步部分：字体已经加载好时直接画 */
  private rasterize(id: NodeId, scale: number): { png: Uint8Array; box: Rect } | null {
    const node = this.store.get(id);
    if (!node || !this.renderer) return null;
    let padding = 1;
    for (const item of [node, ...descendants(this.store, id)]) {
      if (hasShapeStyle(item) && item.stroke) padding = Math.max(padding, item.stroke.width / 2 + 1);
    }
    const bounds = this.geometry.localBounds(node);
    const box = {
      x: bounds.x - padding,
      y: bounds.y - padding,
      w: bounds.w + padding * 2,
      h: bounds.h + padding * 2,
    };
    const limited = Math.min(scale, 4096 / Math.max(box.w, box.h, 1));
    const png = this.renderer.renderToPng(id, limited, padding);
    return png ? { png, box } : null;
  }

  /** 把一个节点画成缩略图；编辑器未挂载时返回 null */
  renderThumbnail(id: NodeId, maxWidth: number, maxHeight: number): Bitmap | null {
    return this.renderer?.renderToBitmap(id, maxWidth, maxHeight) ?? null;
  }

  dispose(): void {
    this.unmount();
    this.textLayouts.dispose();
    this.textAppearances.dispose();
    this.images.dispose();
    this.geometry.dispose();
    this.listeners.clear();
  }
}
