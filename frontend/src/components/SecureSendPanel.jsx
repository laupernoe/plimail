import { useTranslation } from 'react-i18next';
import { passwordStrength } from '../utils/secureMessageCrypto.js';
import { SECURE_DEFAULT_EXPIRY_DAYS, SECURE_EXPIRY_DAYS } from '../utils/secureSend.js';

// The composer's password protection (utils/secureSend.js): the lock that turns it on, and the
// password, confirmation and expiry it asks for. `value` is null while it is off.

export const secureOff = null;
export const secureDefaults = () => ({ password: '', confirm: '', expiresInDays: SECURE_DEFAULT_EXPIRY_DAYS });

export function SecureSendToggle({ value, onChange, disabled, mobile }) {
  const { t } = useTranslation();
  const on = value != null;
  return (
    <button
      type="button"
      title={t('compose.secure.toggle')}
      aria-label={t('compose.secure.toggle')}
      aria-pressed={on}
      disabled={disabled}
      onMouseDown={e => e.preventDefault()}
      onClick={() => onChange(on ? secureOff : secureDefaults())}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        padding: mobile ? '6px 8px' : '4px 8px', border: 'none', borderRadius: 5,
        background: on ? 'var(--bg-hover)' : 'none',
        color: on ? 'var(--accent)' : 'var(--text-tertiary)',
        cursor: disabled ? 'default' : 'pointer', flexShrink: 0,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <svg width={mobile ? 16 : 14} height={mobile ? 16 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        {on ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 7.5-1.9" />}
      </svg>
    </button>
  );
}

const STRENGTH_COLOR = { tooShort: 'var(--text-tertiary)', weak: 'var(--red)', fair: 'var(--amber)', strong: 'var(--green)' };

// `embedded`: inside the lock's panel (PgpSendPanel.jsx ProtectionPanel), which draws the frame.
export default function SecureSendPanel({ value, onChange, disabled, mobile, embedded = false }) {
  const { t } = useTranslation();
  if (value == null) return null;
  const set = patch => onChange({ ...value, ...patch });
  const strength = passwordStrength(value.password);
  const strengthText = {
    tooShort: t('compose.secure.strengthTooShort'),
    weak: t('compose.secure.strengthWeak'),
    fair: t('compose.secure.strengthFair'),
    strong: t('compose.secure.strengthStrong'),
  }[strength];
  const mismatch = value.confirm !== '' && value.confirm !== value.password;
  const input = {
    flex: '1 1 160px', minWidth: 0, padding: '6px 9px', fontSize: 13, borderRadius: 6,
    border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none',
  };
  const label = { fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 };
  const note = { fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 };

  return (
    <section
      aria-label={t('compose.secure.title')}
      style={embedded ? { display: 'flex', flexDirection: 'column', gap: 10 } : {
        padding: mobile ? '12px 14px' : '10px 14px', borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-tertiary)', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{t('compose.secure.title')}</div>
        <p style={note}>{t('compose.secure.explain')}</p>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 160px', minWidth: 0 }}>
          <span style={label}>{t('compose.secure.password')}</span>
          <input
            type="password" autoComplete="new-password" value={value.password} disabled={disabled}
            onChange={e => set({ password: e.target.value })}
            style={{ ...input, width: '100%' }}
          />
        </label>
        <label style={{ flex: '1 1 160px', minWidth: 0 }}>
          <span style={label}>{t('compose.secure.confirm')}</span>
          <input
            type="password" autoComplete="new-password" value={value.confirm} disabled={disabled}
            aria-invalid={mismatch ? 'true' : undefined}
            onChange={e => set({ confirm: e.target.value })}
            style={{ ...input, width: '100%', borderColor: mismatch ? 'var(--red)' : 'var(--border)' }}
          />
        </label>
        <label style={{ flex: '0 0 auto' }}>
          <span style={label}>{t('compose.secure.expiry')}</span>
          <select
            value={value.expiresInDays} disabled={disabled}
            onChange={e => set({ expiresInDays: Number(e.target.value) })}
            style={{ ...input, flex: 'none', padding: '5px 6px', cursor: 'pointer' }}
          >
            {SECURE_EXPIRY_DAYS.map(d => (
              <option key={d} value={d}>
                {d === 1 ? t('compose.secure.expiry1') : d === 7 ? t('compose.secure.expiry7') : t('compose.secure.expiry30')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div aria-live="polite" style={{ fontSize: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {value.password && <span style={{ color: STRENGTH_COLOR[strength] }}>{strengthText}</span>}
        {mismatch && <span style={{ color: 'var(--red)' }}>{t('compose.secure.mismatch')}</span>}
      </div>
      <p style={{ ...note, color: 'var(--text-primary)' }}>{t('compose.secure.shareNote')}</p>
      <p style={note}>{t('compose.secure.limits')}</p>
    </section>
  );
}
