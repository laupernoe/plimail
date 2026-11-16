import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { api } from '../utils/api.js';
import { armoredPublicFrom, shortFingerprint, unlockPrivateKey } from '../utils/pgp.js';
import { rememberUnlockedKey, unlockedKey } from '../utils/pgpSession.js';
import { isLoginKey, openOwnKey } from '../utils/pgpKeys.js';
import { keySecretEntry, keySecretOwner, waitForKeySecret } from '../utils/pgpSecret.js';
import { unlockOwnKey } from '../utils/pgpUnlock.js';
import {
  analyzeRaw, decryptMessage, deliveryAddresses, findDecryptionKeys, senderKeysFor, verifySigned,
} from '../utils/pgpReader.js';
import { button } from './pgpStyles.js';

// An OpenPGP message in the reading pane. The raw source comes from the server as it is on the
// mail server; decryption and signature checks happen here, with a key unlocked here. What is
// decrypted is shown, never stored or sent: no body cache, no search, no AI.

// The decrypted HTML is untrusted mail. It is sanitized, then shown in a frame sandboxed without
// scripts and without same-origin access, whose policy loads nothing from anywhere (remote images
// included; the app's own CSP, which srcdoc inherits, applies too). Images the message carries
// are shown from data: URLs.
const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

function bytesToDataUrl(bytes, type) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${/^image\/[a-z0-9.+-]+$/i.test(type) ? type : 'application/octet-stream'};base64,${btoa(bin)}`;
}

export function decryptedFrameDocument(html, inline = []) {
  const byCid = new Map(inline.filter(a => a.contentId).map(a => [a.contentId.toLowerCase(), a]));
  const safe = DOMPurify.sanitize(String(html || ''), {
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'base', 'meta', 'link', 'iframe', 'frame', 'object', 'embed', 'script'],
    ADD_ATTR: ['target'],
  }).replace(/(\ssrc\s*=\s*["'])cid:([^"']+)(["'])/gi, (m, pre, cid, post) => {
    let id = cid;
    // A malformed %-escape in a sender's cid: is not worth breaking the message over.
    try { id = decodeURIComponent(cid); } catch { /* used as written */ }
    const part = byCid.get(id.toLowerCase());
    return part && /^image\//i.test(part.mimeType) ? `${pre}${bytesToDataUrl(part.data, part.mimeType)}${post}` : `${pre}${post}`;
  });
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`
    + '<meta name="referrer" content="no-referrer"><base target="_blank">'
    + '<style>body{margin:14px 16px;font-family:-apple-system,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;background:#fff;overflow-wrap:break-word}'
    + 'img{max-width:100%;height:auto}blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex}</style>'
    + `</head><body>${safe}</body></html>`;
}

// The frame's sandbox: popups for links (opened without the app), nothing else.
export const DECRYPTED_FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const banner = (tone = 'neutral') => ({
  marginBottom: 10, padding: '9px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
  borderLeft: `3px solid ${tone === 'good' ? 'var(--green)' : tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : 'var(--accent)'}`,
  borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)',
});

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

// "Signed by …" for a signature result (utils/pgpReader.js). For a signer whose key is not here,
// `onLookUp` asks the sender's Web Key Directory, only because the user said so: a lookup made by
// opening a message would tell the sender's domain it was read.
export function SignatureLine({ signature, onLookUp, lookingUp = false }) {
  const { t } = useTranslation();
  if (!signature || signature.state === 'none') return null;
  const fp = signature.fingerprint ? shortFingerprint(signature.fingerprint) : (signature.keyId ? shortFingerprint(signature.keyId) : '');
  const tone = { verified: 'good', good: 'good', unknownKey: 'warn', bad: 'bad', partial: 'warn' }[signature.state] || 'neutral';
  const text = {
    verified: t('pgp.read.sigVerified', { key: fp }),
    good: t('pgp.read.sigGood', { key: fp }),
    unknownKey: t('pgp.read.sigUnknown', { key: fp }),
    bad: t('pgp.read.sigBad'),
    partial: t('pgp.read.sigPartial'),
  }[signature.state];
  return (
    <div role="status" data-signature={signature.state} style={banner(tone)}>
      <span style={{ flex: 1 }}>{text}</span>
      {signature.state === 'unknownKey' && onLookUp && (
        <button type="button" disabled={lookingUp} onClick={onLookUp} style={button('plain', lookingUp)}>{t('pgp.read.lookUpKey')}</button>
      )}
    </div>
  );
}

