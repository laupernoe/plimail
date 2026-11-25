// Calendar invitations in a message's structure (iMIP, RFC 6047). Kept apart from messageParser
// so the mail engine can use it on a body it opens without the parser.
// Sync has the structure but not the content, so this only finds where an invitation may be: the
// text/calendar part an iMIP message carries, else an application/ics file. The content is read
// and parsed later (services/mailInvites.js). An invitation is a few kilobytes; a bigger part is
// a calendar export, not one, and is never fetched to find out.
export const MAX_INVITE_PART_BYTES = 256 * 1024;

export function detectInviteParts(structure) {
  if (!structure) return null;
  const found = [];
  const visit = (node) => {
    if (!node || found.length >= 2) return;
    if (node.childNodes?.length) { node.childNodes.forEach(visit); return; }
    const type = (node.type || '').toLowerCase();
    if (type !== 'text/calendar' && type !== 'application/ics') return;
    const size = Number(node.size);
    if (Number.isFinite(size) && size > MAX_INVITE_PART_BYTES) return;
    found.push({
      part: node.part || '1',
      type,
      encoding: (node.encoding || '7bit').toLowerCase(),
      charset: (node.parameters?.charset || 'utf-8').toLowerCase(),
      method: String(node.parameters?.method || '').toUpperCase() || null,
    });
  };
  visit(structure);
  // The text/calendar part first: the .ics beside it is usually the same object.
  found.sort((a, b) => (a.type === 'text/calendar' ? 0 : 1) - (b.type === 'text/calendar' ? 0 : 1));
  return found.length ? found : null;
}
