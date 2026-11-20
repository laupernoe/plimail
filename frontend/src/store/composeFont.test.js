import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return nextLoad(url, context);
  },
});

globalThis.localStorage = (() => {
  let values = {};
  return {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: key => { delete values[key]; },
    clear: () => { values = {}; },
  };
})();

const { api } = await import('../utils/api.js');
const { useStore } = await import('./index.js');
const { SIGN_OUT_CLEARED_KEYS } = await import('../utils/signOut.js');
const original = { get: api.getPreferences, save: api.savePreferences };
afterEach(() => { api.getPreferences = original.get; api.savePreferences = original.save; });

describe('default writing font preference', () => {
  it('saves the family and size to the account and keeps them locally', async () => {
    const saved = [];
    api.savePreferences = async prefs => { saved.push(prefs); return {}; };
    useStore.getState().setComposeFont({ family: 'Georgia, serif' });
    useStore.getState().setComposeFont({ size: '11px' });
    assert.equal(useStore.getState().composeFontFamily, 'Georgia, serif');
    assert.equal(useStore.getState().composeFontSize, '11px');
    assert.equal(localStorage.getItem('mailflow_default_compose_font_family'), 'Georgia, serif');
    await new Promise(r => setTimeout(r, 1100));
    assert.deepEqual(saved, [{ composeFontFamily: 'Georgia, serif', composeFontSize: '11px' }]);
  });

  it('takes the account\'s font on load, as the server stored it', async () => {
    useStore.setState({ user: { id: 'u1' } });
    api.getPreferences = async () => ({ composeFontFamily: "'Times New Roman', Times, serif", composeFontSize: '' });
    await useStore.getState().loadPreferences();
    assert.equal(useStore.getState().composeFontFamily, '"Times New Roman", Times, serif');
    assert.equal(useStore.getState().composeFontSize, '');
  });

  it('is cleared on sign-out with the other per-user writing preferences', () => {
    assert.ok(SIGN_OUT_CLEARED_KEYS.includes('mailflow_default_compose_font_family'));
    assert.ok(SIGN_OUT_CLEARED_KEYS.includes('mailflow_default_compose_font_size'));
  });
});