// Offers to keep a key found in the message (an Autocrypt header, an attached key) in the keyring.
function KeyOffer({ offer, onDone }) {
  const { t } = useTranslation();
  const [state, setState] = useState(null);
  if (!offer) return null;
  const take = async () => {
    setState('busy');
    try {
      await api.pgp.addToKeyring({ armored: offer.armored, source: offer.source, email: offer.email, explicit: true });
      setState('done');
      onDone?.();
    } catch {
      setState('failed');
    }
  };
  return (
    <div style={banner('neutral')}>
      <span style={{ flex: 1 }}>
        {state === 'done' ? t('pgp.read.keyImported') : offer.different ? t('pgp.read.keyOfferDifferent', { email: offer.email }) : t('pgp.read.keyOffer', { email: offer.email })}
      </span>
      {state !== 'done' && (
        <button type="button" disabled={state === 'busy'} onClick={take} style={button('plain', state === 'busy')}>{t('pgp.read.importKey')}</button>
      )}
      {state === 'failed' && <span role="alert" style={{ color: 'var(--red)' }}>{t('pgp.errors.generic')}</span>}
    </div>
  );
}

// What the message's Autocrypt header offers, for the user to import or not. Never taken without
// asking: who sent a message is only what its headers claim, and an Authentication-Results header
// may be the sender's own, so a key collected by itself could be anyone's key for the address.
export async function autocryptOffer(analyzed, fromEmail, senderKeys) {
  const ac = analyzed?.autocrypt;
  if (!ac || !fromEmail || ac.addr !== fromEmail.toLowerCase()) return null;
  let parsed;
  try { parsed = await armoredPublicFrom({ base64: ac.keydata }); } catch { return null; }
  const fingerprint = parsed.keys[0]?.getFingerprint();
  if (senderKeys.some(k => k.fingerprint === fingerprint)) return null;
  return { armored: parsed.armored, source: 'autocrypt', email: ac.addr, different: senderKeys.length > 0 };
}

// Downloads of the decrypted files. The type the sender declared is not trusted: every Blob is
// application/octet-stream, so the browser saves the file rather than render it in the app's
// origin; its name stays.
export const ATTACHMENT_BLOB_TYPE = 'application/octet-stream';

function DecryptedAttachments({ attachments }) {
  const { t } = useTranslation();
  const urls = useMemo(() => attachments.map(a => URL.createObjectURL(new Blob([a.data], { type: ATTACHMENT_BLOB_TYPE }))), [attachments]);
  useEffect(() => () => urls.forEach(u => URL.revokeObjectURL(u)), [urls]);
  const [imported, setImported] = useState({});
  if (!attachments.length) return null;
  const importKey = async (a, i) => {
    try {
      const { armored } = await armoredPublicFrom({ bytes: a.data });
      await api.pgp.addToKeyring({ armored, source: 'attachment' });
      setImported(s => ({ ...s, [i]: 'done' }));
    } catch {
      setImported(s => ({ ...s, [i]: 'failed' }));
    }
  };
  return (
    <ul aria-label={t('pgp.read.attachments')} style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {attachments.map((a, i) => (
        <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: 12.5 }}>
          <a href={urls[i]} download={a.filename || 'attachment'} style={{ color: 'var(--text-primary)', textDecoration: 'none', overflowWrap: 'anywhere' }}>{a.filename}</a>
          <span style={{ color: 'var(--text-tertiary)' }}>{formatSize(a.data.length)}</span>
          {a.mimeType === 'application/pgp-keys' && (
            imported[i] === 'done'
              ? <span style={{ color: 'var(--green)' }}>{t('pgp.read.keyImported')}</span>
              : <button type="button" onClick={() => importKey(a, i)} style={button()}>{t('pgp.read.importKey')}</button>
          )}
          {imported[i] === 'failed' && <span role="alert" style={{ color: 'var(--red)' }}>{t('pgp.errors.generic')}</span>}
        </li>
      ))}
    </ul>
  );
}

