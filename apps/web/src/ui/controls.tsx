import { ChevronDown, ChevronRight, Pipette } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { evaluateNumberInput, parseColorText, toHex, type Color } from '@shiba/core';
import { useEditorMaybe } from '../editor/context';
import { documentColors, pushRecentColor, recentColors } from './colors';

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

const SECTIONS_KEY = 'shiba.sections';

/** 折起来的分区（按分区 id 记在浏览器里，下次打开还是折着的） */
function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify([...ids]));
  } catch {
    // 隐私模式下存不了，不影响使用
  }
}

/** 属性栏的一节。给了 id 时标题可以点，折起来或展开，记住状态 */
export function Section(props: { id?: string; title: string; children: ReactNode; actions?: ReactNode }): ReactNode {
  const { id } = props;
  const [collapsed, setCollapsed] = useState(() => (id ? loadCollapsed().has(id) : false));
  const toggle = (): void => {
    if (!id) return;
    const ids = loadCollapsed();
    if (collapsed) ids.delete(id);
    else ids.add(id);
    saveCollapsed(ids);
    setCollapsed(!collapsed);
  };
  return (
    <section className={`section${collapsed ? ' is-collapsed' : ''}`}>
      <h3 className="section-title">
        {id ? (
          <button type="button" className="section-toggle" aria-expanded={!collapsed} onClick={toggle}>
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span>{props.title}</span>
          </button>
        ) : (
          <span>{props.title}</span>
        )}
        {props.actions}
      </h3>
      {!collapsed && props.children}
    </section>
  );
}

function format(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * 数字输入框。输入过程中只改本地草稿，回车或失焦时才提交（Tab 跳到下一个框也会提交）；Esc 恢复。
 * 能输入算式：`100+20`、`*2`（现在的两倍）、`/3`、`+10`、`50%`（现在的一半），见 core 的 expression.ts。
 * 上下方向键加减 1，按住 Shift 加减 10。按住标签左右拖动改数值（Shift 每像素 10，Alt 每像素 0.1），整个拖动是一步撤销。
 */
export function NumberField(props: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
  /** 选中的几个对象（或几段字）这一项不一样：显示为空白，输入后统一改成新值 */
  mixed?: boolean;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const editor = useEditorMaybe();
  const shown = draft ?? (props.mixed ? '' : format(props.value));
  // 拖标签时每一帧都用最新的提交函数：调用方的函数里往往带着这一刻的选区范围，用旧的会越改越偏
  const commitRef = useRef(props.onCommit);
  commitRef.current = props.onCommit;

  const clamp = (n: number): number => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, n));
  const commit = (text: string): void => {
    setDraft(null);
    const parsed = evaluateNumberInput(text, props.value);
    if (parsed === null) return;
    const next = clamp(Math.round(parsed * 10000) / 10000);
    if (next !== props.value || props.mixed) props.onCommit(next);
  };

  /** 按住标签左右拖：每移动一像素加减 1（Shift 10，Alt 0.1），整个拖动合成一步撤销 */
  const startScrub = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    if (props.disabled || event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // 拿不到指针（比如脚本模拟的事件）也照样能拖，只是移出标签后收不到移动
    }
    const startX = event.clientX;
    const base = props.mixed ? 0 : props.value;
    let last = base;
    editor?.store.beginGroup();
    const move = (e: PointerEvent): void => {
      const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const next = clamp(Math.round((base + Math.round(e.clientX - startX) * step) * 100) / 100);
      if (next === last) return;
      last = next;
      commitRef.current(next);
    };
    const up = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      editor?.store.endGroup();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  return (
    <label className="field">
      <span className={`field-label${props.disabled ? '' : ' is-scrubbable'}`} onPointerDown={startScrub}>
        {props.label}
      </span>
      <input
        className="field-input"
        inputMode="decimal"
        value={shown}
        placeholder={props.mixed ? '—' : undefined}
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
  const [palette, setPalette] = useState(false);
  const { t } = useTranslation();
  const editor = useEditorMaybe();
  const hex = toHex(props.value);
  const { onCommit } = props;
  /** 选定一个颜色：改值、提交、记进最近用过的颜色 */
  const choose = (color: Color): void => {
    props.onChange({ ...color, a: props.value.a });
    onCommit();
    pushRecentColor(color);
  };
  const eyeDropper = typeof window !== 'undefined' ? (window as { EyeDropper?: EyeDropperCtor }).EyeDropper : undefined;

  useEffect(() => {
    // React 的 onChange 对应原生 input 事件；真正的"选完了"要听原生 change 事件
    const el = pickerRef.current;
    if (!el) return;
    el.addEventListener('change', onCommit);
    return () => el.removeEventListener('change', onCommit);
  }, [onCommit]);

  const apply = (text: string): void => {
    const parsed = parseColorText(text);
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
          const parsed = parseColorText(e.target.value);
          if (parsed) pushRecentColor(parsed);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {eyeDropper && (
        <button
          type="button"
          className="icon-btn color-tool"
          title={t('color.eyedropper')}
          aria-label={t('color.eyedropper')}
          onClick={() => {
            // 浏览器的吸管（Chromium 内核才有）：能取屏幕上任何地方的颜色
            new eyeDropper()
              .open()
              .then((result) => {
                const parsed = parseColorText(result.sRGBHex);
                if (parsed) choose(parsed);
              })
              .catch(() => undefined);
          }}
        >
          <Pipette size={13} />
        </button>
      )}
      <button
        type="button"
        className={`icon-btn color-tool${palette ? ' is-active' : ''}`}
        title={t('color.palette')}
        aria-label={t('color.palette')}
        aria-expanded={palette}
        onClick={() => setPalette((open) => !open)}
      >
        <ChevronDown size={13} />
      </button>
      {palette && (
        <ColorPalette
          recent={recentColors()}
          document={editor ? documentColors(editor.store) : []}
          onPick={(color) => {
            choose(color);
            setPalette(false);
          }}
        />
      )}
    </div>
  );
}

interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}

/** 颜色输入框下面展开的色板：最近用过的颜色、文档里用到的颜色 */
function ColorPalette(props: { recent: Color[]; document: Color[]; onPick: (color: Color) => void }): ReactNode {
  const { t } = useTranslation();
  const row = (title: string, colors: Color[]) =>
    colors.length > 0 && (
      <div className="palette-row">
        <span className="palette-title">{title}</span>
        <div className="palette-swatches">
          {colors.map((c) => (
            <button
              key={toHex(c) + c.a}
              type="button"
              className="palette-swatch"
              title={toHex(c).toUpperCase()}
              aria-label={toHex(c).toUpperCase()}
              style={{ background: toHex(c) }}
              onClick={() => props.onPick(c)}
            />
          ))}
        </div>
      </div>
    );
  return (
    <div className="color-palette">
      {row(t('color.recent'), props.recent)}
      {row(t('color.document'), props.document)}
      {props.recent.length === 0 && props.document.length === 0 && (
        <p className="panel-hint">{t('color.paletteEmpty')}</p>
      )}
    </div>
  );
}
