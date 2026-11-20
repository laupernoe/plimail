import { folderRole } from './folderDisplay.js';

// The server takes at most this many ids per bulk-delete request.
export const BULK_DELETE_BATCH = 500;

// Sends the ids in batches, one after another: parallel batches would each open IMAP
// connections for the same accounts at once. A batch that fails as a whole reports each of its
// ids with reason 'request', so nothing it held is taken as deleted.
// Returns { deleted: Set<id>, failed: [{ id, reason }] }.
export async function deleteInBatches(ids, bulkDelete, size = BULK_DELETE_BATCH) {
  const unique = [...new Set(ids)];
  const deleted = new Set();
  const reasons = new Map();
  for (let i = 0; i < unique.length; i += size) {
    const chunk = unique.slice(i, i + size);
    try {
      const result = await bulkDelete(chunk);
      for (const id of result?.deleted ?? []) deleted.add(id);
      for (const f of result?.failed ?? []) if (f?.id) reasons.set(f.id, f.reason || 'imap');
    } catch (err) {
      console.error('Bulk delete batch failed:', err?.message);
      for (const id of chunk) reasons.set(id, 'request');
    }
  }
  const failed = unique.filter(id => !deleted.has(id)).map(id => ({ id, reason: reasons.get(id) || 'imap' }));
  return { deleted, failed };
}

// The error body for what was left, naming the cause when one cause explains it all.
export function bulkDeleteFailureBody(t, failed) {
  const count = failed.length;
  if (count && failed.every(f => f.reason === 'no_trash')) return t('messageList.bulkDeleted.noTrash', { count });
  if (count && failed.every(f => f.reason === 'request')) return t('messageList.bulkDeleted.offline', { count });
  return t('messageList.bulkDeleted.failBody', { count });
}

const TRASH_NAMES = /^(?:\[gmail\]\/|\[google mail\]\/)?(?:trash|bin|deleted items|deleted messages)$/i;

// Whether deleting this message expunges it rather than moving it to Trash: the server treats
// any Trash-like folder that way. When unsure it answers yes, so the user is asked.
export function isInTrash(message, { folders, accounts } = {}) {
  if (!message?.folder) return false;
  const folder = (folders?.[message.account_id] || []).find(f => f.path === message.folder);
  const mappings = (accounts || []).find(a => a.id === message.account_id)?.folder_mappings;
  const role = folderRole(folder || { path: message.folder }, mappings);
  if (role === 'trash') return true;
  const leaf = message.folder.split(/[/.]/).pop();
  return TRASH_NAMES.test(message.folder) || TRASH_NAMES.test(leaf);
}
