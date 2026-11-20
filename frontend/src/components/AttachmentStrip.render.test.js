// Render test for the collapsible attachment list (#653). Harness mirrors ContextMenu.render.test.js.
// The harness mirrors MessageList.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed to return the key.

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
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');

const AttachmentStrip = (await import('./AttachmentStrip.jsx')).default;

const mk = (names) => names.map((filename, i) => ({ part: String(i + 1), filename, type: 'application/pdf', size: 1000 }));
let root;
async function render(attachments) {
  if (root) await React.act(async () => root.unmount());
  await React.act(async () => {
    root = createRoot(dom.window.document.getElementById('root'));
    root.render(React.createElement(AttachmentStrip, { messageId: 'm1', attachments }));
  });
}
const chips = () => [...dom.window.document.querySelectorAll('button')].filter(b => /\.(pdf|exe)/.test(b.textContent));
const text = () => dom.window.document.body.textContent;
async function clickText(label) {
  const el = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent.includes(label));
  assert.ok(el, `expected "${label}"`);
  await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
}

describe('AttachmentStrip collapsing (#653)', () => {
  const many = mk(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf']);

  test('a short list shows every file and no toggle', async () => {
    await render(mk(['a.pdf', 'b.pdf']));
    assert.equal(chips().length, 2);
    assert.ok(!text().includes('message.attachmentsShowAll'));
  });

  test('a long list starts collapsed, keeps Download all, and expands on demand', async () => {
    await render(many);
    assert.equal(chips().length, 3);
    assert.ok(text().includes('message.downloadAll'));
    await clickText('message.attachmentsShowAll');
    assert.equal(chips().length, 6);
    await clickText('message.attachmentsShowFewer');
    assert.equal(chips().length, 3);
  });

  test('a risky file past the cut stays visible while collapsed', async () => {
    await render(mk(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'setup.exe']));
    assert.equal(chips().length, 4);
    assert.ok(text().includes('setup.exe'));
  });
});

describe('AttachmentStrip drag-out to the desktop', () => {
  const setChromium = (on) => {
    Object.defineProperty(globalThis.navigator, 'userAgentData', {
      value: on ? { brands: [{ brand: 'Chromium', version: '140' }] } : undefined, configurable: true,
    });
  };
  const dragStart = async (el) => {
    const data = {};
    const ev = new dom.window.Event('dragstart', { bubbles: true, cancelable: true });
    ev.dataTransfer = { effectAllowed: 'all', setData(k, v) { data[k] = v; } };
    await React.act(async () => { el.dispatchEvent(ev); });
    return data;
  };
  const chip = (name) => chips().find(b => b.textContent.includes(name));

  test('on Chromium a chip drags out as a download of the attachment, under its own name', async () => {
    setChromium(true);
    await render([
      { part: '1.2', filename: 'Re: devis 10:30 — été.pdf', type: 'application/pdf', size: 1000 },
    ]);
    const el = chip('devis');
    assert.equal(el.getAttribute('draggable'), 'true');
    assert.ok(el.title.includes('message.dragToSave'));
    const data = await dragStart(el);
    assert.equal(data.DownloadURL,
      'application/pdf:Re_ devis 10_30 — été.pdf:https://mail.example.invalid/api/mail/messages/m1/attachments/1.2');
    assert.equal(data['text/plain'], 'https://mail.example.invalid/api/mail/messages/m1/attachments/1.2');
  });

  test('a risky file does not drag out, since a drop would skip the confirmation', async () => {
    setChromium(true);
    await render(mk(['a.pdf', 'setup.exe']));
    assert.equal(chip('a.pdf').getAttribute('draggable'), 'true');
    const exe = chip('setup.exe');
    assert.equal(exe.getAttribute('draggable'), null);
    assert.deepEqual(await dragStart(exe), {});
  });

  test('outside Chromium a chip is not draggable and drags carry nothing', async () => {
    setChromium(false);
    await render(mk(['a.pdf']));
    const el = chip('a.pdf');
    assert.equal(el.getAttribute('draggable'), null);
    assert.ok(!(el.title || '').includes('message.dragToSave'));
    assert.deepEqual(await dragStart(el), {});
  });
});
