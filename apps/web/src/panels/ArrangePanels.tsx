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
  Crop,
  Group,
  Hash,
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
import { MASK_MODES, type AlignMode, type BooleanOp, type DistributeMode } from '@shiba/core';
import type { OrderMode } from '@shiba/editor';
import { IconButton } from '../ui/controls';
import { formatShortcut } from '../ui/shortcut';
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
      <IconButton
        title={withKey(editor, t('frame.wrap'), 'frame.wrap')}
        disabled={!editor.commands.canRun('frame.wrap')}
        onClick={() => editor.commands.run('frame.wrap')}
      >
        <Hash size={16} />
      </IconButton>
    </div>
  );
}

/** 在提示文字后面附上快捷键 */
function withKey(editor: PanelProps['editor'], label: string, command: string): string {
  const key = editor.keymap.keyFor(command);
  return key ? `${label} (${formatShortcut(key)})` : label;
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

/**
 * 蒙版：选了两个以上的对象时可以创建（最上面的那个当蒙版）；选中蒙版组时可以换模式或者释放
 */
export function MaskPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const only = nodes.length === 1 ? nodes[0] : undefined;
  const group = only?.type === 'group' && only.mask ? only : null;
  if (!group) {
    return (
      <div className="mask-panel">
        <button
          type="button"
          className="text-btn mask-create"
          disabled={!editor.commands.canRun('mask.create')}
          onClick={() => editor.commands.run('mask.create')}
        >
          <Crop size={14} />
          {t('mask.create')}
        </button>
        <p className="menu-hint">{t('mask.createHint')}</p>
      </div>
    );
  }
  return (
    <div className="mask-panel">
      <div className="button-row">
        <div className="segmented segmented-small" role="radiogroup" aria-label={t('panel.mask')}>
          {MASK_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={group.mask === mode}
              className={group.mask === mode ? 'is-active' : ''}
              title={t(`mask.${mode}Hint`)}
              onClick={() => editor.commands.run('mask.setMode', mode)}
            >
              {t(`mask.${mode}`)}
            </button>
          ))}
        </div>
        <span className="row-divider" />
        <IconButton title={t('mask.release')} onClick={() => editor.commands.run('mask.release')}>
          <Ungroup size={16} />
        </IconButton>
      </div>
      <p className="menu-hint">{t(`mask.${group.mask}Hint`)}</p>
    </div>
  );
}
