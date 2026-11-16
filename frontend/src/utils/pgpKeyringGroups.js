// Keyring rows grouped by key: { fingerprint, emails, sources, verified, armored, firstSeen }.
// A key the server collected from a received Autocrypt header by itself (row.auto) is listed under
// the source 'autocryptAuto', so it reads differently from one the user took from an offer.
export function groupKeyring(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const g = by.get(r.fingerprint) || { fingerprint: r.fingerprint, emails: [], sources: [], verified: true, armored: r.armored, firstSeen: r.firstSeen };
    g.emails.push(r.email);
    const source = r.source === 'autocrypt' && r.auto ? 'autocryptAuto' : r.source;
    if (!g.sources.includes(source)) g.sources.push(source);
    g.verified = g.verified && r.verified;
    by.set(r.fingerprint, g);
  }
  return [...by.values()];
}
