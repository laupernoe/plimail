import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './index.css';
import i18n, { i18nReady } from './i18n.js';
import { stashMailtoFromLocation } from './utils/mailtoLink.js';
import { captureInstallPrompt } from './utils/installPrompt.js';
import { setUnreachableText, watchConnection } from './utils/offlineCache.js';

// Before the router renders: a signed-out visitor is redirected to /login, which would drop it.
try { stashMailtoFromLocation({ location: window.location, history: window.history, storage: sessionStorage }); } catch { /* no session storage */ }
// The browser offers installation once, early, often before Settings is open.
captureInstallPrompt(window);
watchConnection(window);
setUnreachableText(() => i18n.t('app.offline.unreachable'));

// ErrorBoundary sits outside the router: a throw during routing or in any screen below it
// would otherwise unmount everything and leave a blank page with no explanation (#441).
// Drawn once the starting language is in (i18n.js): at once for English, a moment for another.
i18nReady.catch(() => {}).then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>
  );
});
