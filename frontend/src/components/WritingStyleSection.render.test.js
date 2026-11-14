// Render test for Settings → AI actions → My writing style. Pins that the section stays out of the
// way when the writing assistant is unavailable, shows what was learned and from how much mail,
// learns, saves an edit, turns the style off, clears it, and says why learning was refused.
//
// Same loader hooks as ApiTokensSection.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed with the interpolation values appended, so messages can be checked.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
      return { format: 'module', shortCircuit: true, source: out.code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const LEARNED_AT = '2026-11-10T09:00:00.000Z';
const CALLS = [];
let server;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  CALLS.push({ path, method, body });
  if (path === '/api/ai/writing-style' && method === 'GET') return json(server.style);
  if (path === '/api/ai/writing-style' && method === 'PUT') {
    if (body.profile === null) server.style = { enabled: false, profile: null, samples: null, updatedAt: null };
    else server.style = { ...server.style, ...body };
    return json(server.style);
  }
  if (path === '/api/ai/writing-style/learn' && method === 'POST') return server.learn();
  return json({ error: 'unexpected request' }, 500);
};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { formatDay } = await import('../utils/formatDate.js');
const { default: WritingStyleSection } = await import('./WritingStyleSection.jsx');

const host = document.getElementById('root');
let root;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const until = async (check, what) => {
  for (let i = 0; i < 60; i++) { if (check()) return; await flush(); }
  assert.fail(`timed out waiting for ${what}; page shows: ${host.textContent}`);
};
const text = () => host.textContent;
const button = (label) => [...host.querySelectorAll('button')].find(b => b.textContent === label);
const click = (el) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const textarea = () => host.querySelector('textarea');
async function type(el, value) {
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

async function mount(available = true) {
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(WritingStyleSection, { available })); });
  if (available) await until(() => textarea(), 'the style editor');
}

beforeEach(() => {
  CALLS.length = 0;
  server = {
    style: { enabled: false, profile: null, samples: null, updatedAt: null },
    learn: () => {
      server.style = { enabled: true, profile: '- Open with "Salut"', samples: 18, updatedAt: LEARNED_AT };
      return json(server.style);
    },
  };
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
});

describe('WritingStyleSection', () => {
  test('renders nothing and asks for nothing while the writing assistant is unavailable', async () => {
    await mount(false);
    await flush();
    assert.equal(host.textContent, '');
    assert.equal(CALLS.length, 0);
  });

  test('learns from sent mail, then shows the profile and where it came from', async () => {
    await mount();
    const toggle = host.querySelector('[role="switch"]');
    assert.equal(toggle.disabled, true, 'nothing to turn on before a style exists');
    assert.equal(button('admin.writingStyle.clear'), undefined);

    await click(button('admin.writingStyle.learn'));
    await until(() => textarea().value === '- Open with "Salut"', 'the learned profile');
    assert.deepEqual(CALLS.at(-1), { path: '/api/ai/writing-style/learn', method: 'POST', body: undefined });
    assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true');
    assert.ok(text().includes(`admin.writingStyle.learnedFrom ${JSON.stringify({ n: 18, date: formatDay(LEARNED_AT) })}`));
    assert.ok(button('admin.writingStyle.learnAgain'));
  });

  test('saves an edit, turns the style off and clears it', async () => {
    server.style = { enabled: true, profile: '- Be brief', samples: 9, updatedAt: LEARNED_AT };
    await mount();
    assert.equal(button('common.save').disabled, true, 'nothing to save before an edit');

    await type(textarea(), '- Be brief\n- Sign off with "Bises"');
    await click(button('common.save'));
    await until(() => text().includes('admin.writingStyle.saved'), 'the save');
    assert.deepEqual(CALLS.at(-1).body, { profile: '- Be brief\n- Sign off with "Bises"' });

    await click(host.querySelector('[role="switch"]'));
    await until(() => host.querySelector('[role="switch"]').getAttribute('aria-checked') === 'false', 'the switch off');
    assert.deepEqual(CALLS.at(-1).body, { enabled: false });

    await click(button('admin.writingStyle.clear'));
    await until(() => textarea().value === '', 'the cleared profile');
    assert.deepEqual(CALLS.at(-1).body, { profile: null });
    assert.ok(button('admin.writingStyle.learn'));
  });

  test('says when there is not enough sent mail to learn from', async () => {
    server.learn = () => json({ error: 'At least 3 sent emails are needed.', code: 'not_enough_mail' }, 422);
    await mount();
    await click(button('admin.writingStyle.learn'));
    await until(() => host.querySelector('[role="alert"]'), 'the refusal');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'admin.writingStyle.notEnoughMail');
  });
});