export function DecryptedBody({ content, subject }) {
  const { t } = useTranslation();
  const doc = useMemo(() => (content.html ? decryptedFrameDocument(content.html, content.inline) : null), [content]);
  return (
    <div>
      {content.subject && content.subject !== subject && content.subject !== '...' && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          {t('pgp.read.protectedSubject')} <strong style={{ color: 'var(--text-primary)' }}>{content.subject}</strong>
        </div>
      )}
      <DecryptedAttachments attachments={content.attachments} />
      {doc ? (
        <iframe
          title={t('pgp.read.frameTitle')}
          sandbox={DECRYPTED_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={doc}
          style={{ width: '100%', minHeight: 320, height: '65vh', border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'white', resize: 'vertical' }}
        />
      ) : (
        <div className="msg-card" translate="yes" style={{
          padding: '14px 16px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.7,
          color: '#1a1a1a', background: 'white', borderRadius: 10, border: '1px solid var(--border-subtle)',
        }}>{content.text || ''}</div>
      )}
    </div>
  );
}

// The sender's keys for checking a signature, local first; `lookUp` asks the directory too.
function useSenderKeys(fromEmail) {
  const [lookingUp, setLookingUp] = useState(false);
  const lookUp = async () => {
    setLookingUp(true);
    try { return await senderKeysFor(fromEmail, api.pgp.lookup, { local: false }); } finally { setLookingUp(false); }
  };
  return { lookingUp, lookUp };
}

