import React from 'react';
import ReactDOM from 'react-dom/client';
import SecureMessagePage, { tokenFromPath } from './SecureMessagePage.jsx';

// The recipient's page (secure.html), its own entry: none of the mail app is loaded.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SecureMessagePage token={tokenFromPath(window.location.pathname)} />
  </React.StrictMode>
);
