// Render test for pasting into the signature editor in Settings.
//
// Same loader hooks as ProfileModal.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed so t() returns its key.

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

const { default: React } = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { default: SignatureEditor } = await import('./SignatureEditor.jsx');

// What Chrome 152 puts on the clipboard for two paragraphs copied out of an email in the
// message pane: each <p> carries the frame's white page and #1a1a1a text.
const NBSP = String.fromCharCode(160);
const PAGE = 'color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;';
const COPIED = `<meta charset='utf-8'><p id="p1" style="${PAGE}">Hi Marty,</p><p id="p2" style="${PAGE}">The ice resurfacer is booked for<span>${NBSP}</span><b>Tuesday at 6am</b>.</p>`;

// jsdom has no editing, so this stands in for the browser twice: insertHTML puts its HTML at the
// caret and fires input, and a paste the page does not cancel inserts the clipboard's HTML as it
// is, which is what the browser's own paste keeps of the colors.
function insertAtCaret(target, html) {
  const selection = window.getSelection();
  let range = selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !target.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(range.createContextualFragment(html));
  target.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function paste(target, html) {
  document.execCommand = (command, showUi, value) => {
    if (command !== 'insertHTML') return false;
    insertAtCaret(target, value);
    return true;
  };
  try {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: type => (type === 'text/html' ? html : '') };
    target.dispatchEvent(event);
    if (!event.defaultPrevented) insertAtCaret(target, html);
  } finally {
    delete document.execCommand;
  }
}

