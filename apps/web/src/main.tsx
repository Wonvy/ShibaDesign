import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './i18n';
import { registerBuiltinPanels } from './panels';
import { initTheme } from './theme';
import './styles.css';

initTheme();
registerBuiltinPanels();

void initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
