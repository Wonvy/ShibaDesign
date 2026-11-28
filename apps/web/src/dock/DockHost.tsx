import { ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, X } from 'lucide-react';
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CanvasHost } from '../components/CanvasHost';
import { useEditor, useEditorState } from '../editor/context';
import { openPanelMenu } from '../menus/context';
import { beginTabPointer, useTabDrag } from './drag';
import {
  activateTab,
  bringToFront,
  closeTab,
  setGroupWeights,
  setZoneCollapsed,
  setZoneSize,
  updateFloating,
  type DockLayout,
  type FloatingWindow,
  type TabGroup,
  type ZoneId,
} from './layout';
import { getDockPanel } from './registry';
import { clampToViewport, getLayout, setLayout, useDockLayout } from './store';

/** 浮动窗贴边的距离 */
const SNAP = 8;
/** 收起的停靠区那条细边的宽度 */
const STRIP = 28;

/**
 * 工作区：左栏、画布（下面是下方停靠区）、右栏，以及浮在上面的浮动窗。
 * 每个停靠区里是几组选项卡，选项卡可以拖到别的组、拖出新组、拖到画布上变成浮动窗（见 drag.ts）
 */
export function DockHost(): ReactNode {
  const layout = useDockLayout();
  const viewMode = useEditorState((s) => s.viewMode);

  // 切到幻灯片视图时，幻灯片面板在某一组里但没在看的话切过去
  useEffect(() => {
    if (viewMode !== 'slides') return;
    const current = getLayout();
    for (const zone of ['left', 'right', 'bottom'] as const) {
      const group = current.zones[zone].groups.find((g) => g.tabs.includes('slides'));
      if (group && group.active !== 'slides') setLayout(activateTab(current, 'slides'));
    }
  }, [viewMode]);

  useEffect(() => {
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);

  return (
    <div className="workspace dock-workspace">
      {!layout.hidden && <DockZone zone="left" layout={layout} />}
      <div className="dock-center">
        <CanvasHost />
        {!layout.hidden && <DockZone zone="bottom" layout={layout} />}
      </div>
      {!layout.hidden && <DockZone zone="right" layout={layout} />}
      {!layout.hidden && <FloatingLayer layout={layout} />}
      <DragOverlay />
    </div>
  );
}

function DockZone({ zone, layout }: { zone: ZoneId; layout: DockLayout }): ReactNode {
  const { t } = useTranslation();
  const data = layout.zones[zone];
  const horizontal = zone === 'bottom';
  const ref = useRef<HTMLDivElement>(null);

  if (data.groups.length === 0) {
    // 空的停靠区不占地方，拖选项卡时边上有一条可以放的细边
    return <EmptyZone zone={zone} />;
  }

  if (data.collapsed) {
    const tabs = data.groups.flatMap((g) => g.tabs);
    return (
      <div
        className={`dock-strip dock-strip-${zone}`}
        data-dock-strip={zone}
        style={horizontal ? { height: STRIP } : { width: STRIP }}
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className="dock-strip-tab"
            title={t(getDockPanel(tab)?.titleKey ?? tab)}
            onClick={() => setLayout(activateTab(getLayout(), tab))}
          >
            {t(getDockPanel(tab)?.titleKey ?? tab)}
          </button>
        ))}
      </div>
    );
  }

  const total = data.groups.reduce((sum, g) => sum + g.weight, 0) || 1;
  const style = horizontal ? { height: data.size } : { width: data.size };

  return (
    <div className={`dock-zone dock-zone-${zone}`} style={style}>
      <ZoneSplitter zone={zone} size={data.size} />
      <div className={`dock-groups${horizontal ? ' is-horizontal' : ''}`} data-dock-zone={zone} ref={ref}>
        {data.groups.map((group, index) => (
          <GroupWithSplitter
            key={group.id}
            zone={zone}
            group={group}
            index={index}
            flex={group.weight / total}
            container={ref}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyZone({ zone }: { zone: ZoneId }): ReactNode {
  const drag = useTabDrag();
  if (!drag) return null;
  return <div className={`dock-strip dock-strip-${zone} is-drop`} data-dock-strip={zone} />;
}

function CollapseButton({ zone }: { zone: ZoneId }): ReactNode {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="dock-action"
      title={t('dock.collapse')}
      aria-label={t('dock.collapse')}
      onClick={() => setLayout(setZoneCollapsed(getLayout(), zone, true))}
    >
      {zone === 'left' ? (
        <ChevronLeft size={14} />
      ) : zone === 'right' ? (
        <ChevronRight size={14} />
      ) : (
        <ChevronDown size={14} />
      )}
    </button>
  );
}

function GroupWithSplitter(props: {
  zone: ZoneId;
  group: TabGroup;
  index: number;
  flex: number;
  container: React.RefObject<HTMLDivElement | null>;
}): ReactNode {
  const { zone, group, index } = props;
  return (
    <>
      {index > 0 && <GroupSplitter zone={zone} index={index} container={props.container} />}
      <div className="dock-group" data-dock-group={group.id} style={{ flex: `${props.flex} 1 0` }}>
        <TabBar
          groupId={group.id}
          tabs={group.tabs}
          active={group.active}
          actions={index === 0 ? <CollapseButton zone={zone} /> : undefined}
        />
        <PanelBody id={group.active} />
      </div>
    </>
  );
}

/** 一排选项卡：点击切换，按住拖动，右键弹出选项卡的菜单 */
function TabBar(props: {
  groupId: string;
  tabs: readonly string[];
  active: string;
  actions?: ReactNode;
  onTitlePointerDown?: (event: ReactPointerEvent) => void;
}): ReactNode {
  const { t } = useTranslation();
  const editor = useEditor();
  return (
    <div className="dock-tabs" data-dock-tabs={props.groupId} role="tablist" onPointerDown={props.onTitlePointerDown}>
      {props.tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          data-dock-tab={tab}
          aria-selected={tab === props.active}
          className={`dock-tab${tab === props.active ? ' is-active' : ''}`}
          onPointerDown={(event) => {
            event.stopPropagation();
            beginTabPointer(tab, event);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') setLayout(activateTab(getLayout(), tab));
          }}
          onContextMenu={(event) => openPanelMenu(event, editor, 'dock.tab', tab)}
        >
          {t(getDockPanel(tab)?.titleKey ?? tab)}
        </button>
      ))}
      <div className="dock-tabs-fill" />
      {props.actions && (
        <div className="dock-actions" onPointerDown={(event) => event.stopPropagation()}>
          {props.actions}
        </div>
      )}
    </div>
  );
}

function PanelBody({ id }: { id: string }): ReactNode {
  const def = getDockPanel(id);
  if (!def) return null;
  const Component = def.component;
  return (
    <div className="dock-body" role="tabpanel">
      <Component />
    </div>
  );
}

/** 停靠区内侧的边：拖动改宽度（下方停靠区改高度），双击恢复默认 */
function ZoneSplitter({ zone, size }: { zone: ZoneId; size: number }): ReactNode {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const start = zone === 'bottom' ? event.clientY : event.clientX;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      const now = zone === 'bottom' ? e.clientY : e.clientX;
      const delta = zone === 'left' ? now - start : start - now;
      setLayout(setZoneSize(getLayout(), zone, size + delta));
    };
    const up = (): void => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`dock-splitter dock-splitter-${zone}`}
      role="separator"
      onPointerDown={onPointerDown}
      onDoubleClick={() =>
        setLayout(setZoneSize(getLayout(), zone, zone === 'bottom' ? 160 : zone === 'left' ? 236 : 284))
      }
    />
  );
}

