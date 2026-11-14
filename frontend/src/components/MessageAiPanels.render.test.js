// Translate and "Is this a scam?" on a received message: the menu entries, the verdict card and
// the translation panel.

import { test, describe } from 'node:test';
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
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { MessageTools } = await import('./MessageActions.jsx');
const { ScamCheckCard, TranslationPanel, withMailActions, MailAiPanels } = await import('./MessageAiPanels.jsx');
const { SCAM_ACTION_ID, TRANSLATE_ACTION_ID } = await import('../hooks/useMessageAiTools.js');

let root;
async function render(element) {
  root ??= createRoot(document.getElementById('root'));
  await React.act(async () => root.render(element));
  return document.getElementById('root');
}
const click = async (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const byText = (container, text) => [...container.querySelectorAll('button, [role="menuitem"]')].find(b => b.textContent.includes(text));

function fakeMailAi(overrides = {}) {
  const calls = [];
  return {
    calls,
    translation: null,
    scam: null,
    userLanguage: 'fr',
    translate: (lang) => calls.push(['translate', lang]),
    checkScam: () => calls.push(['scam']),
    toggleOriginal: () => calls.push(['toggle']),
    dismiss: (kind) => calls.push(['dismiss', kind]),
    ...overrides,
  };
}

describe('Translate and "Is this a scam?" in the AI menu', () => {
  const base = {
    items: [{ id: 'summarize', label: 'message.summarize' }, { id: 'custom', label: 'Custom' }],
    results: {},
    onRun: () => {},
  };

  test('come right after the summary, and run their own actions', () => {
    const mailAi = fakeMailAi();
    const ran = [];
    const ai = withMailActions({ ...base, onRun: a => ran.push(a.id) }, mailAi, k => k);
    assert.deepEqual(ai.items.map(i => i.id), ['summarize', TRANSLATE_ACTION_ID, SCAM_ACTION_ID, 'custom']);
    ai.onRun({ id: TRANSLATE_ACTION_ID });
    ai.onRun({ id: SCAM_ACTION_ID });
    ai.onRun({ id: 'custom' });
    assert.deepEqual(mailAi.calls, [['translate', undefined], ['scam']]);
    assert.deepEqual(ran, ['custom']);
  });

  test('are absent when AI is off for the message', () => {
    assert.equal(withMailActions(null, fakeMailAi(), k => k), null);
  });

  test('show as buttons in the desktop AI dropdown', async () => {
    const mailAi = fakeMailAi();
    const el = await render(React.createElement(MessageTools, { isMobile: false, items: [], ai: withMailActions(base, mailAi, k => k) }));
    await click(el.querySelector('button[aria-haspopup]'));
    const translate = byText(document.body, 'message.translate');
    assert.ok(translate, 'Translate is in the menu');
    assert.ok(byText(document.body, 'message.scamCheck'), 'Is this a scam? is in the menu');
    await click(translate);
    assert.deepEqual(mailAi.calls, [['translate', undefined]]);
  });

  test('show in the phone More menu', async () => {
    const mailAi = fakeMailAi();
    const el = await render(React.createElement(MessageTools, { isMobile: true, items: [], ai: withMailActions(base, mailAi, k => k) }));
    await click(el.querySelector('button[aria-haspopup]'));
    await click(byText(document.body, 'message.scamCheck'));
    assert.deepEqual(mailAi.calls, [['scam']]);
  });
});

describe('scam check card', () => {
  const flags = [
    { type: 'link_mismatch', shown: 'paypal.com', actual: 'evil.io' },
    { type: 'double_extension', name: 'a.pdf.exe' },
    { type: 'something_new' },
  ];

  test('shows the verdict, confidence, reasons, advice and the red flags', async () => {
    const el = await render(React.createElement(ScamCheckCard, {
      result: { status: 'done', flags, analysis: { verdict: 'scam', confidence: 0.9, reasons: ['Fake domain'], advice: 'Delete it.' }, error: null },
      onRetry() {}, onDismiss() {},
    }));
    assert.equal(el.querySelector('[data-verdict]').getAttribute('data-verdict'), 'scam');
    assert.match(el.textContent, /message\.scam\.verdictScam/);
    assert.match(el.textContent, /message\.scam\.confidence/);
    assert.match(el.textContent, /Fake domain/);
    assert.match(el.textContent, /Delete it\./);
    const items = [...el.querySelectorAll('[data-testid="red-flags"] li')].map(li => li.textContent);
    assert.deepEqual(items, ['message.scam.flag.linkMismatch', 'message.scam.flag.doubleExtension']);
  });

  test('keeps the local red flags when the AI failed', async () => {
    const el = await render(React.createElement(ScamCheckCard, {
      result: { status: 'done', flags, analysis: null, error: 'rate limited' },
      onRetry() {}, onDismiss() {},
    }));
    assert.equal(el.querySelector('[data-verdict]'), null);
    assert.ok(el.querySelector('[role="alert"]'));
    assert.equal(el.querySelectorAll('[data-testid="red-flags"] li').length, 2);
  });

  test('says when nothing technical was found', async () => {
    const el = await render(React.createElement(ScamCheckCard, {
      result: { status: 'done', flags: [], analysis: { verdict: 'safe', confidence: 0.8, reasons: [], advice: '' }, error: null },
      onRetry() {}, onDismiss() {},
    }));
    assert.match(el.textContent, /message\.scam\.noRedFlags/);
    assert.equal(el.querySelector('[data-testid="red-flags"]'), null);
  });

  test('shows only a waiting line while it checks', async () => {
    const el = await render(React.createElement(ScamCheckCard, { result: { status: 'loading' }, onRetry() {}, onDismiss() {} }));
    assert.match(el.textContent, /message\.scam\.checking/);
    assert.equal(byText(el, 'message.scam.recheck'), undefined);
  });
});

describe('translation panel', () => {
  test('shows the translation as plain text, with the reader\'s language first', async () => {
    const el = await render(React.createElement(TranslationPanel, {
      result: { status: 'done', text: 'Subject: Hi\n\n<b>Hello</b>', language: 'fr', showOriginal: false },
      userLanguage: 'fr', onLanguage() {}, onToggleOriginal() {}, onDismiss() {},
    }));
    const text = el.querySelector('[data-testid="translation-text"]');
    assert.equal(text.textContent, 'Subject: Hi\n\n<b>Hello</b>');
    assert.equal(text.querySelector('b'), null, 'model output is never parsed as HTML');
    assert.deepEqual([...el.querySelectorAll('option')].map(o => o.value), ['fr', 'en', 'de', 'it', 'es']);
  });

  test('"Show original" folds the translation away', async () => {
    const mailAi = fakeMailAi({ translation: { status: 'done', text: 'Bonjour', language: 'fr', showOriginal: false } });
    let el = await render(React.createElement(MailAiPanels, { mailAi }));
    await click(byText(el, 'message.translationShowOriginal'));
    assert.deepEqual(mailAi.calls, [['toggle']]);
    el = await render(React.createElement(MailAiPanels, { mailAi: { ...mailAi, translation: { ...mailAi.translation, showOriginal: true } } }));
    assert.equal(el.querySelector('[data-testid="translation-text"]'), null);
    assert.ok(byText(el, 'message.translationShow'));
  });
});
