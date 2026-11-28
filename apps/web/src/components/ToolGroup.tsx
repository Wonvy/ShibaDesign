import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, useEditorState } from '../editor/context';
import type { ToolbarGroup } from '../toolbar';
import { formatShortcut } from '../ui/shortcut';

/** 每一组上次用的工具，记在浏览器里 */
const KEY = 'shiba.toolGroups';

function loadChoices(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * 顶栏上的一组工具：按钮显示这一组上次用的工具，单击切过去，双击锁住（画完不回到选择工具，再双击解开）；
 * 右下角的小三角、右键或者按住不放展开整组
 */
export function ToolGroup({ group }: { group: ToolbarGroup }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const tool = useEditorState((s) => s.tool);
  const locked = useEditorState((s) => s.lockedTool);
  const [choice, setChoice] = useState(() => loadChoices()[group.id]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 用快捷键切到这一组里的别的工具时，按钮也换成它
  const inGroup = group.tools.find((item) => item.tool === tool);
  useEffect(() => {
    if (!inGroup || inGroup.tool === choice) return;
    setChoice(inGroup.tool);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...loadChoices(), [group.id]: inGroup.tool }));
    } catch {
      // 存不了就只在这次打开里记着
    }
  }, [inGroup, choice, group.id]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const current = group.tools.find((item) => item.tool === choice) ?? group.tools[0]!;
  const Icon = current.icon;
  const label = (id: string, labelKey: string): string => {
    const key = editor.keymap.keyFor('tool.set', id);
    return key ? `${t(labelKey)} (${formatShortcut(key)})` : t(labelKey);
  };
  const isActive = group.tools.some((item) => item.tool === tool);
  const isLocked = isActive && locked === tool;

  return (
    <div className="tool-group" ref={rootRef}>
      <button
        type="button"
        className={`icon-btn${isActive ? ' is-active' : ''}${isLocked ? ' is-locked' : ''}`}
        title={`${label(current.tool, current.labelKey)} · ${t('toolbar.lockHint')}`}
        aria-label={t(current.labelKey)}
        aria-pressed={isActive}
        onClick={() => {
          // 锁着时单击解锁（工具不变）
          if (isLocked) editor.lockTool(current.tool);
          else editor.commands.run('tool.set', current.tool);
        }}
        onDoubleClick={() => editor.lockTool(current.tool)}
        onContextMenu={(event) => {
          if (group.tools.length < 2) return;
          event.preventDefault();
          setOpen(true);
        }}
        onPointerDown={() => {
          if (group.tools.length < 2) return;
          holdTimer.current = setTimeout(() => setOpen(true), 450);
        }}
        onPointerUp={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
        }}
        onPointerLeave={() => {
          if (holdTimer.current) clearTimeout(holdTimer.current);
        }}
      >
        <Icon size={16} />
        {group.tools.length > 1 && <span className="tool-group-mark" aria-hidden="true" />}
      </button>
      {open && (
        <div className="menu-popover tool-group-popover" role="menu">
          {group.tools.map((item) => {
            const ItemIcon = item.icon;
            const key = editor.keymap.keyFor('tool.set', item.tool);
            return (
              <button
                key={item.tool}
                type="button"
                role="menuitemradio"
                aria-checked={item.tool === tool}
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  editor.commands.run('tool.set', item.tool);
                }}
              >
                <ItemIcon size={15} />
                <span className="menu-text">{t(item.labelKey)}</span>
                {key && <span className="menu-shortcut">{formatShortcut(key)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
