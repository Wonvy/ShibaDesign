import { RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { artboardOf, rotationOf, topLevelOnly } from '@shiba/core';
import { captureOriginals, resizeInWorld, resizeLocal, translateNode } from '@shiba/editor';
import { IconButton, NumberField } from '../ui/controls';
import { CornerFields, roundable } from './CornerFields';
import type { PanelProps } from './registry';

/** 翻转图标：一条虚线对称轴，两侧各一个三角形 */
function FlipIcon({ vertical }: { vertical?: boolean }): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={vertical ? { transform: 'rotate(90deg)' } : undefined}
    >
      <path d="M12 3v18" strokeDasharray="2 3" />
      <path d="M8 7 3 17h5z" />
      <path d="m16 7 5 10h-5z" />
    </svg>
  );
}

/** 把角度规整到 (-180, 180]，并去掉浮点误差带来的 -0 和 89.99999 */
function tidyAngle(radians: number): number {
  let degrees = Math.round(((radians * 180) / Math.PI) * 100) / 100;
  if (degrees <= -180) degrees += 360;
  return degrees === 0 ? 0 : degrees;
}

/**
 * 位置、大小与旋转。
 * 位置是选区外接矩形的左上角；画板里的对象相对所在画板计算，和幻灯片软件的习惯一致。
 * 只选一个对象时，宽高是对象自己的宽高（不受旋转影响，组件实例算上它的整体缩放）；多选时是整体外接矩形的宽高。
 */
export function TransformPanel({ editor, nodes }: PanelProps): ReactNode {
  const { t } = useTranslation();
  const { store } = editor;
  const bounds = editor.selectionBounds();
  const frame = editor.selectionFrame();
  if (!bounds || !frame) return null;

  const { single } = frame;
  const first = nodes[0]!;
  const board = first.type === 'artboard' ? null : artboardOf(store, first.id);
  const origin = board ? editor.geometry.worldBounds(board) : { x: 0, y: 0 };
  const ids = topLevelOnly(store, editor.selection);
  // 只选一个对象时按它在画布上的实际大小显示：组件实例整体缩放过（缩放写在变换矩阵里），本地的宽高要乘上缩放
  const scaleX = single ? Math.hypot(single.world[0], single.world[1]) || 1 : 1;
  const scaleY = single ? Math.hypot(single.world[2], single.world[3]) || 1 : 1;
  const width = single ? single.box.w * scaleX : bounds.w;
  const height = single ? single.box.h * scaleY : bounds.h;
  const angle = single ? tidyAngle(rotationOf(single.world)) : 0;

  const moveBy = (dx: number, dy: number): void => {
    store.transact('move', (tx) => ids.forEach((id) => translateNode(tx, store, id, dx, dy)));
    store.sealHistory();
  };

  const resizeTo = (w: number, h: number): void => {
    const originals = captureOriginals(store, ids, (node) => editor.textLayouts.get(node).width);
    store.transact('resize', (tx) => {
      if (single)
        resizeLocal(tx, store, originals, single.id, single.box, { ...single.box, w: w / scaleX, h: h / scaleY });
      else resizeInWorld(tx, store, originals, ids, bounds, { ...bounds, w, h });
    });
    store.sealHistory();
  };

  const corners = roundable(nodes);

  return (
    <>
      <div className="field-grid">
        <NumberField
          label={t('prop.x')}
          value={bounds.x - origin.x}
          onCommit={(v) => moveBy(v - (bounds.x - origin.x), 0)}
        />
        <NumberField
          label={t('prop.y')}
          value={bounds.y - origin.y}
          onCommit={(v) => moveBy(0, v - (bounds.y - origin.y))}
        />
        <NumberField
          label={t('prop.width')}
          value={width}
          min={1}
          disabled={width === 0}
          onCommit={(v) => resizeTo(v, height)}
        />
        <NumberField
          label={t('prop.height')}
          value={height}
          min={1}
          disabled={height === 0 || first.type === 'text'}
          onCommit={(v) => resizeTo(width, v)}
        />
        {frame.rotatable && single && (
          <NumberField
            label={t('prop.rotation')}
            value={angle}
            suffix="°"
            onCommit={(v) => editor.commands.run('arrange.rotate', v - angle)}
          />
        )}
      </div>
      {corners && <CornerFields editor={editor} nodes={corners} />}
      {frame.rotatable && (
        <div className="button-row transform-actions">
          <IconButton title={t('transform.rotate90')} onClick={() => editor.commands.run('arrange.rotate', 90)}>
            <RotateCw size={16} />
          </IconButton>
          <IconButton title={t('transform.flipH')} onClick={() => editor.commands.run('arrange.flip', 'horizontal')}>
            <FlipIcon />
          </IconButton>
          <IconButton title={t('transform.flipV')} onClick={() => editor.commands.run('arrange.flip', 'vertical')}>
            <FlipIcon vertical />
          </IconButton>
        </div>
      )}
    </>
  );
}
