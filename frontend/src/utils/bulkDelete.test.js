// Run with: node --test src/utils/bulkDelete.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bulkDeleteFailureBody, deleteInBatches, isInTrash } from './bulkDelete.js';

describe('deleteInBatches', () => {
  it('sends batches one after another, never more than the server takes', async () => {
    const ids = Array.from({ length: 1203 }, (_, i) => `id-${i}`);
    const sent = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { deleted, failed } = await deleteInBatches(ids, async (chunk) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      sent.push(chunk.length);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
      return { deleted: chunk };
    });
    assert.deepEqual(sent, [500, 500, 203]);
    assert.equal(maxInFlight, 1);
    assert.equal(deleted.size, 1203);
    assert.deepEqual(failed, []);
  });

  it('keeps every id of a batch that failed, and the reasons the server gave for the rest', async () => {
    const { deleted, failed } = await deleteInBatches(['a', 'b', 'c', 'd'], async (chunk) => {
      if (chunk.includes('c')) throw new Error('offline');
      return { deleted: ['a'], failed: [{ id: 'b', reason: 'no_trash' }] };
    }, 2);
    assert.deepEqual([...deleted], ['a']);
    assert.deepEqual(failed, [
      { id: 'b', reason: 'no_trash' }, { id: 'c', reason: 'request' }, { id: 'd', reason: 'request' },
    ]);
  });

  it('an id the server neither deleted nor explained is still reported failed', async () => {
    const { failed } = await deleteInBatches(['a', 'b'], async () => ({ deleted: ['a'] }));
    assert.deepEqual(failed, [{ id: 'b', reason: 'imap' }]);
  });
});

describe('bulkDeleteFailureBody', () => {
  const t = (key, opts) => `${key}:${opts.count}`;
  it('names the cause when one cause explains everything', () => {
    assert.equal(bulkDeleteFailureBody(t, [{ reason: 'no_trash' }, { reason: 'no_trash' }]), 'messageList.bulkDeleted.noTrash:2');
    assert.equal(bulkDeleteFailureBody(t, [{ reason: 'request' }]), 'messageList.bulkDeleted.offline:1');
    assert.equal(bulkDeleteFailureBody(t, [{ reason: 'no_trash' }, { reason: 'imap' }]), 'messageList.bulkDeleted.failBody:2');
  });
});

describe('isInTrash', () => {
  const folders = { a: [{ path: 'Corbeille', special_use: '\\Trash' }, { path: 'INBOX' }, { path: 'Deleted clients' }] };
  it('follows the folder the server flagged, the mapping, then the usual names', () => {
    assert.equal(isInTrash({ account_id: 'a', folder: 'Corbeille' }, { folders }), true);
    assert.equal(isInTrash({ account_id: 'b', folder: 'Poubelle' }, { accounts: [{ id: 'b', folder_mappings: { trash: 'Poubelle' } }] }), true);
    assert.equal(isInTrash({ account_id: 'c', folder: 'INBOX.Trash' }, {}), true);
    assert.equal(isInTrash({ account_id: 'c', folder: '[Gmail]/Trash' }, {}), true);
  });
  it('mail elsewhere is not', () => {
    assert.equal(isInTrash({ account_id: 'a', folder: 'INBOX' }, { folders }), false);
    assert.equal(isInTrash({ account_id: 'a', folder: 'Deleted clients' }, { folders }), false);
    assert.equal(isInTrash({ account_id: 'a' }, { folders }), false);
  });
});
