// The demo's entry (demo.html): the fake backend first, then the app exactly as src/main.jsx
// starts it, under /demo/.
import './install.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from '../src/App.jsx';
import ErrorBoundary from '../src/components/ErrorBoundary.jsx';
import '../src/index.css';
import { i18nReady } from '../src/i18n.js';
import DemoBanner from './DemoBanner.jsx';

const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

i18nReady.catch(() => {}).then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter basename={basename}>
          <App />
        </BrowserRouter>
        <DemoBanner />
      </ErrorBoundary>
    </React.StrictMode>
  );
});
