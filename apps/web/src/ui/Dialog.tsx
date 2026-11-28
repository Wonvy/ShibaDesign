import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 模态对话框：标题、内容、取消和确认两个按钮。点背景或按 Esc 关闭，回车确认。
 * 对话框里的按键不会传到编辑器的快捷键（否则按 Delete 会删掉画布上的东西）
 */
export function Dialog(props: {
  title: string;
  submitLabel: string;
  cancelLabel: string;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const { onClose, onSubmit } = props;
  const submitRef = useRef<HTMLButtonElement>(null);
  useEffect(() => submitRef.current?.focus(), []);

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
        }}
      >
        <h2 className="dialog-title">{props.title}</h2>
        {props.children}
        <div className="dialog-actions">
          <button type="button" className="text-btn" onClick={onClose}>
            {props.cancelLabel}
          </button>
          <button type="submit" className="text-btn is-primary" ref={submitRef}>
            {props.submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/** 对话框里的一个单选项，可以带一行说明 */
export function DialogOption(props: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <label className={`dialog-option${props.disabled ? ' is-disabled' : ''}`}>
      <input
        type="radio"
        name={props.name}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onSelect}
      />
      <span className="dialog-option-text">
        <span>{props.label}</span>
        {props.hint && <span className="dialog-hint">{props.hint}</span>}
      </span>
    </label>
  );
}
