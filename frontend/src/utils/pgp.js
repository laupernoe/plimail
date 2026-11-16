// OpenPGP in the browser, through OpenPGP.js. Everything that touches a private key, a passphrase
// or a decrypted message happens here and nowhere on the server: keys are generated and unlocked
// here, messages encrypted, signed, decrypted and verified here. The server stores private keys
// only as OpenPGP.js leaves them, encrypted with their passphrase.
//
// OpenPGP.js is loaded on first use (a dynamic import), so the mail app's bundle does not carry it.

let loading = null;
export function loadOpenpgp() {
  if (!loading) loading = import('openpgp').catch((err) => { loading = null; throw err; });
  return loading;
}

export class PgpError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'PgpError';
    this.code = code;
  }
}

export const shortFingerprint = fp => String(fp || '').toUpperCase().slice(-16).replace(/(.{4})(?=.)/g, '$1 ');
export const formatFingerprint = fp => String(fp || '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');

const emailOf = (userId) => {
  const s = String(userId || '');
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s) || /^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(s);
  return m ? m[1].toLowerCase() : null;
};

// What a key says about itself, for lists and checks. Never throws for an expired or revoked key:
// it says so instead.
export async function keyInfo(key) {
  const userIds = key.getUserIDs();
  let expires = null;
  try {
    const t = await key.getExpirationTime();
    expires = t === Infinity || t == null ? null : new Date(t);
  } catch { /* a key with no valid self-signature has none */ }
  let canEncrypt = true;
  try { await key.getEncryptionKey(); } catch { canEncrypt = false; }
  let revoked = false;
  try { revoked = await key.isRevoked(); } catch { /* treated as not revoked; canEncrypt still says */ }
  return {
    fingerprint: key.getFingerprint(),
    userIds,
    emails: [...new Set(userIds.map(emailOf).filter(Boolean))],
    created: key.getCreationTime(),
    expires,
    expired: Boolean(expires && expires.getTime() <= Date.now()),
    revoked,
    canEncrypt,
    isPrivate: key.isPrivate(),
  };
}

export async function readArmoredKeys(armored) {
  const openpgp = await loadOpenpgp();
  try {
    return await openpgp.readKeys({ armoredKeys: armored });
  } catch {
    throw new PgpError('invalidKey');
  }
}

// A new key pair, Ed25519 for signing and Curve25519 for encryption, protected by `passphrase`.
// The "legacy" encodings of the two curves in a v4 key: what GnuPG, Thunderbird (RNP), Proton and
// every other current implementation read. OpenPGP.js's default curve25519 uses RFC 9580's new
// algorithm numbers, which GnuPG 2.4 and older RNP cannot use.
export async function generateKeyPair({ name, email, passphrase }) {
  if (!passphrase) throw new PgpError('passphraseRequired');
  const openpgp = await loadOpenpgp();
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ ...(name ? { name } : {}), email }],
    passphrase,
    format: 'armored',
  });
  const key = await openpgp.readKey({ armoredKey: publicKey });
  return { armoredPrivate: privateKey, armoredPublic: publicKey, fingerprint: key.getFingerprint() };
}

// A private key brought from elsewhere (Proton, Thunderbird, GnuPG). It must open with
// `passphrase`; one that has no passphrase gets `newPassphrase` (required then), since no private
// key is stored without one. Returns the armored pair to store.
export async function preparePrivateKeyImport(armored, passphrase, newPassphrase = '') {
  const openpgp = await loadOpenpgp();
  let key;
  try {
    key = await openpgp.readPrivateKey({ armoredKey: armored });
  } catch {
    throw new PgpError('invalidKey');
  }
  let toStore = key;
  if (key.isDecrypted()) {
    if (!newPassphrase) throw new PgpError('unprotectedKey');
    toStore = await openpgp.encryptKey({ privateKey: key, passphrase: newPassphrase });
  } else {
    try {
      await openpgp.decryptKey({ privateKey: key, passphrase });
    } catch {
      throw new PgpError('wrongPassphrase');
    }
  }
  return { armoredPrivate: toStore.armor(), armoredPublic: toStore.toPublic().armor(), fingerprint: key.getFingerprint() };
}

// The private key opened with its passphrase, for this tab only (utils/pgpSession.js keeps it).
export async function unlockPrivateKey(armoredPrivate, passphrase) {
  const openpgp = await loadOpenpgp();
  const key = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
  try {
    return await openpgp.decryptKey({ privateKey: key, passphrase });
  } catch {
    throw new PgpError('wrongPassphrase');
  }
}

// `data` (the MIME entity, bytes) encrypted to every key in `recipientArmored` (the sender's own
// public key included by the caller, so the Sent copy stays readable), signed with `signingKey`
// when given. Armored, as PGP/MIME carries it.
export async function encryptMime(data, { recipientArmored, signingKey = null }) {
  const openpgp = await loadOpenpgp();
  const encryptionKeys = [];
  for (const armored of recipientArmored) encryptionKeys.push(...await openpgp.readKeys({ armoredKeys: armored }));
  if (!encryptionKeys.length) throw new PgpError('noRecipientKeys');
  const message = await openpgp.createMessage({ binary: data });
  try {
    return await openpgp.encrypt({ message, encryptionKeys, ...(signingKey ? { signingKeys: signingKey } : {}), format: 'armored' });
  } catch (err) {
    throw new PgpError('encryptFailed', err?.message);
  }
}

