import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeReadReceipt, receiptAction } from './readReceipt.js';

describe('composeReadReceipt', () => {
  it('is off for a new message unless "always ask" is on', () => {
    assert.equal(composeReadReceipt(undefined, undefined), false);
    assert.equal(composeReadReceipt({}, false), false);
    assert.equal(composeReadReceipt({}, true), true);
  });

  it('keeps what a reopened message had, whatever the setting says', () => {
    assert.equal(composeReadReceipt({ readReceipt: false }, true), false);
    assert.equal(composeReadReceipt({ readReceipt: true }, false), true);
  });
});

describe('receiptAction', () => {
  it('asks, and never sends by itself, by default', () => {
    assert.equal(receiptAction({ status: 'ok', mode: 'ask' }), 'ask');
    assert.equal(receiptAction({ status: 'ok', mode: undefined }), 'ask');
  });

  it('sends by itself only when the user chose always and the request is sound', () => {
    assert.equal(receiptAction({ status: 'ok', mode: 'always' }), 'auto');
    assert.equal(receiptAction({ status: 'confirm', mode: 'always' }), 'confirm');
  });

  it('shows nothing when the user never answers, or when there is nothing to answer', () => {
    for (const status of ['ok', 'confirm', 'none', 'done', 'blocked']) {
      assert.equal(receiptAction({ status, mode: 'never' }), 'none', status);
    }
    for (const mode of ['ask', 'always']) {
      for (const status of ['none', 'done', 'blocked', undefined]) {
        assert.equal(receiptAction({ status, mode }), 'none', `${status} ${mode}`);
      }
    }
  });
});
