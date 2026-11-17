// public/manifest.json: what Chromium needs to install Plimail as a desktop app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const publicDir = new URL('../public/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', publicDir), 'utf8'));

function pngSize(path) {
  const buf = readFileSync(new URL(path.replace(/^\//, ''), publicDir));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${path} is a PNG`);
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

test('names the app Plimail and opens it in its own window at the root', () => {
  assert.equal(manifest.name, 'Plimail');
  assert.equal(manifest.short_name, 'Plimail');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.display, 'standalone');
  // A desktop window is landscape: a portrait lock would only get in the way.
  assert.equal(manifest.orientation, undefined);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
});

test('every icon exists at the size it declares, with the 192 and 512 installation needs', () => {
  for (const icon of manifest.icons) {
    assert.ok(existsSync(new URL(icon.src.replace(/^\//, ''), publicDir)), icon.src);
    assert.equal(pngSize(icon.src), icon.sizes, icon.src);
  }
  const any = manifest.icons.filter(i => i.purpose === 'any').map(i => i.sizes);
  assert.ok(any.includes('192x192') && any.includes('512x512'));
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'));
});

test('handles mailto: links at the address the app reads them from', () => {
  assert.deepEqual(manifest.protocol_handlers, [{ protocol: 'mailto', url: '/?mailto=%s' }]);
});
