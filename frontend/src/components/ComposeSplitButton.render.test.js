// The Compose button's arrow: a menu with "Compose in a new window", opened from the keyboard too.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ComposeSplitButton = (await import('./ComposeSplitButton.jsx')).default;

describe('ComposeSplitButton', () => {
  let root;
  const mount = async props => {
    root = createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(ComposeSplitButton, { icon: null, ...props })));
  };
  afterEach(async () => { await React.act(async () => root.unmount()); });
  const arrow = () => document.querySelector('[aria-haspopup="menu"]');
  const click = el => React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });

  test('the button composes in the app and the arrow stays closed', async () => {
    let composed = 0;
    await mount({ onCompose: () => { composed++; }, onComposeWindow: () => {} });
    await click(document.querySelector('button'));
    assert.equal(composed, 1);
    assert.equal(arrow().getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('[role="menu"]'), null);
  });

  test('the arrow opens a menu whose item opens the window, then closes it', async () => {
    let windows = 0;
    await mount({ onCompose: () => {}, onComposeWindow: () => { windows++; } });
    await click(arrow());
    assert.equal(arrow().getAttribute('aria-expanded'), 'true');
    const item = document.querySelector('[role="menuitem"]');
    assert.equal(item.textContent, 'sidebar.composeNewWindow');
    await click(item);
    assert.equal(windows, 1);
    assert.equal(document.querySelector('[role="menu"]'), null);
  });

  test('Escape closes the menu and the focus returns to the arrow', async () => {
    await mount({ onCompose: () => {}, onComposeWindow: () => {} });
    await click(arrow());
    const menu = document.querySelector('[role="menu"]');
    await React.act(async () => { menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, arrow());
  });

  test('no arrow without a window action (a phone) or in the collapsed sidebar', async () => {
    await mount({ onCompose: () => {} });
    assert.equal(arrow(), null);
    await React.act(async () => root.unmount());
    await mount({ onCompose: () => {}, onComposeWindow: () => {}, collapsed: true });
    assert.equal(arrow(), null);
  });
});
