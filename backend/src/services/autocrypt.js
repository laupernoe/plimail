import { query as defaultQuery } from './db.js';
import { PgpFormatError, TAG, dearmor, emailFromUserId, parseKeyPacket, readPackets } from './pgpPackets.js';

// The Autocrypt header (Autocrypt Level 1, https://autocrypt.org/level1.html) on the mail a user
// sends from an address that has a key: how correspondents' mail programs learn the key without
// anyone sending it by hand. It carries only the public key, cut down to what Level 1 asks for:
// the primary key, the user ID of the sending address with its self-signatures, and one
// encryption subkey with its binding signatures. Third-party certifications, other user IDs (which
// would tell every recipient the user's other addresses) and older subkeys stay out.

// Above this the header is skipped: Level 1 asks for keys small enough for every message, and a
// big RSA key with many signatures is better fetched from a directory than sent with each mail.
export const MAX_KEYDATA_BYTES = 12 * 1024;

const ENCRYPTION_ALGORITHMS = new Set([1, 2, 16, 18, 25, 26]); // RSA, RSA-E, ElGamal, ECDH, X25519, X448
const SIG_SUBKEY_BINDING = 0x18;
const SIG_SUBKEY_REVOCATION = 0x28;

// Subpackets of a signature's hashed and unhashed areas: [{ type, data }].
function subpackets(area) {
  const out = [];
  let pos = 0;
  while (pos < area.length) {
    let len;
    const o1 = area[pos++];
    if (o1 < 192) len = o1;
    else if (o1 < 255) { len = ((o1 - 192) << 8) + area[pos++] + 192; }
    else { len = area.readUInt32BE(pos); pos += 4; }
    if (len < 1 || pos + len > area.length) throw new PgpFormatError('Damaged signature subpacket');
    out.push({ type: area[pos] & 0x7F, data: area.subarray(pos + 1, pos + len) });
    pos += len;
  }
  return out;
}

// What the minimal key needs of a signature: its type, who made it (key ID or fingerprint, hex)
// and the key flags it states. v4, v5 and v6 signatures; anything else is { type: null }.
export function signatureInfo(body) {
  const version = body[0];
  if (version !== 4 && version !== 5 && version !== 6) return { type: null };
  const type = body[1];
  const wide = version === 6;
  let pos = 4;
  const hashedLen = wide ? body.readUInt32BE(pos) : body.readUInt16BE(pos);
  pos += wide ? 4 : 2;
  const hashed = body.subarray(pos, pos + hashedLen);
  pos += hashedLen;
  const unhashedLen = wide ? body.readUInt32BE(pos) : body.readUInt16BE(pos);
  pos += wide ? 4 : 2;
  const unhashed = body.subarray(pos, pos + unhashedLen);
  const issuers = new Set();
  let flags = null;
  let created = 0;
  for (const sp of [...subpackets(hashed), ...subpackets(unhashed)]) {
    if (sp.type === 16 && sp.data.length === 8) issuers.add(sp.data.toString('hex'));
    if (sp.type === 33 && sp.data.length > 1) issuers.add(sp.data.subarray(1).toString('hex'));
    if (sp.type === 27 && sp.data.length && flags === null) flags = sp.data[0];
    if (sp.type === 2 && sp.data.length === 4) created = sp.data.readUInt32BE(0);
  }
  return { type, issuers, flags, created };
}

