// Run with: node --test src/themes.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, getInitialTheme, normalizeTheme, resolveEffectiveTheme } from './themes.js';

const concrete = ['selfhostr', 'selfhostr-light'];
const canonicalVars = Object.keys(THEMES.selfhostr.vars);

function withMatchMedia(light, fn) {
  const original = globalThis.window;
  try {
    globalThis.window = { matchMedia: (q) => ({ matches: light && q.includes('prefers-color-scheme: light') }) };
    fn();
  } finally {
    globalThis.window = original;
  }
}

describe('theme set', () => {
  it('is system, selfhostr and selfhostr-light, nothing else', () => {
    assert.deepEqual(Object.keys(THEMES).sort(), ['selfhostr', 'selfhostr-light', 'system']);
  });

  it('every theme has a label, a description and a four-colour preview', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      assert.ok(theme.label && theme.description, name);
      assert.equal(theme.preview.length, 4, name);
    }
  });
});

describe('CSS-var contract', () => {
  it('both concrete themes define exactly the same vars', () => {
    const light = Object.keys(THEMES['selfhostr-light'].vars);
    assert.deepEqual([...light].sort(), [...canonicalVars].sort());
  });

  it('has no accent hue: every colour var is a neutral grey (the status colours aside)', () => {
    const status = new Set(['--green', '--red', '--amber']);
    for (const name of concrete) {
      for (const [key, value] of Object.entries(THEMES[name].vars)) {
        if (status.has(key) || !value.startsWith('#')) continue;
        const [r, g, b] = rgb(value);
        // selfhostr greys lean slightly cool; anything past that is a hue.
        assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 20, `${name} ${key} ${value} is not neutral`);
      }
    }
  });

  it('the primary action is the ink colour: --accent-text reads on --accent', () => {
    for (const name of concrete) {
      const v = THEMES[name].vars;
      assert.ok(contrast(v['--accent'], v['--accent-text']) >= 7, `${name} accent/accent-text`);
    }
  });

  it('--status-text reads on the solid status fills', () => {
    for (const name of concrete) {
      const v = THEMES[name].vars;
      for (const fill of ['--green', '--red', '--amber']) {
        assert.ok(contrast(v[fill], v['--status-text']) >= 4.5, `${name} ${fill} with --status-text`);
      }
    }
  });
});

// WCAG AA for text is 4.5:1.
describe('selfhostr-light contrast (WCAG AA)', () => {
  const v = THEMES['selfhostr-light'].vars;
  const surfaces = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-elevated', '--bg-hover'];

  it('text colours read on every surface', () => {
    for (const text of ['--text-primary', '--text-secondary', '--text-tertiary']) {
      for (const surface of surfaces) {
        assert.ok(contrast(v[text], v[surface]) >= 4.5, `${text} on ${surface}: ${contrast(v[text], v[surface]).toFixed(2)}`);
      }
    }
  });

  it('status colours read on every surface', () => {
    for (const status of ['--green', '--red', '--amber']) {
      for (const surface of surfaces) {
        assert.ok(contrast(v[status], v[surface]) >= 4.5, `${status} on ${surface}: ${contrast(v[status], v[surface]).toFixed(2)}`);
      }
    }
  });
});

describe('selfhostr contrast (WCAG AA)', () => {
  const v = THEMES.selfhostr.vars;
  it('primary and secondary text and the status colours read on the main surfaces', () => {
    for (const text of ['--text-primary', '--text-secondary', '--green', '--red', '--amber']) {
      for (const surface of ['--bg-primary', '--bg-secondary', '--bg-tertiary']) {
        assert.ok(contrast(v[text], v[surface]) >= 4.5, `${text} on ${surface}`);
      }
    }
  });
});

describe('system theme and OS resolution', () => {
  it('getInitialTheme defaults to system', () => {
    assert.equal(getInitialTheme(), 'system');
  });

  it('resolveEffectiveTheme returns a concrete theme as is', () => {
    assert.equal(resolveEffectiveTheme('selfhostr'), 'selfhostr');
    assert.equal(resolveEffectiveTheme('selfhostr-light'), 'selfhostr-light');
  });

  it('system follows prefers-color-scheme', () => {
    withMatchMedia(true, () => assert.equal(resolveEffectiveTheme('system'), 'selfhostr-light'));
    withMatchMedia(false, () => assert.equal(resolveEffectiveTheme('system'), 'selfhostr'));
  });

  it('a theme from an older version falls back to system', () => {
    for (const old of ['dark', 'light', 'nord', 'dracula', 'winxp', 'win9x', '', null, undefined, 'toString', '__proto__']) {
      assert.equal(normalizeTheme(old), 'system', String(old));
    }
    withMatchMedia(true, () => assert.equal(resolveEffectiveTheme('winxp'), 'selfhostr-light'));
    withMatchMedia(false, () => assert.equal(resolveEffectiveTheme('winxp'), 'selfhostr'));
  });

  it('keeps the concrete theme names', () => {
    for (const name of concrete) assert.equal(normalizeTheme(name), name);
  });
});

function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
