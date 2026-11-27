import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  ArrowDown,
  ArrowUp,
  BringToFront,
  Group,
  SendToBack,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Ungroup,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AlignMode, BooleanOp, DistributeMode } from '@shiba/core';
import type { OrderMode } from '@shiba/editor';
import { IconButton } from '../ui/controls';
import type { PanelProps } from './registry';

const ALIGN: { mode: AlignMode; icon: LucideIcon }[] = [
  { mode: 'left', icon: AlignStartVertical },
  { mode: 'hcenter', icon: AlignCenterVertical },
  { mode: 'right', icon: AlignEndVertical },
  { mode: 'top', icon: AlignStartHorizontal },
  { mode: 'vcenter', icon: AlignCenterHorizontal },
  { mode: 'bottom', icon: AlignEndHorizontal },
];

const DISTRIBUTE: { mode: DistributeMode; icon: LucideIcon }[] = [
  { mode: 'hspacing', icon: AlignHorizontalSpaceAround },
  { mode: 'vspacing', icon: AlignVerticalSpaceAround },
];

const ORDER: { mode: OrderMode; icon: LucideIcon }[] = [
  { mode: 'front', icon: BringToFront },
  { mode: 'forward', icon: ArrowUp },
  { mode: 'backward', icon: ArrowDown },
  { mode: 'back', icon: SendToBack },
];

const BOOLEAN: { op: BooleanOp; icon: LucideIcon }[] = [
  { op: 'union', icon: SquaresUnite },
  { op: 'subtract', icon: SquaresSubtract },
  { op: 'intersect', icon: SquaresIntersect },
  { op: 'exclude', icon: SquaresExclude },
];

export function AlignPanel({ editor }: PanelProps): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="button-row">
      {ALIGN.map(({ mode, icon: Icon }) => (
        <IconButton
          key={mode}
          title={t(`align.${mode}`)}
          disabled={!editor.commands.canRun('arrange.align', mode)}
          onClick={() => editor.commands.run('arrange.align', mode)}
        >
          <Icon size={16} />
        </IconButton>
      ))}
      <span className="row-divider" />
      {DISTRIBUTE.map(({ mode, icon: Icon }) => (
        <IconButton
          key={mode}
          title={t(`distribute.${mode}`)}
          disabled={!editor.commands.canRun('arrange.distribute', mode)}
          onClick={() => editor.commands.run('arrange.distribute', mode)}
        >
          <Icon size={16} />
        </IconButton>
      ))}
    </div>
  );
}

export function OrderPanel({ editor }: PanelProps): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="button-row">
      {ORDER.map(({ mode, icon: Icon }) => (
        <IconButton
          key={mode}
          title={t(`order.${mode}`)}
          disabled={!editor.commands.canRun('arrange.order', mode)}
          onClick={() => editor.commands.run('arrange.order', mode)}
        >
          <Icon size={16} />
        </IconButton>
      ))}
      <span className="row-divider" />
      <IconButton
        title={withKey(editor, t('group.create'), 'group.create')}
        disabled={!editor.commands.canRun('group.create')}
        onClick={() => editor.commands.run('group.create')}
      >
        <Group size={16} />
      </IconButton>
      <IconButton
        title={withKey(editor, t('group.release'), 'group.release')}
        disabled={!editor.commands.canRun('group.release')}
        onClick={() => editor.commands.run('group.release')}
      >
        <Ungroup size={16} />
      </IconButton>
    </div>
  );
}

/** 在提示文字后面附上快捷键 */
function withKey(editor: PanelProps['editor'], label: string, command: string): string {
  const key = editor.keymap.keyFor(command);
  if (!key) return label;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const pretty = key
    .split('+')
    .map((part) =>
      part === 'mod' ? (mac ? '⌘' : 'Ctrl') : part === 'shift' ? (mac ? '⇧' : 'Shift') : part.toUpperCase(),
    )
    .join(mac ? '' : '+');
  return `${label} (${pretty})`;
}

/**
 * 布尔运算。选中多个形状时，按钮把它们编成布尔组；
 * 选中一个已有的布尔组时，按钮切换它的运算类型，当前类型高亮。
 */
export function BooleanPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const only = nodes.length === 1 ? nodes[0] : undefined;
  const existing = only?.type === 'boolean' ? only : null;
  const command = existing ? 'boolean.setOp' : 'boolean.create';
  return (
    <div className="button-row">
      {BOOLEAN.map(({ op, icon: Icon }) => (
        <IconButton
          key={op}
          title={t(`boolean.${op}`)}
          active={existing?.op === op}
          disabled={!editor.commands.canRun(command, op)}
          onClick={() => editor.commands.run(command, op)}
        >
          <Icon size={16} />
        </IconButton>
      ))}
      <span className="row-divider" />
      <IconButton
        title={t('boolean.release')}
        disabled={!editor.commands.canRun('boolean.release')}
        onClick={() => editor.commands.run('boolean.release')}
      >
        <Ungroup size={16} />
      </IconButton>
    </div>
  );
}
