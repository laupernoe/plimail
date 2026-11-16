import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { api } from '../utils/api.js';
import { armoredPublicFrom, shortFingerprint, unlockPrivateKey } from '../utils/pgp.js';
import { rememberUnlockedKey, unlockedKey } from '../utils/pgpSession.js';
import { analyzeRaw, decryptMessage, findDecryptionKey, senderKeysFor, verifySigned } from '../utils/pgpReader.js';
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
    const part = byCid.get(decodeURIComponent(cid).toLowerCase());
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

// "Signed by …" for a signature result (utils/pgpReader.js).
export function SignatureLine({ signature }) {
  const { t } = useTranslation();
  if (!signature || signature.state === 'none') return null;
  const fp = signature.fingerprint ? shortFingerprint(signature.fingerprint) : (signature.keyId ? shortFingerprint(signature.keyId) : '');
  const tone = { verified: 'good', good: 'good', unknownKey: 'warn', bad: 'bad' }[signature.state] || 'neutral';
  const text = {
    verified: t('pgp.read.sigVerified', { key: fp }),
    good: t('pgp.read.sigGood', { key: fp }),
    unknownKey: t('pgp.read.sigUnknown', { key: fp }),
    bad: t('pgp.read.sigBad'),
  }[signature.state];
  return (
    <div role="status" data-signature={signature.state} style={banner(tone)}>
      <span style={{ flex: 1 }}>{text}</span>
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

// What the message's Autocrypt header offers, collected at once when the sender has no key here
// yet (unverified, as the keyring marks every key until the user checks it), offered otherwise.
async function autocryptOffer(analyzed, fromEmail, senderKeys) {
  const ac = analyzed?.autocrypt;
  if (!ac || !fromEmail || ac.addr !== fromEmail.toLowerCase()) return null;
  let parsed;
  try { parsed = await armoredPublicFrom({ base64: ac.keydata }); } catch { return null; }
  const fingerprint = parsed.keys[0]?.getFingerprint();
  if (senderKeys.some(k => k.fingerprint === fingerprint)) return null;
  if (!senderKeys.length) {
    try {
      await api.pgp.addToKeyring({ armored: parsed.armored, source: 'autocrypt', email: ac.addr });
      return { collected: true };
    } catch { /* offered below instead */ }
  }
  return { armored: parsed.armored, source: 'autocrypt', email: ac.addr, different: senderKeys.length > 0 };
}

function DecryptedAttachments({ attachments }) {
  const { t } = useTranslation();
  const urls = useMemo(() => attachments.map(a => URL.createObjectURL(new Blob([a.data], { type: a.mimeType || 'application/octet-stream' }))), [attachments]);
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
          <a href={urls[i]} download={a.filename} style={{ color: 'var(--text-primary)', textDecoration: 'none', overflowWrap: 'anywhere' }}>{a.filename}</a>
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

// The encrypted message: the lock banner, the passphrase, then the decrypted message.
export default function PgpMessageView({ message, onOpenSettings }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState('loading'); // loading | noKeys | notForYou | locked | decrypting | open | failed
  const [analysis, setAnalysis] = useState(null);
  const [keyRow, setKeyRow] = useState(null);
  const [senderKeys, setSenderKeys] = useState([]);
  const [content, setContent] = useState(null);
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(true);
  const [formError, setFormError] = useState('');
  const [offer, setOffer] = useState(null);
  const [failure, setFailure] = useState('');

  const open = async (analyzed, row, key, sKeys) => {
    setPhase('decrypting');
    try {
      setContent(await decryptMessage(analyzed, { decryptionKey: key, senderKeys: sKeys }));
      setPhase('open');
    } catch {
      setFailure(t('pgp.read.decryptFailed'));
      setPhase('failed');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setContent(null);
    setOffer(null);
    (async () => {
      try {
        const [raw, own] = await Promise.all([api.pgp.rawMessage(message.id), api.pgp.keys()]);
        if (cancelled) return;
        const analyzed = analyzeRaw(raw);
        if (!analyzed || !analyzed.armored) { setFailure(t('pgp.read.unreadable')); setPhase('failed'); return; }
        setAnalysis(analyzed);
        const sKeys = await senderKeysFor(message.from_email, api.pgp.lookup);
        if (cancelled) return;
        setSenderKeys(sKeys);
        autocryptOffer(analyzed, message.from_email, sKeys).then(o => { if (!cancelled && o && !o.collected) setOffer(o); });
        if (!own.keys?.length) { setPhase('noKeys'); return; }
        const row = await findDecryptionKey(analyzed.armored, own.keys);
        if (cancelled) return;
        if (!row) { setPhase('notForYou'); return; }
        setKeyRow(row);
        const key = unlockedKey(row.fingerprint);
        if (key) await open(analyzed, row, key, sKeys);
        else setPhase('locked');
      } catch {
        if (!cancelled) { setFailure(t('pgp.read.loadFailed')); setPhase('failed'); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per message
  }, [message.id]);

  const unlock = async (e) => {
    e.preventDefault();
    if (!passphrase || phase === 'decrypting') return;
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
    await open(analysis, keyRow, key, senderKeys);
  };

  return (
    <div data-pgp-view={phase}>
      <div role="status" style={banner(phase === 'open' ? 'good' : 'neutral')}>
        <LockIcon />
        <span style={{ flex: 1, color: 'var(--text-primary)' }}>
          {phase === 'open' ? t('pgp.read.decrypted') : t('pgp.read.encrypted')}
        </span>
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
      {phase === 'locked' && keyRow && (
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
          <SignatureLine signature={content.signature} />
          <DecryptedBody content={content} subject={message.subject} />
        </>
      )}
    </div>
  );
}

// A signed (not encrypted) message: the body shows as usual; this line says whether the signature
// holds, checked against the sender's keys.
export function PgpSignatureBadge({ message }) {
  const [signature, setSignature] = useState(null);
  const [offer, setOffer] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setSignature(null);
    setOffer(null);
    (async () => {
      try {
        const analyzed = analyzeRaw(await api.pgp.rawMessage(message.id));
        if (!analyzed || (analyzed.kind !== 'signed' && analyzed.kind !== 'inlineSigned')) return;
        const sKeys = await senderKeysFor(message.from_email, api.pgp.lookup);
        const result = await verifySigned(analyzed, sKeys);
        if (cancelled) return;
        setSignature(result);
        const o = await autocryptOffer(analyzed, message.from_email, sKeys);
        // A key collected from this very message is not checked against it: anyone can sign with
        // a key they put in their own message. It verifies later messages, still unverified.
        if (!cancelled && o && !o.collected) setOffer(o);
      } catch { /* no line rather than a wrong one */ }
    })();
    return () => { cancelled = true; };
  }, [message.id, message.from_email]);
  return (
    <>
      <SignatureLine signature={signature} />
      <KeyOffer offer={offer} onDone={() => setOffer(null)} />
    </>
  );
}
