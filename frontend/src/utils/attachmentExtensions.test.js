// Run with: node --test src/utils/attachmentExtensions.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as tiers from './attachmentExtensions.js';

const TIERS = ['BLOCK', 'WARN', 'NOTICE', 'DECOY'];

describe('attachment extension tiers', () => {
  it('puts each extension in at most one of block, warn and notice', () => {
    const tierOf = new Map();
    const clashes = [];
    for (const tier of ['BLOCK', 'WARN', 'NOTICE']) {
      for (const ext of tiers[tier]) {
        if (tierOf.has(ext)) clashes.push(`${ext}: ${tierOf.get(ext)} and ${tier}`);
        tierOf.set(ext, tier);
      }
    }
    assert.deepEqual(clashes, []);
  });

  it('lists bare lowercase extensions, the form the download warning compares against', () => {
    const malformed = TIERS.flatMap(tier => [...tiers[tier]].filter(ext => ext !== ext.toLowerCase() || ext.includes('.') || ext !== ext.trim()));
    assert.deepEqual(malformed, []);
  });
});