// The key IDs a message is encrypted to, as hex; '0000000000000000' marks a hidden recipient.
export async function encryptionKeyIds(armoredMessage) {
  const openpgp = await loadOpenpgp();
  let message;
  try {
    message = await openpgp.readMessage({ armoredMessage });
  } catch {
    throw new PgpError('invalidMessage');
  }
  return message.getEncryptionKeyIDs().map(id => id.toHex());
}

// Which of `keys` (readArmoredKeys results, or { armored } rows read through it) a message is for.
export function keyMatches(key, keyIdsHex) {
  const own = key.getKeyIDs().map(id => id.toHex());
  return keyIdsHex.some(id => id === '0000000000000000' || own.includes(id));
}

// Signature results from OpenPGP.js as { state, keyId, fingerprint }: 'good' when a key in
// `verificationKeys` verifies it, 'bad' when it does not, 'unknownKey' when none of them made it.
async function signatureState(signatures, verificationKeys) {
  if (!signatures?.length) return { state: 'none' };
  const sig = signatures[0];
  const keyId = sig.keyID?.toHex?.() || null;
  const signer = verificationKeys.find(k => k.getKeyIDs().some(id => id.toHex() === keyId));
  if (!signer) {
    try { await sig.verified; } catch { /* no key for it: unknown, not bad */ }
    return { state: 'unknownKey', keyId };
  }
  try {
    await sig.verified;
    return { state: 'good', keyId, fingerprint: signer.getFingerprint() };
  } catch {
    return { state: 'bad', keyId, fingerprint: signer.getFingerprint() };
  }
}

// Decrypts an armored message with an unlocked private key. Returns { data (bytes), signature }
// where signature is as signatureState gives it, checked against `verificationArmored` keys.
export async function decryptArmored(armoredMessage, { decryptionKey, verificationArmored = [] }) {
  const openpgp = await loadOpenpgp();
  let message;
  try {
    message = await openpgp.readMessage({ armoredMessage });
  } catch {
    throw new PgpError('invalidMessage');
  }
  const verificationKeys = await readAll(openpgp, verificationArmored);
  let result;
  try {
    result = await openpgp.decrypt({
      message, decryptionKeys: decryptionKey, format: 'binary',
      ...(verificationKeys.length ? { verificationKeys } : {}),
    });
  } catch (err) {
    throw new PgpError('decryptFailed', err?.message);
  }
  return { data: result.data, signature: await signatureState(result.signatures, verificationKeys) };
}

// A detached signature (multipart/signed) over `data` (the signed MIME part, bytes).
export async function verifyDetached(data, armoredSignature, verificationArmored = []) {
  const openpgp = await loadOpenpgp();
  let signature;
  try {
    signature = await openpgp.readSignature({ armoredSignature });
  } catch {
    return { state: 'bad' };
  }
  const verificationKeys = await readAll(openpgp, verificationArmored);
  const message = await openpgp.createMessage({ binary: data });
  if (!verificationKeys.length) {
    return { state: 'unknownKey', keyId: signature.getSigningKeyIDs()[0]?.toHex() || null };
  }
  const { signatures } = await openpgp.verify({ message, signature, verificationKeys });
  return signatureState(signatures, verificationKeys);
}

// An inline cleartext-signed text (-----BEGIN PGP SIGNED MESSAGE-----): { text, signature }.
export async function verifyCleartext(armoredText, verificationArmored = []) {
  const openpgp = await loadOpenpgp();
  let message;
  try {
    message = await openpgp.readCleartextMessage({ cleartextMessage: armoredText });
  } catch {
    return { text: null, signature: { state: 'bad' } };
  }
  const verificationKeys = await readAll(openpgp, verificationArmored);
  if (!verificationKeys.length) {
    return { text: message.getText(), signature: { state: 'unknownKey', keyId: message.getSigningKeyIDs()[0]?.toHex() || null } };
  }
  const { signatures } = await openpgp.verify({ message, verificationKeys });
  return { text: message.getText(), signature: await signatureState(signatures, verificationKeys) };
}

async function readAll(openpgp, armoredList) {
  const keys = [];
  for (const armored of armoredList) {
    try { keys.push(...await openpgp.readKeys({ armoredKeys: armored })); } catch { /* a damaged key verifies nothing */ }
  }
  return keys;
}

// A public key as it comes in a message (an application/pgp-keys attachment, armored or binary;
// an Autocrypt header's base64 keydata), armored for the keyring. Throws PgpError('invalidKey'),
// or 'privateKey' for a key that carries secret material, which never goes to the keyring.
export async function armoredPublicFrom({ bytes = null, base64 = null }) {
  const openpgp = await loadOpenpgp();
  let data = bytes;
  if (base64 != null) data = Uint8Array.from(atob(String(base64).replace(/\s+/g, '')), c => c.charCodeAt(0));
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  let keys;
  try {
    keys = text.includes('-----BEGIN PGP')
      ? await openpgp.readKeys({ armoredKeys: text })
      : await openpgp.readKeys({ binaryKeys: data });
  } catch {
    throw new PgpError('invalidKey');
  }
  if (keys.some(k => k.isPrivate())) throw new PgpError('privateKey');
  return { armored: keys.map(k => k.armor()).join('\n'), keys };
}
