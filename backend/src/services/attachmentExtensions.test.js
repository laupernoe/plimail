import { describe, expect, it } from 'vitest';
import * as backend from './attachmentExtensions.js';
// The frontend copy has no imports, so it loads here without frontend/node_modules.
import * as frontend from '../../../frontend/src/utils/attachmentExtensions.js';

describe('attachment extension tiers', () => {
  it.each(['BLOCK', 'WARN', 'NOTICE', 'DECOY'])('%s is the same in the backend and the frontend copy', (tier) => {
    expect([...backend[tier]].sort()).toEqual([...frontend[tier]].sort());
  });
});
