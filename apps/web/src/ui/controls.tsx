import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseHex, toHex, type Color } from '@shiba/core';

/** 图标按钮。title 同时用作悬停提示和无障碍名称 */
export function IconButton(props: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      className={`icon-btn${props.active ? ' is-active' : ''}`}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function Section(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="section">
      <h3 className="section-title">{props.title}</h3>
      {props.children}
    </section>
  );
}

function format(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * 数字输入框。输入过程中只改本地草稿，回车或失焦时才提交；
 * 上下方向键加减 1，按住 Shift 加减 10。
 */
export function NumberField(props: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? format(props.value);

  const clamp = (n: number): number => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, n));
  const commit = (text: string): void => {
    setDraft(null);
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed)) return;
    const next = clamp(parsed);
    if (next !== props.value) props.onCommit(next);
  };

  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        className="field-input"
        inputMode="decimal"
        value={shown}
        disabled={props.disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            const base = Number(shown);
            const next = clamp((Number.isFinite(base) ? base : props.value) + step);
            setDraft(null);
            props.onCommit(next);
          }
        }}
      />
      {props.suffix && <span className="field-suffix">{props.suffix}</span>}
    </label>
  );
}

/**
 * 颜色输入：色块（系统取色器）+ 十六进制文本。
 * 拖动取色器时连续触发 onChange，松手后触发一次 onCommit，方便调用方把整个拖动合并成一步撤销。
 */
export function ColorField(props: {
  value: Color;
  onChange: (color: Color) => void;
  onCommit: () => void;
  label: string;
}): ReactNode {
  const pickerRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const hex = toHex(props.value);
  const { onCommit } = props;

  useEffect(() => {
    // React 的 onChange 对应原生 input 事件；真正的"选完了"要听原生 change 事件
    const el = pickerRef.current;
    if (!el) return;
    el.addEventListener('change', onCommit);
    return () => el.removeEventListener('change', onCommit);
  }, [onCommit]);

  const apply = (text: string): void => {
    const parsed = parseHex(text);
    if (parsed) props.onChange({ ...parsed, a: props.value.a });
  };

  return (
    <div className="color-field">
      <input
        ref={pickerRef}
        type="color"
        className="color-swatch"
        aria-label={props.label}
        value={hex}
        onChange={(e) => apply(e.target.value)}
      />
      <input
        className="field-input color-hex"
        aria-label={`${props.label} HEX`}
        value={draft ?? hex.toUpperCase()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          apply(e.target.value);
          setDraft(null);
          onCommit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </div>
  );
}