/** 两组之间的分隔条：拖动改两组的比例 */
function GroupSplitter(props: {
  zone: ZoneId;
  index: number;
  container: React.RefObject<HTMLDivElement | null>;
}): ReactNode {
  const horizontal = props.zone === 'bottom';
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const container = props.container.current;
    if (!container) return;
    const groups = [...container.querySelectorAll<HTMLElement>(':scope > [data-dock-group]')];
    const sizes = groups.map((g) => (horizontal ? g.getBoundingClientRect().width : g.getBoundingClientRect().height));
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    const start = horizontal ? event.clientX : event.clientY;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const before = props.index - 1;
    const move = (e: PointerEvent): void => {
      const delta = (horizontal ? e.clientX : e.clientY) - start;
      const next = [...sizes];
      const min = 60;
      const a = Math.max(min, sizes[before]! + delta);
      const b = Math.max(min, sizes[before]! + sizes[props.index]! - a);
      next[before] = a;
      next[props.index] = b;
      setLayout(
        setGroupWeights(
          getLayout(),
          props.zone,
          next.map((s) => s / total),
        ),
      );
    };
    const up = (): void => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`dock-group-splitter${horizontal ? ' is-horizontal' : ''}`}
      role="separator"
      onPointerDown={onPointerDown}
    />
  );
}

