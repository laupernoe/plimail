// Dark email bodies (#228): which bodies are shown dark.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isDarkTheme, canShowDark, showDark } from './darkScheme.js';

const DARK_DESIGN = { html: '<p>x</p>', darkCss: '@media (min-width: 0px){p{color:#eee}}', lightOnly: false };
const PLAIN_HTML = { html: '<p>Hello</p>', darkCss: null, lightOnly: false };
const TEXT = { html: null, text: 'hi' };

describe('isDarkTheme', () => {
  test('selfhostr is dark, selfhostr-light is not', () => {
    assert.equal(isDarkTheme('selfhostr'), true);
    assert.equal(isDarkTheme('selfhostr-light'), false);
  });
  test('an unknown stored theme is treated like system (dark without a light OS)', () => {
    assert.equal(isDarkTheme('nord'), true);
  });
});

describe('which bodies can be shown dark', () => {
  test('plain text, and any HTML, even one that asks to stay light', () => {
    assert.equal(canShowDark(TEXT), true);
    assert.equal(canShowDark(DARK_DESIGN), true);
    assert.equal(canShowDark(PLAIN_HTML), true, 'recolored by Plimail');
    // Intercom marks every email "only light" (against Apple Mail's inversion); recolored all the same.
    assert.equal(canShowDark({ ...DARK_DESIGN, darkCss: null, lightOnly: true }), true);
    assert.equal(canShowDark({ ...PLAIN_HTML, lightOnly: true }), true);
    assert.equal(canShowDark(null), false);
  });
});

describe('shown dark', () => {
  test('plain text follows a dark theme unless switched back', () => {
    assert.equal(showDark({ body: TEXT, themeKey: 'dark', setting: false }), true);
    assert.equal(showDark({ body: TEXT, themeKey: 'dark', setting: false, override: 'original' }), false);
  });

  test('HTML follows the setting, or the message toggled either way', () => {
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'dark', setting: false }), false);
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'dark', setting: true }), true);
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'dark', setting: false, override: 'dark' }), true);
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'dark', setting: true, override: 'original' }), false);
    assert.equal(showDark({ body: PLAIN_HTML, themeKey: 'dark', setting: true }), true);
    assert.equal(showDark({ body: { ...PLAIN_HTML, lightOnly: true }, themeKey: 'dark', setting: true }), true);
    assert.equal(showDark({ body: { ...PLAIN_HTML, lightOnly: true }, themeKey: 'dark', setting: true, override: 'original' }), false);
  });

  test('never in a light theme', () => {
    assert.equal(showDark({ body: TEXT, themeKey: 'selfhostr-light', setting: true }), false);
    assert.equal(showDark({ body: DARK_DESIGN, themeKey: 'selfhostr-light', setting: true, override: 'dark' }), false);
  });
});
