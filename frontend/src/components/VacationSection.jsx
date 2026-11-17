import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { Confirm, PLIMAIL_SCRIPT, Pill, button, errorText, input, reasonText, sieveAccounts } from './ServerFiltersSection.jsx';

// Settings → Mail → Out of office: an automatic reply the mail server sends itself (Sieve
// vacation, RFC 5230), written into Plimail's script next to the server filters
// (backend routes/sieve.js).

const label = { display: 'block', fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)', margin: '14px 0 5px' };
const hint = { fontSize: 12.5, color: 'var(--text-secondary)', margin: '5px 0 0', lineHeight: 1.5 };
const note = {
  fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
  borderRadius: 8, padding: '8px 12px', margin: '12px 0 0', lineHeight: 1.5,
};

const emptyForm = () => ({ enabled: false, subject: '', body: '', start: '', end: '', days: 7, addresses: '' });

function formFrom(vacation) {
  if (!vacation) return emptyForm();
  return {
    enabled: vacation.enabled, subject: vacation.subject, body: vacation.body,
    start: vacation.start || '', end: vacation.end || '', days: vacation.days,
    addresses: vacation.addresses.join(', '),
  };
}

// What the routes take: empty dates as null, the other addresses as a list.
export function vacationPayload(form) {
  return {
    enabled: form.enabled,
    subject: form.subject,
    body: form.body,
    start: form.start || null,
    end: form.end || null,
    days: Number(form.days),
    addresses: form.addresses.split(/[\s,;]+/).filter(Boolean),
  };
}

function vacationError(t, err) {
  if (err?.code === 'invalid_vacation') return t('admin.vacation.errorInvalid');
  if (err?.code === 'extension_missing') return t('admin.vacation.errorExtension');
  return errorText(t, err);
}

