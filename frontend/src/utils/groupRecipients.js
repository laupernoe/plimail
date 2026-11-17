// Contact groups in the composer's recipient field. A group shows up in the autocomplete next to
// the contacts; choosing it adds its members as separate, editable recipients.

const ANGLE = /<([^>]+)>\s*$/;

// The address of a recipient chip ("Name <addr>" or a bare address), lower case.
export function chipEmail(chip) {
  const text = String(chip || '').trim();
  const m = ANGLE.exec(text);
  return (m ? m[1] : text).trim().toLowerCase();
}

export function formatRecipient(contact) {
  return contact.name ? `${contact.name} <${contact.email}>` : contact.email;
}

// The chips after the user picked a suggestion: a contact adds itself; a group adds each member
// that has an address and is not already a recipient (or earlier in the same group).
export function addSuggestionChips(chips, suggestion) {
  if (!suggestion.group) return [...chips, formatRecipient(suggestion)];
  const seen = new Set(chips.map(chipEmail));
  const next = [...chips];
  for (const member of suggestion.members || []) {
    const email = String(member.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    next.push(formatRecipient({ name: member.name, email }));
  }
  return next;
}

// Groups from /contact-groups/suggest go above the contact suggestions. A group none of whose
// members has an address would add nothing, so it is not offered.
export function mergeGroupSuggestions(contacts, groups) {
  const offered = (groups || [])
    .filter(g => (g.members || []).some(m => m.email))
    .map(g => ({ group: true, groupId: g.id, name: g.name, members: g.members }));
  return [...offered, ...(contacts || [])];
}

export function suggestionKey(suggestion) {
  return suggestion.group ? `group:${suggestion.groupId}` : suggestion.email;
}