// The public key `armoredPublic` reduced for an Autocrypt header sent from `email`: the bytes,
// or null when the key has no user ID for the address or no subkey to encrypt to.
export function minimalAutocryptKey(armoredPublic, email) {
  const block = dearmor(armoredPublic);
  if (block.type !== 'PGP PUBLIC KEY BLOCK') throw new PgpFormatError('Not a public key');
  const packets = readPackets(block.bytes);
  if (!packets.length || packets[0].tag !== TAG.PUBLIC_KEY) throw new PgpFormatError('Not a public key');
  const primary = parseKeyPacket(packets[0]);
  const bySelf = info => info.issuers.has(primary.keyId) || info.issuers.has(primary.fingerprint);
  const want = String(email || '').toLowerCase();

  // Group the packets after the primary key: each user ID or subkey with the signatures after it.
  // Signatures right after the primary key are on the key itself (a v6 key's direct-key
  // signature carries its flags and preferences; a revocation says it is no longer to be used).
  const groups = [];
  const keySigs = [];
  for (const packet of packets.slice(1)) {
    if (packet.tag === TAG.SIGNATURE) {
      (groups.length ? groups[groups.length - 1].sigs : keySigs).push(packet);
      continue;
    }
    if (packet.tag === TAG.PUBLIC_KEY) break; // a second key in the block is not this key
    groups.push({ packet, sigs: [] });
  }
  const selfSigs = sigs => sigs.filter((s) => {
    try { return bySelf(signatureInfo(s.body)); } catch { return false; }
  });

  const uid = groups.find(g => g.packet.tag === TAG.USER_ID && emailFromUserId(g.packet.body.toString('utf8')) === want);
  if (!uid) return null;
  const uidSigs = selfSigs(uid.sigs);
  if (!uidSigs.length) return null;

  // The newest subkey that may encrypt and was not revoked, by its binding signature's key flags
  // (or its algorithm, for a binding with none).
  let best = null;
  for (const g of groups) {
    if (g.packet.tag !== TAG.PUBLIC_SUBKEY) continue;
    const sigs = selfSigs(g.sigs);
    const infos = sigs.map(s => signatureInfo(s.body));
    if (infos.some(i => i.type === SIG_SUBKEY_REVOCATION)) continue;
    const binding = infos.filter(i => i.type === SIG_SUBKEY_BINDING).sort((a, b) => b.created - a.created)[0];
    if (!binding) continue;
    let sub;
    try { sub = parseKeyPacket(g.packet); } catch { continue; }
    const canEncrypt = binding.flags !== null ? (binding.flags & 0x0C) !== 0 : ENCRYPTION_ALGORITHMS.has(sub.algorithm);
    if (!canEncrypt) continue;
    if (!best || sub.created > best.created) best = { created: sub.created, packet: g.packet, sigs: sigs.filter((_, i) => infos[i].type === SIG_SUBKEY_BINDING) };
  }
  if (!best) return null;

  const raw = p => block.bytes.subarray(p.start, p.end);
  return Buffer.concat([
    raw(packets[0]), ...selfSigs(keySigs).map(raw),
    raw(uid.packet), ...uidSigs.map(raw),
    raw(best.packet), ...best.sigs.map(raw),
  ]);
}

// The header's value: `addr=…; [prefer-encrypt=mutual; ]keydata=…`, keydata last as Level 1
// asks, its base64 folded over lines of at most 78 characters (each folded line starts with a
// space, which readers drop with the rest of the whitespace in keydata).
export function autocryptHeaderValue({ addr, keydata, preferEncrypt = false }) {
  const b64 = Buffer.from(keydata).toString('base64');
  const lines = b64.match(/.{1,76}/g) || [];
  const head = `addr=${addr};${preferEncrypt ? ' prefer-encrypt=mutual;' : ''} keydata=`;
  return [head, ...lines].join('\r\n ');
}

// The Autocrypt header value for mail `userId` sends from `fromEmail`, or null: the key the
// browser uses for the address too (frontend utils/pgpSend.js ownKeyFor), never a stale one
// (pgp_keys.stale_at: the user can no longer open it, so mail encrypted to it would be lost), a key
// the user imported before one Plimail made, then the newest. `preferEncrypt` is the user's
// "encrypt automatically" setting, which is what prefer-encrypt=mutual tells correspondents.
// Never throws: a key it cannot read leaves the header out, and the message goes without one.
export async function autocryptFor(userId, fromEmail, { preferEncrypt = false, query = defaultQuery } = {}) {
  const addr = String(fromEmail || '').trim().toLowerCase();
  if (!userId || !addr) return null;
  try {
    const { rows } = await query(
      `SELECT armored_public FROM pgp_keys WHERE user_id = $1 AND emails ? $2 AND stale_at IS NULL
       ORDER BY (auto_email IS NULL) DESC, key_created_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [userId, addr],
    );
    const armored = rows?.[0]?.armored_public;
    if (typeof armored !== 'string') return null;
    const keydata = minimalAutocryptKey(armored, addr);
    if (!keydata || keydata.length > MAX_KEYDATA_BYTES) return null;
    return autocryptHeaderValue({ addr, keydata, preferEncrypt });
  } catch (err) {
    console.warn(`[autocrypt] no header for this message: ${err?.message || err}`);
    return null;
  }
}
