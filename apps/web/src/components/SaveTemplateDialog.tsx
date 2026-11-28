import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor } from '../editor/context';
import { saveAsTemplate, useFileState } from '../files';
import { MAX_TEMPLATE_NAME } from '../templates/library';
import { Dialog } from '../ui/Dialog';

/** 存为模板：起个名字，把当前文档连同图片存进"我的模板" */
export function SaveTemplateDialog(props: { onClose: () => void }): ReactNode {
  const editor = useEditor();
  const { t } = useTranslation();
  const file = useFileState();
  const [name, setName] = useState(() => file.name?.replace(/\.shiba$/i, '') ?? t('template.defaultName'));
  const { onClose } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  // 对话框打开时会把焦点放到确认按钮上（在这里的效果之后执行），等它放完再选中名字，方便直接改
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <Dialog
      title={t('template.saveTitle')}
      submitLabel={t('template.save')}
      cancelLabel={t('template.cancel')}
      onClose={onClose}
      onSubmit={() => {
        const trimmed = name.trim();
        if (!trimmed) return;
        onClose();
        void saveAsTemplate(editor, trimmed);
      }}
    >
      <label className="dialog-field dialog-text-field">
        <span className="dialog-hint">{t('template.nameLabel')}</span>
        <input
          className="field-input"
          value={name}
          ref={inputRef}
          maxLength={MAX_TEMPLATE_NAME}
          aria-label={t('template.nameLabel')}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p className="dialog-hint">{t('template.saveHint')}</p>
    </Dialog>
  );
}
