import { Download, Languages, Trash2, Upload } from 'lucide-react';
import { useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PackError,
  exportLocale,
  importLocale,
  listLocales,
  removeCustomLocale,
  setLocale,
  subscribeLocales,
} from '../i18n';
import { Menu, MenuItem } from '../ui/Menu';
import { toast } from '../ui/toast';

function download(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** 语言菜单：切换语言，导出语言包去翻译，导入翻译好的语言包 */
export function LanguageMenu(): ReactNode {
  const { t, i18n } = useTranslation();
  const locales = useSyncExternalStore(subscribeLocales, listLocales);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = i18n.language;

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const result = await importLocale(await file.text());
      // 导入后界面已经切到新语言，所以这里用 i18n.t 取新语言的提示文字
      toast(
        result.missing > 0
          ? i18n.t('language.importedMissing', { name: result.name, count: result.missing })
          : i18n.t('language.imported', { name: result.name }),
      );
    } catch (error) {
      const reason = error instanceof PackError ? error.reason : 'notJson';
      toast(t('language.invalid', { reason: t(`language.reason.${reason}`) }), 'error');
    }
  };

  return (
    <>
      <Menu label={t('language.label')} trigger={<Languages size={16} />}>
        {(close) => (
          <>
            {locales.map((locale) => (
              <MenuItem
                key={locale.code}
                checked={locale.code === current}
                onClick={() => {
                  void setLocale(locale.code);
                  close();
                }}
                trailing={
                  locale.custom ? (
                    <button
                      type="button"
                      className="menu-icon"
                      title={t('language.remove')}
                      aria-label={`${t('language.remove')}: ${locale.name}`}
                      onClick={() => void removeCustomLocale(locale.code)}
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : undefined
                }
              >
                {locale.name}
                {locale.custom && <span className="badge">{t('language.custom')}</span>}
              </MenuItem>
            ))}
            <div className="menu-separator" />
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                const file = exportLocale(current);
                download(file.filename, file.content);
                close();
              }}
            >
              <Download size={14} className="menu-check" />
              <span className="menu-text">{t('language.export')}</span>
            </button>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                fileRef.current?.click();
                close();
              }}
            >
              <Upload size={14} className="menu-check" />
              <span className="menu-text">{t('language.import')}</span>
            </button>
            <p className="menu-hint">{t('language.hint')}</p>
          </>
        )}
      </Menu>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </>
  );
}