describe('pasting into the signature editor', () => {
  test('text copied from an email is saved without the colors of the page it came from', async () => {
    const saved = [];
    const root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(React.createElement(SignatureEditor, { value: '<p>Marty Example</p>', onChange: html => saved.push(html) }));
    });
    try {
      const editor = document.querySelector('[contenteditable]');
      await act(async () => { paste(editor, COPIED); });
      const signature = saved.at(-1);
      assert.match(signature, /Marty Example/);
      assert.match(signature, /<b>Tuesday at 6am<\/b>/);
      assert.doesNotMatch(signature, /background-color|(?<![\w-])color\s*:/);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe('images in the signature editor', () => {
  const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  async function mount() {
    const saved = [];
    const root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(React.createElement(SignatureEditor, { value: '<p>Marty Example</p>', onChange: html => saved.push(html) }));
    });
    return { saved, root, editor: document.querySelector('[contenteditable]') };
  }

  // Answers the upload as the server does, and records what was sent.
  function stubUpload(calls) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ id: ID, url: `/api/signature-images/${ID}`, width: 600, height: 200 }),
        { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    document.execCommand = (command, showUi, value) => {
      if (command !== 'insertHTML') return false;
      insertAtCaret(document.querySelector('[contenteditable]'), value);
      return true;
    };
    return () => { globalThis.fetch = realFetch; delete document.execCommand; };
  }

  async function chooseFile(file) {
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  test('the insert button uploads the chosen image and puts it in the signature', async () => {
    const calls = [];
    const restore = stubUpload(calls);
    const { saved, root } = await mount();
    try {
      const button = document.querySelector('button[aria-label="signatureEditor.imageUpload"]');
      assert.ok(button, 'an insert image button is in the toolbar');
      let opened = false;
      document.querySelector('input[type="file"]').click = () => { opened = true; };
      await act(async () => { button.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
      assert.equal(opened, true, 'the button opens the file picker');

      const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
      await chooseFile(file);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, '/api/signature-images');
      assert.equal(calls[0].opts.method, 'POST');
      assert.equal(calls[0].opts.headers['Content-Type'], 'image/png');
      assert.equal(calls[0].opts.body, file);
      assert.match(saved.at(-1), new RegExp(`<img src="/api/signature-images/${ID}" alt="" width="240">`));
    } finally {
      restore();
      await act(async () => root.unmount());
    }
  });

  test('a clicked image can be shown small or at full size, and removed', async () => {
    const restore = stubUpload([]);
    const { saved, root, editor } = await mount();
    try {
      await chooseFile(new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' }));
      const img = editor.querySelector('img');
      await act(async () => { img.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
      const sizeButton = key => document.querySelector(`[role="toolbar"] button[aria-label="signatureEditor.${key}"]`);
      assert.equal(sizeButton('imageMedium').getAttribute('aria-pressed'), 'true');

      await act(async () => { sizeButton('imageSmall').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
      assert.match(saved.at(-1), /width="120"/);
      await act(async () => { sizeButton('imageFull').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
      assert.doesNotMatch(saved.at(-1), /width=/);
      assert.ok(saved.every(html => !html.includes('data-signature-selected')), 'the selection mark is never saved');

      await act(async () => { sizeButton('imageRemove').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
      assert.doesNotMatch(saved.at(-1), /<img/);
      assert.match(saved.at(-1), /Marty Example/);
      assert.equal(document.querySelector('[role="toolbar"]'), null);
    } finally {
      restore();
      await act(async () => root.unmount());
    }
  });

  test('an upload past the per-user cap says so, rather than showing the server text', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: 'You have reached the limit', code: 'signature_image_quota' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } });
    const { useStore } = await import('../store/index.js');
    useStore.setState({ notifications: [] });
    const { saved, root } = await mount();
    try {
      await chooseFile(new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' }));
      const [note] = useStore.getState().notifications;
      assert.equal(note?.title, 'signatureEditor.imageQuota.title');
      assert.equal(note?.body, 'signatureEditor.imageQuota.body');
      assert.ok(saved.every(html => !html.includes('<img')));
    } finally {
      globalThis.fetch = realFetch;
      await act(async () => root.unmount());
    }
  });

  test('a file that is not a PNG, JPEG, GIF or WebP image is not uploaded', async () => {
    const calls = [];
    const restore = stubUpload(calls);
    const { saved, root } = await mount();
    try {
      await chooseFile(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
      assert.equal(calls.length, 0);
      assert.ok(saved.every(html => !html.includes('<img')));
    } finally {
      restore();
      await act(async () => root.unmount());
    }
  });
});

describe('font and link controls in the signature editor', () => {
  async function mount(value = '<p>Marty Example</p>') {
    const saved = [];
    const root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(React.createElement(SignatureEditor, { value, onChange: html => saved.push(html) }));
    });
    return { saved, root, editor: document.querySelector('[contenteditable]') };
  }
  const stubInsertHtml = () => {
    document.execCommand = (command, showUi, value) => {
      if (command === 'createLink') {
        const range = window.getSelection().getRangeAt(0);
        const a = document.createElement('a');
        a.setAttribute('href', value);
        a.appendChild(range.extractContents());
        range.insertNode(a);
        document.querySelector('[contenteditable]').dispatchEvent(new window.Event('input', { bubbles: true }));
        return true;
      }
      if (command !== 'insertHTML') return false;
      const range = window.getSelection().getRangeAt(0);
      range.deleteContents();
      range.insertNode(range.createContextualFragment(value));
      document.querySelector('[contenteditable]').dispatchEvent(new window.Event('input', { bubbles: true }));
      return true;
    };
    return () => { delete document.execCommand; };
  };
  const select = (node, from, to) => {
    const range = document.createRange();
    range.setStart(node, from); range.setEnd(node, to);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  };
  const pick = async (label, value) => {
    const el = document.querySelector(`select[aria-label="signatureEditor.${label}"]`);
    assert.ok(el, `${label} picker is in the toolbar`);
    await act(async () => {
      el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };

  test('a size and a font picked with text selected wrap that text in an inline style', async () => {
    const restore = stubInsertHtml();
    const { saved, root, editor } = await mount();
    try {
      const text = editor.querySelector('p').firstChild;
      select(text, 0, 5);
      await pick('fontSize', '18px');
      assert.match(saved.at(-1), /<span style="font-size:\s*18px;?">Marty<\/span> Example/);
      select(editor.querySelector('span').firstChild, 0, 5);
      await pick('fontFamily', '"Segoe UI", system-ui, sans-serif');
      assert.match(saved.at(-1), /font-family:\s*(?:&quot;|")?Segoe UI/);
      assert.match(saved.at(-1), /font-size:\s*18px/);
      assert.doesNotMatch(saved.at(-1), /<font/);
    } finally {
      restore();
      await act(async () => root.unmount());
    }
  });

  test('with nothing selected the font applies to the whole signature', async () => {
    const restore = stubInsertHtml();
    const { saved, root } = await mount();
    try {
      window.getSelection().removeAllRanges();
      await pick('fontSize', '14px');
      assert.match(saved.at(-1), /^<span style="font-size:\s*14px;?"><p>Marty Example<\/p><\/span>$/);
    } finally {
      restore();
      await act(async () => root.unmount());
    }
  });

  const openLink = async () => {
    const button = document.querySelector('button[aria-label="signatureEditor.link"]');
    await act(async () => { button.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
  };
  const typeLink = async (value) => {
    const input = document.querySelector('form input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  };

  test('an email address typed in the link box becomes a mailto link on the selected text', async () => {
    const restore = stubInsertHtml();
    const { saved, root, editor } = await mount();
    try {
      select(editor.querySelector('p').firstChild, 0, 5);
      await openLink();
      await typeLink('marty@example.com');
      assert.match(saved.at(-1), /<a href="mailto:marty@example\.com">Marty<\/a> Example/);
    } finally {
      restore();
      await act(async () => root.unmount());
    }
  });

  test('with nothing selected the address itself becomes the link text', async () => {
    const restore = stubInsertHtml();
    const { saved, root, editor } = await mount();
    try {
      select(editor.querySelector('p').firstChild, 6, 6);
      await openLink();
      await typeLink('tel:+41791234567');
      assert.match(saved.at(-1), /<a href="tel:\+41791234567">\+41791234567<\/a>/);
    } finally {
      restore();
      await act(async () => root.unmount());
    }
  });

  test('javascript: is refused and nothing is inserted', async () => {
    const restore = stubInsertHtml();
    const { saved, root, editor } = await mount();
    try {
      select(editor.querySelector('p').firstChild, 0, 5);
      await openLink();
      await typeLink('javascript:alert(1)');
      assert.equal(saved.length, 0);
      assert.ok(document.querySelector('[role="alert"]'));
    } finally {
      restore();
      await act(async () => root.unmount());
    }
  });
});