// The encrypted message: the lock banner, then the decrypted message. A key protected by the
// Plimail password opens by itself with the secret this tab has (utils/pgpSecret.js); without
// one, Unlock asks for the password once (PgpUnlockPrompt.jsx). A key with its own passphrase asks
// for it here. When the
// message cannot be read here (no key, not for these keys, damaged, no encrypted part found),
// `onShowOriginal` shows it as it was received, so nothing in it is ever out of reach; a message
// that turns out to hold no encrypted part at all is shown that way at once.
export default function PgpMessageView({ message, onOpenSettings, onShowOriginal }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState('loading'); // loading | noKeys | notForYou | locked | decrypting | open | failed
  const [analysis, setAnalysis] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [keyIndex, setKeyIndex] = useState(0);
  const [senderKeys, setSenderKeys] = useState([]);
  const [content, setContent] = useState(null);
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(true);
  const [formError, setFormError] = useState('');
  const [offer, setOffer] = useState(null);
  const [failure, setFailure] = useState('');
  const sender = useSenderKeys(message.from_email);
  const keyRow = candidates[keyIndex] || null;
  const userId = keySecretOwner();

  // Decrypts with `key`; false when it is not the key (a hidden recipient tried in turn).
  const attempt = async (analyzed, key, sKeys) => {
    try {
      setContent(await decryptMessage(analyzed, { decryptionKey: key, senderKeys: sKeys }));
      setPhase('open');
      return true;
    } catch {
      return false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setContent(null);
    setOffer(null);
    setKeyIndex(0);
    (async () => {
      try {
        const [raw, own] = await Promise.all([api.pgp.rawMessage(message.id), api.pgp.keys()]);
        if (cancelled) return;
        const analyzed = analyzeRaw(raw);
        if (!analyzed || !analyzed.armored) {
          // The server took it for encrypted, but there is nothing to decrypt: show it as it is.
          if (onShowOriginal) onShowOriginal();
          else { setFailure(t('pgp.read.unreadable')); setPhase('failed'); }
          return;
        }
        setAnalysis(analyzed);
        const sKeys = await senderKeysFor(message.from_email, api.pgp.lookup);
        if (cancelled) return;
        setSenderKeys(sKeys);
        autocryptOffer(analyzed, message.from_email, sKeys).then(o => { if (!cancelled && o) setOffer(o); });
        if (!own.keys?.length) { setPhase('noKeys'); return; }
        const rows = await findDecryptionKeys(analyzed.armored, own.keys, { preferEmails: deliveryAddresses(analyzed.root) });
        if (cancelled) return;
        if (!rows.length) { setPhase('notForYou'); return; }
        setCandidates(rows);
        // Keys already unlocked in this tab are tried first, then those the Plimail password's
        // secret opens, all without asking.
        setPhase('decrypting');
        for (const row of rows) {
          const key = unlockedKey(row.fingerprint);
          if (key && await attempt(analyzed, key, sKeys)) return;
          if (cancelled) return;
        }
        const entry = userId && rows.some(isLoginKey) ? (await waitForKeySecret(userId), keySecretEntry(userId)) : null;
        if (entry) {
          for (const row of rows.filter(r => isLoginKey(r) && !unlockedKey(r.fingerprint))) {
            let key;
            try { key = await openOwnKey(row, { secret: entry.secret, verified: entry.verified }); } catch { continue; }
            if (cancelled) return;
            if (await attempt(analyzed, key, sKeys)) return;
          }
        }
        if (cancelled) return;
        const firstLocked = rows.findIndex(r => !unlockedKey(r.fingerprint));
        if (firstLocked < 0) { setFailure(t('pgp.read.decryptFailed')); setPhase('failed'); return; }
        setKeyIndex(firstLocked);
        setPhase('locked');
      } catch {
        if (!cancelled) { setFailure(t('pgp.read.loadFailed')); setPhase('failed'); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per message
  }, [message.id]);

  const unlock = async (e) => {
    e.preventDefault();
    if (!passphrase || phase === 'decrypting' || !keyRow) return;
    setFormError('');
    let key;
    try {
      key = await unlockPrivateKey(keyRow.armoredPrivate, passphrase);
    } catch {
      setFormError(t('pgp.errors.wrongPassphrase'));
      return;
    }
    setPassphrase('');
    if (remember) rememberUnlockedKey(keyRow.fingerprint, key);
    setPhase('decrypting');
    if (await attempt(analysis, key, senderKeys)) return;
    // Not this key: with hidden recipients the next one may be; otherwise the message is damaged.
    const next = candidates.findIndex((r, i) => i > keyIndex && !unlockedKey(r.fingerprint));
    if (next >= 0) {
      setKeyIndex(next);
      setFormError(t('pgp.read.notThisKey'));
      setPhase('locked');
      return;
    }
    setFailure(t('pgp.read.decryptFailed'));
    setPhase('failed');
  };

  // A key protected by the Plimail password, and this tab without the secret (or with the current
  // password's, the key being an earlier one's): the prompt, then the message.
  const unlockWithPassword = async () => {
    if (!keyRow || phase === 'decrypting') return;
    setFormError('');
    let key;
    try {
      key = await unlockOwnKey(keyRow, userId);
    } catch (err) {
      if (err?.code !== 'unlockCancelled') setFormError(t('pgp.errors.wrongPassphrase'));
      return;
    }
    setPhase('decrypting');
    if (await attempt(analysis, key, senderKeys)) return;
    const next = candidates.findIndex((r, i) => i > keyIndex && !unlockedKey(r.fingerprint));
    if (next >= 0) { setKeyIndex(next); setPhase('locked'); return; }
    setFailure(t('pgp.read.decryptFailed'));
    setPhase('failed');
  };

  const lookUpSigner = async () => {
    const sKeys = await sender.lookUp();
    setSenderKeys(sKeys);
    const key = keyRow && unlockedKey(keyRow.fingerprint);
    if (key && sKeys.length) await attempt(analysis, key, sKeys);
  };

  const showOriginal = onShowOriginal && ['noKeys', 'notForYou', 'failed', 'locked'].includes(phase) && (
    <button type="button" onClick={onShowOriginal} style={button()}>{t('pgp.read.showOriginal')}</button>
  );

  return (
    <div data-pgp-view={phase}>
      <div role="status" style={banner(phase === 'open' ? 'good' : 'neutral')}>
        <LockIcon />
        <span style={{ flex: 1, color: 'var(--text-primary)' }}>
          {phase === 'open' ? t('pgp.read.decrypted') : t('pgp.read.encrypted')}
        </span>
        {showOriginal}
      </div>
      {phase === 'loading' || phase === 'decrypting' ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '8px 0' }}>{phase === 'loading' ? t('common.loading') : t('pgp.read.decrypting')}</div>
      ) : null}
      {phase === 'noKeys' && (
        <div style={banner('warn')}>
          <span style={{ flex: 1 }}>{t('pgp.read.noKeys')}</span>
          {onOpenSettings && <button type="button" onClick={onOpenSettings} style={button()}>{t('pgp.read.openSettings')}</button>}
        </div>
      )}
      {phase === 'notForYou' && <div style={banner('warn')}>{t('pgp.read.notForYou')}</div>}
      {phase === 'failed' && <div role="alert" style={banner('bad')}>{failure}</div>}
      {phase === 'locked' && keyRow && isLoginKey(keyRow) && (
        <div style={{ ...banner('neutral'), flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 220px', color: 'var(--text-primary)' }}>{t('pgp.read.unlockWithPassword')}</span>
          <button type="button" onClick={unlockWithPassword} style={button('primary')}>{t('pgp.read.unlock')}</button>
          {formError && <span role="alert" style={{ color: 'var(--red)', fontSize: 12, flexBasis: '100%' }}>{formError}</span>}
        </div>
      )}
      {phase === 'locked' && keyRow && !isLoginKey(keyRow) && (
        <form onSubmit={unlock} style={{ ...banner('neutral'), flexDirection: 'column', alignItems: 'stretch' }}>
          <span style={{ color: 'var(--text-primary)' }}>{t('pgp.read.enterPassphrase', { email: keyRow.emails?.[0] || '' })}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="password" autoComplete="off" autoFocus value={passphrase} onChange={e => setPassphrase(e.target.value)}
              aria-label={t('pgp.read.passphrase')} placeholder={t('pgp.read.passphrase')}
              style={{ flex: '1 1 200px', minWidth: 0, padding: '6px 9px', fontSize: 13, borderRadius: 6, border: `1px solid ${formError ? 'var(--red)' : 'var(--border)'}`, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
            <button type="submit" disabled={!passphrase} style={button('primary', !passphrase)}>{t('pgp.read.decrypt')}</button>
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            {t('pgp.read.rememberSession')}
          </label>
          {formError && <span role="alert" style={{ color: 'var(--red)', fontSize: 12 }}>{formError}</span>}
        </form>
      )}
      <KeyOffer offer={offer} onDone={() => setOffer(null)} />
      {phase === 'open' && content && (
        <>
          <SignatureLine signature={content.signature} onLookUp={lookUpSigner} lookingUp={sender.lookingUp} />
          <DecryptedBody content={content} subject={message.subject} />
        </>
      )}
    </div>
  );
}

// A signed (not encrypted) message: the body shows as usual; this line says whether the signature
// holds, checked against the sender's keys here. A signature over only part of what is shown
// gets a "partly signed" line and no verdict.
export function PgpSignatureBadge({ message }) {
  const [signature, setSignature] = useState(null);
  const [offer, setOffer] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const sender = useSenderKeys(message.from_email);
  useEffect(() => {
    let cancelled = false;
    setSignature(null);
    setOffer(null);
    (async () => {
      try {
        const analyzed = analyzeRaw(await api.pgp.rawMessage(message.id));
        if (!analyzed || !['signed', 'inlineSigned', 'partlySigned'].includes(analyzed.kind)) return;
        setAnalysis(analyzed);
        if (analyzed.kind === 'partlySigned') { if (!cancelled) setSignature({ state: 'partial' }); return; }
        const sKeys = await senderKeysFor(message.from_email, api.pgp.lookup);
        const result = await verifySigned(analyzed, sKeys);
        if (cancelled) return;
        setSignature(result);
        const o = await autocryptOffer(analyzed, message.from_email, sKeys);
        if (!cancelled && o) setOffer(o);
      } catch { /* no line rather than a wrong one */ }
    })();
    return () => { cancelled = true; };
  }, [message.id, message.from_email]);
  const lookUp = async () => {
    const sKeys = await sender.lookUp();
    if (analysis && sKeys.length) setSignature(await verifySigned(analysis, sKeys));
  };
  return (
    <>
      <SignatureLine signature={signature} onLookUp={lookUp} lookingUp={sender.lookingUp} />
      <KeyOffer offer={offer} onDone={() => setOffer(null)} />
    </>
  );
}
