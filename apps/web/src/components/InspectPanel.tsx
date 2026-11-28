import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cssColor, cssText, rotationOf, worldTransform, type Color, type SceneNode } from '@shiba/core';
import { useEditor, useEditorState, useSelectedNodes } from '../editor/context';
import { cssOf, selectionCss } from '../inspect';
import { displayName } from '../names';

/** 一个对象用到的颜色：填充、描边、阴影，去掉重复的 */
function colorsOf(node: SceneNode): Color[] {
  const out: Color[] = [];
  const push = (c: Color | undefined | null) => {
    if (c && !out.some((o) => cssColor(o) === cssColor(c))) out.push(c);
  };
  if ('fill' in node && node.fill?.type === 'solid') push(node.fill.color);
  if ('fill' in node && node.fill?.type === 'gradient') node.fill.stops.forEach((s) => push(s.color));
  if ('stroke' in node && node.stroke) push(node.stroke.color);
  for (const e of node.effects ?? []) if ('color' in e) push(e.color);
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100 || 0;

/**
 * 检查（只读，交付给开发看）：选中对象的尺寸、位置（相对所在画板）、旋转、颜色、文字，以及写成 CSS 的样子，一键复制。
 * 选中几个对象时按顺序列出每个的 CSS
 */
export function InspectPanel(): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const nodes = useSelectedNodes();
  useEditorState((s) => s.docVersion);
  const [copied, setCopied] = useState(false);
  if (nodes.length === 0) return <p className="empty-note dock-empty">{t('inspect.empty')}</p>;

  const copy = (): void => {
    void navigator.clipboard.writeText(selectionCss(editor)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const copyButton = (
    <button type="button" className="text-btn inspect-copy" onClick={copy}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {t(copied ? 'inspect.copied' : 'inspect.copy')}
    </button>
  );

  if (nodes.length > 1) {
    return (
      <div className="inspect">
        <p className="panel-hint">{t('inspect.many', { count: nodes.length })}</p>
        {copyButton}
        <pre className="inspect-code">{selectionCss(editor)}</pre>
      </div>
    );
  }

  const node = nodes[0]!;
  const world = worldTransform(editor.store, node.id);
  const bounds = editor.geometry.worldBounds(node);
  const board = editor.store.get(editor.store.get(node.parent ?? '')?.type === 'artboard' ? node.parent! : '');
  const origin = board ? editor.geometry.worldBounds(board) : { x: 0, y: 0 };
  const local = editor.geometry.localBounds(node);
  const degrees = round((rotationOf(world) * 180) / Math.PI);
  const colors = colorsOf(node);
  const css = cssOf(editor, node);

  return (
    <div className="inspect">
      <div className="inspect-name">{displayName(node, t, editor.store)}</div>
      <dl className="inspect-list">
        <dt>{t('inspect.size')}</dt>
        <dd>
          {round(local.w)} × {round(local.h)}
        </dd>
        <dt>{t('inspect.position')}</dt>
        <dd>
          {round(bounds.x - origin.x)}, {round(bounds.y - origin.y)}
        </dd>
        {degrees !== 0 && (
          <>
            <dt>{t('inspect.rotation')}</dt>
            <dd>{degrees}°</dd>
          </>
        )}
        {colors.length > 0 && (
          <>
            <dt>{t('inspect.colors')}</dt>
            <dd className="inspect-colors">
              {colors.map((c) => (
                <span key={cssColor(c)} className="inspect-color">
                  <span className="inspect-swatch" style={{ background: cssColor(c) }} />
                  {cssColor(c)}
                </span>
              ))}
            </dd>
          </>
        )}
        {node.type === 'text' && (
          <>
            <dt>{t('inspect.typography')}</dt>
            <dd>
              {node.style.fontFamily.latin} / {node.style.fontFamily.cjk} · {round(node.style.fontSize)}px ·{' '}
              {node.style.fontWeight}
            </dd>
          </>
        )}
      </dl>
      <div className="inspect-head">
        <span>{t('inspect.css')}</span>
        {copyButton}
      </div>
      <pre className="inspect-code">{cssText(css)}</pre>
    </div>
  );
}
