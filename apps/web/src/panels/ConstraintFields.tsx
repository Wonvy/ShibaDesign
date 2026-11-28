import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_CONSTRAINTS,
  H_CONSTRAINTS,
  V_CONSTRAINTS,
  type Constraints,
  type HConstraint,
  type SceneNode,
  type VConstraint,
} from '@shiba/core';
import type { Editor } from '@shiba/editor';

/** 选中的对象都直接放在画框或画板里时才有约束可设 */
export function constrainable(editor: Editor, nodes: readonly SceneNode[]): boolean {
  return (
    nodes.length > 0 &&
    nodes.every((n) => {
      const parent = n.parent ? editor.store.get(n.parent) : undefined;
      return n.type !== 'artboard' && (parent?.type === 'frame' || parent?.type === 'artboard');
    })
  );
}

const constraintsOf = (node: SceneNode): Constraints => node.constraints ?? DEFAULT_CONSTRAINTS;

/**
 * 约束：一个小图（方框，四条边和中间的十字可以点）加两个下拉框。
 * 点左边是靠左，按住 Shift 再点右边是左右都靠；点中间的竖线是水平居中。上下同理。
 * 几个对象不一样时下拉框显示空白，小图上只亮第一个的
 */
export function ConstraintFields({ editor, nodes }: { editor: Editor; nodes: readonly SceneNode[] }): ReactNode {
  const { t } = useTranslation();
  const first = constraintsOf(nodes[0]!);
  const hMixed = nodes.some((n) => constraintsOf(n).h !== first.h);
  const vMixed = nodes.some((n) => constraintsOf(n).v !== first.v);

  const set = (patch: Partial<Constraints>): void => {
    editor.updateSelection('constraints', (node) => {
      const next = { ...constraintsOf(node), ...patch };
      // 靠左靠上就是默认，不写进文件
      return { constraints: next.h === 'left' && next.v === 'top' ? undefined : next };
    });
    editor.store.sealHistory();
  };

  /** 点小图上的一条边：按住 Shift 时和对边合成"两头都靠" */
  const pickH = (side: 'left' | 'right' | 'center', shift: boolean): void => {
    if (shift && side !== 'center' && (first.h === 'left' || first.h === 'right') && first.h !== side) {
      set({ h: 'leftRight' });
    } else set({ h: side });
  };
  const pickV = (side: 'top' | 'bottom' | 'center', shift: boolean): void => {
    if (shift && side !== 'center' && (first.v === 'top' || first.v === 'bottom') && first.v !== side) {
      set({ v: 'topBottom' });
    } else set({ v: side });
  };

  const on = {
    left: first.h === 'left' || first.h === 'leftRight',
    right: first.h === 'right' || first.h === 'leftRight',
    hCenter: first.h === 'center',
    top: first.v === 'top' || first.v === 'topBottom',
    bottom: first.v === 'bottom' || first.v === 'topBottom',
    vCenter: first.v === 'center',
  };
  const bar = (key: keyof typeof on, x: number, y: number, w: number, h: number, onPick: (shift: boolean) => void) => (
    <rect
      key={key}
      className={`constraint-bar${on[key] ? ' is-on' : ''}`}
      x={x}
      y={y}
      width={w}
      height={h}
      rx={1}
      onClick={(event) => onPick(event.shiftKey)}
    />
  );

  return (
    <div className="constraint-fields">
      <svg className="constraint-diagram" viewBox="0 0 56 56" role="group" aria-label={t('prop.constraints')}>
        <rect className="constraint-frame" x={1} y={1} width={54} height={54} rx={4} />
        <rect className="constraint-box" x={18} y={18} width={20} height={20} rx={2} />
        {/* 点中的范围比画出来的线粗一些 */}
        {bar('left', 4, 25, 12, 6, (s) => pickH('left', s))}
        {bar('right', 40, 25, 12, 6, (s) => pickH('right', s))}
        {bar('top', 25, 4, 6, 12, (s) => pickV('top', s))}
        {bar('bottom', 25, 40, 6, 12, (s) => pickV('bottom', s))}
        {bar('hCenter', 26, 20, 4, 16, () => set({ h: 'center' }))}
        {bar('vCenter', 20, 26, 16, 4, () => set({ v: 'center' }))}
      </svg>
      <div className="constraint-selects">
        <select
          className="select"
          aria-label={t('prop.constraintH')}
          value={hMixed ? '' : first.h}
          onChange={(event) => set({ h: event.target.value as HConstraint })}
        >
          {hMixed && <option value="" />}
          {H_CONSTRAINTS.map((c) => (
            <option key={c} value={c}>
              {t(`prop.constraint_${c}`)}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label={t('prop.constraintV')}
          value={vMixed ? '' : first.v}
          onChange={(event) => set({ v: event.target.value as VConstraint })}
        >
          {vMixed && <option value="" />}
          {V_CONSTRAINTS.map((c) => (
            <option key={c} value={c}>
              {t(`prop.constraint_${c}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
