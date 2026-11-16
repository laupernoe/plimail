import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordFitsRule } from './passwordRule.js';

test('a new password takes 8 characters to 72 bytes, as the server requires', () => {
  assert.equal(passwordFitsRule('12345678'), true);
  assert.equal(passwordFitsRule('a'.repeat(72)), true);
  assert.equal(passwordFitsRule('ç'.repeat(36)), true);
  assert.equal(passwordFitsRule('1234567'), false);
  assert.equal(passwordFitsRule('a'.repeat(73)), false);
  assert.equal(passwordFitsRule('ç'.repeat(37)), false);
  assert.equal(passwordFitsRule(undefined), false);
});
