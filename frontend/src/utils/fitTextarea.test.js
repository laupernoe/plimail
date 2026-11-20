import test from 'node:test';
import assert from 'node:assert/strict';
import { fitTextarea } from './fitTextarea.js';

test('fitTextarea sizes the box to its content, not a fixed height', () => {
  const el = { style: { height: '120px' }, scrollHeight: 900 };
  fitTextarea(el);
  assert.equal(el.style.height, '900px');
});

test('fitTextarea shrinks back and honours the minimum', () => {
  const el = { style: { height: '900px' }, scrollHeight: 40 };
  fitTextarea(el, 120);
  assert.equal(el.style.height, '120px');
});

test('fitTextarea tolerates a missing element', () => {
  assert.doesNotThrow(() => fitTextarea(null));
});
