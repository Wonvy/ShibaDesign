import { Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { THEMES, setThemePreference, useTheme } from '../theme';
import { Menu, MenuItem } from '../ui/Menu';

export function ThemeMenu(): ReactNode {
  const { t } = useTranslation();
  const { preference, theme } = useTheme();
  const Icon = preference === 'system' ? Monitor : theme.scheme === 'dark' ? Moon : Sun;

  return (
    <Menu label={t('theme.label')} trigger={<Icon size={16} />}>
      {(close) => (
        <>
          <MenuItem
            checked={preference === 'system'}
            onClick={() => {
              setThemePreference('system');
              close();
            }}
          >
            {t('theme.system')}
          </MenuItem>
          {THEMES.map((def) => (
            <MenuItem
              key={def.id}
              checked={preference === def.id}
              onClick={() => {
                setThemePreference(def.id);
                close();
              }}
            >
              {t(def.labelKey)}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}