export default function VacationSection() {
  const { t } = useTranslation();
  const { accounts } = useStore();
  const eligible = useMemo(() => sieveAccounts(accounts), [accounts]);
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const current = accountId || eligible[0]?.id || '';

  const load = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    setLoadError('');
    try {
      const s = await api.sieve.status(current);
      setStatus(s);
      setForm(formFrom(s.plimail?.vacation));
    } catch (err) {
      setStatus(null);
      setLoadError(errorText(t, err));
    } finally {
      setLoading(false);
    }
  }, [current, t]);

  useEffect(() => {
    setStatus(null);
    setMessage(null);
    setConfirm(null);
    load();
  }, [load]);

  const set = patch => setForm(f => ({ ...f, ...patch }));

  const save = async (options = {}) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.sieve.saveVacation(current, { vacation: vacationPayload(form), ...options });
      setConfirm(null);
      setMessage({ error: false, text: form.enabled ? t('admin.vacation.savedOn') : t('admin.vacation.savedOff') });
      load();
    } catch (err) {
      if (err.code === 'other_active') setConfirm({ kind: 'active', active: err.active, options });
      else if (err.code === 'plimail_edited') setConfirm({ kind: 'edited', options });
      else setMessage({ error: true, text: vacationError(t, err) });
    } finally {
      setBusy(false);
    }
  };

  const extensions = status?.extensions || [];
  const canReply = extensions.includes('vacation');
  const canDate = extensions.includes('date') && extensions.includes('relational');
  const saved = status?.plimail?.vacation;
  const running = !!saved?.enabled && status?.active === PLIMAIL_SCRIPT;

  return (
    <section aria-labelledby="vacation-title" style={{ maxWidth: 640 }}>
      <h3 id="vacation-title" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px' }}>
        {t('admin.vacation.title')}
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>
        {t('admin.vacation.intro')}
      </p>

      {eligible.length === 0 && <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.serverFilters.noAccounts')}</p>}
      {eligible.length > 1 && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
          {t('admin.serverFilters.account')}
          <select value={current} onChange={e => setAccountId(e.target.value)} style={input}>
            {eligible.map(a => <option key={a.id} value={a.id}>{a.email_address}</option>)}
          </select>
        </label>
      )}

      {loading && <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.serverFilters.connecting')}</p>}
      {loadError && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{loadError}</p>}

      {status && (!status.supported || !canReply) && (
        <div style={note}>
          <div style={{ marginBottom: 4 }}><Pill color="var(--text-tertiary)">{t('admin.serverFilters.unsupported')}</Pill></div>
          {!status.supported
            ? <>{t('admin.vacation.needsSieve')} {reasonText(t, status.reason)}</>
            : t('admin.vacation.noVacationExtension')}
        </div>
      )}

      {status?.supported && canReply && (
        <form onSubmit={e => { e.preventDefault(); save(); }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.enabled} onChange={e => set({ enabled: e.target.checked })} />
              {t('admin.vacation.enable')}
            </label>
            {running
              ? <Pill color="var(--green)">{t('admin.vacation.on')}</Pill>
              : <Pill color="var(--text-tertiary)">{t('admin.vacation.off')}</Pill>}
          </div>
          {saved?.enabled && status.active !== PLIMAIL_SCRIPT && <p role="note" style={note}>{t('admin.vacation.notActive')}</p>}

          <label htmlFor="vacation-subject" style={label}>{t('admin.vacation.subject')}</label>
          <input
            id="vacation-subject"
            value={form.subject}
            onChange={e => set({ subject: e.target.value })}
            placeholder={t('admin.vacation.subjectPh')}
            maxLength={200}
            style={{ ...input, width: '100%', boxSizing: 'border-box' }}
          />

          <label htmlFor="vacation-body" style={label}>{t('admin.vacation.body')}</label>
          <textarea
            id="vacation-body"
            value={form.body}
            onChange={e => set({ body: e.target.value })}
            placeholder={t('admin.vacation.bodyPh')}
            maxLength={4000}
            rows={6}
            required={form.enabled}
            style={{ ...input, width: '100%', boxSizing: 'border-box', lineHeight: 1.5, resize: 'vertical', fontFamily: 'inherit' }}
          />

          {canDate ? (
            <>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <div>
                  <label htmlFor="vacation-start" style={label}>{t('admin.vacation.start')}</label>
                  <input id="vacation-start" type="date" value={form.start} max={form.end || undefined} onChange={e => set({ start: e.target.value })} style={input} />
                </div>
                <div>
                  <label htmlFor="vacation-end" style={label}>{t('admin.vacation.end')}</label>
                  <input id="vacation-end" type="date" value={form.end} min={form.start || undefined} onChange={e => set({ end: e.target.value })} style={input} />
                </div>
              </div>
              <p style={hint}>{t('admin.vacation.datesHint')}</p>
            </>
          ) : <p style={hint}>{t('admin.vacation.noDates')}</p>}

          <label htmlFor="vacation-days" style={label}>{t('admin.vacation.days')}</label>
          <input
            id="vacation-days"
            type="number"
            min={1}
            max={30}
            value={form.days}
            onChange={e => set({ days: e.target.value })}
            style={{ ...input, width: 80 }}
          />
          <p style={hint}>{t('admin.vacation.daysHint')}</p>

          <label htmlFor="vacation-addresses" style={label}>{t('admin.vacation.addresses')}</label>
          <input
            id="vacation-addresses"
            value={form.addresses}
            onChange={e => set({ addresses: e.target.value })}
            placeholder={t('admin.serverFilters.addressPh')}
            style={{ ...input, width: '100%', boxSizing: 'border-box' }}
          />
          <p style={hint}>{t('admin.vacation.addressesHint')}</p>

          <div style={{ marginTop: 16 }}>
            <button type="submit" disabled={busy} style={button('primary', busy)}>
              {busy ? t('admin.serverFilters.saving') : t('admin.vacation.save')}
            </button>
          </div>

          {confirm?.kind === 'active' && (
            <Confirm
              busy={busy}
              text={t('admin.serverFilters.confirmReplaceActive', { active: confirm.active })}
              confirmLabel={t('admin.serverFilters.replaceActive')}
              onConfirm={() => save({ ...confirm.options, replaceActive: true })}
              onCancel={() => setConfirm(null)}
            />
          )}
          {confirm?.kind === 'edited' && (
            <Confirm
              busy={busy}
              text={t('admin.vacation.confirmReplaceEdited')}
              confirmLabel={t('admin.serverFilters.overwrite')}
              onConfirm={() => save({ ...confirm.options, overwrite: true })}
              onCancel={() => setConfirm(null)}
            />
          )}
          {message && <p role={message.error ? 'alert' : 'status'} style={{ fontSize: 12.5, color: message.error ? 'var(--red)' : 'var(--green)', margin: '8px 0 0' }}>{message.text}</p>}
        </form>
      )}
    </section>
  );
}
