import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCollapsible, visibleAttachments, COLLAPSED_VISIBLE } from './attachmentCollapse.js';

const files = (n) => Array.from({ length: n }, (_, i) => ({ part: String(i), filename: `f${i}.pdf` }));
const never = () => false;

test('a short list is never collapsed', () => {
  assert.equal(isCollapsible(files(4)), false);
  assert.equal(visibleAttachments(files(4), false, never).length, 4);
});

test('a long list collapses to the first few', () => {
  assert.equal(isCollapsible(files(5)), true);
  assert.equal(visibleAttachments(files(9), false, never).length, COLLAPSED_VISIBLE);
});

test('expanding shows everything', () => {
  assert.equal(visibleAttachments(files(9), true, never).length, 9);
});

test('a risky file beyond the cut stays visible while collapsed', () => {
  const list = files(9);
  const out = visibleAttachments(list, false, att => att.part === '7');
  assert.deepEqual(out.map(a => a.part), ['0', '1', '2', '7']);
});