function FloatingLayer({ layout }: { layout: DockLayout }): ReactNode {
  return (
    <div className="dock-floating-layer">
      {layout.floating.map((window, index) => (
        <FloatingPanel key={window.id} window={window} z={index} />
      ))}
    </div>
  );
}

/**
 * 浮动窗：拖标题栏空白处移动（贴近窗口边缘、别的浮动窗时贴上去），拖右下角改大小，
 * 双击标题栏折叠，点一下放到最上层
 */
function FloatingPanel({ window: win, z }: { window: FloatingWindow; z: number }): ReactNode {
  const { t } = useTranslation();

  const onTitlePointerDown = (event: ReactPointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: win.x, y: win.y };
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      const raw = { x: origin.x + e.clientX - startX, y: origin.y + e.clientY - startY };
      const snapped = snapWindow(win, raw);
      setLayout(updateFloating(getLayout(), win.id, snapped));
    };
    const up = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { w: win.w, h: win.h };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      setLayout(
        updateFloating(getLayout(), win.id, { w: origin.w + e.clientX - startX, h: origin.h + e.clientY - startY }),
      );
    };
    const up = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`dock-float${win.collapsed ? ' is-collapsed' : ''}`}
      style={{ left: win.x, top: win.y, width: win.w, height: win.collapsed ? undefined : win.h, zIndex: 30 + z }}
      onPointerDownCapture={() => setLayout(bringToFront(getLayout(), win.id))}
      role="dialog"
      aria-label={t(getDockPanel(win.active)?.titleKey ?? win.active)}
    >
      <div
        className="dock-float-title"
        onDoubleClick={() => setLayout(updateFloating(getLayout(), win.id, { collapsed: !win.collapsed }))}
      >
        <TabBar
          groupId={win.id}
          tabs={win.tabs}
          active={win.active}
          onTitlePointerDown={onTitlePointerDown}
          actions={
            <>
              <button
                type="button"
                className="dock-action"
                title={t(win.collapsed ? 'dock.expand' : 'dock.collapse')}
                aria-label={t(win.collapsed ? 'dock.expand' : 'dock.collapse')}
                onClick={() => setLayout(updateFloating(getLayout(), win.id, { collapsed: !win.collapsed }))}
              >
                {win.collapsed ? <Plus size={13} /> : <Minus size={13} />}
              </button>
              <button
                type="button"
                className="dock-action"
                title={t('dock.close')}
                aria-label={t('dock.close')}
                onClick={() => setLayout(win.tabs.reduce((l, tab) => closeTab(l, tab), getLayout()))}
              >
                <X size={13} />
              </button>
            </>
          }
        />
      </div>
      {!win.collapsed && (
        <>
          <PanelBody id={win.active} />
          <div className="dock-float-resize" onPointerDown={onResizePointerDown} />
        </>
      )}
    </div>
  );
}

/** 移动浮动窗时贴近窗口边缘、别的浮动窗的边时贴上去 */
function snapWindow(win: FloatingWindow, raw: { x: number; y: number }): { x: number; y: number } {
  const xs = [0, window.innerWidth];
  const ys = [44, window.innerHeight];
  for (const other of getLayout().floating) {
    if (other.id === win.id) continue;
    xs.push(other.x, other.x + other.w);
    ys.push(other.y, other.y + (other.collapsed ? 32 : other.h));
  }
  const pick = (value: number, size: number, edges: number[]): number => {
    for (const edge of edges) {
      if (Math.abs(value - edge) <= SNAP) return edge;
      if (Math.abs(value + size - edge) <= SNAP) return edge - size;
    }
    return value;
  };
  return {
    x: pick(raw.x, win.w, xs),
    y: Math.max(0, pick(raw.y, win.collapsed ? 32 : win.h, ys)),
  };
}

/** 拖选项卡时：跟着指针的名字，以及放下的位置的提示 */
function DragOverlay(): ReactNode {
  const drag = useTabDrag();
  const { t } = useTranslation();
  if (!drag) return null;
  const indicator = drag.indicator;
  const isArea = drag.target?.kind === 'float' || (indicator && indicator.width > 4 && indicator.height > 4);
  return (
    <>
      {indicator && (
        <div
          className={`dock-drop${isArea ? ' is-area' : ''}`}
          style={{ left: indicator.left, top: indicator.top, width: indicator.width, height: indicator.height }}
        />
      )}
      <div className="dock-ghost" style={{ left: drag.x + 12, top: drag.y + 8 }}>
        {t(getDockPanel(drag.tab)?.titleKey ?? drag.tab)}
      </div>
    </>
  );
}
