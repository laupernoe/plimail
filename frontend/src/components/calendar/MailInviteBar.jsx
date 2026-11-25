import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { appLocale } from '../../utils/formatDate.js';
import { dayKey, formatWhen } from '../../utils/calendarDates.js';
import { ATTENDEE_KEYS, mailMeta } from './calendarEvents.js';
import { answerError, answerInvitation } from './invitations.js';
import { AnswerGroup, Icon } from './calendarUi.jsx';

// The invitation a message carries, above it in the mail view, with the same answers as the
// calendar's inbox: answering here takes it out of there, and an answer given there shows here.
// It reads the list the app already keeps (useInvitationWatch), so opening mail asks nothing more.
export default function MailInviteBar({ messageId }) {
  const { t } = useTranslation();
  const data = useStore(s => s.invitations);
  const setShowCalendar = useStore(s => s.setShowCalendar);
  const setCalendarFocus = useStore(s => s.setCalendarFocus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const locale = appLocale();
  const meta = useMemo(() => mailMeta(t, locale), [t, locale]);

  const carries = i => (i.messageIds || [i.messageId]).includes(messageId);
  const pending = data?.invitations?.find(carries) || null;
  const inv = pending || data?.answered?.find(carries) || null;
  if (!inv) return null;

  const answer = async (status) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await answerInvitation(inv, status, meta);
    } catch (err) {
      setError(answerError(err, t));
    } finally {
      setBusy(false);
    }
  };
  const show = () => {
    setCalendarFocus({ day: inv.allDay ? inv.start : dayKey(new Date(inv.start)) });
    setShowCalendar(true);
  };

  return (
    <div className="msg-notice" role="group" aria-label={t('calendar.invitations.mailLabel')} style={{
      marginBottom: 10, padding: '9px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderLeft: `3px solid ${pending ? 'var(--accent)' : 'var(--text-tertiary)'}`, borderRadius: 8,
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)',
    }}>
      <Icon name="calendar" size={15} style={{ color: 'var(--text-tertiary)' }} />
      <span style={{ flex: '1 1 200px', minWidth: 0, wordBreak: 'break-word' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{formatWhen(inv, locale)}</span>
        {!pending && ATTENDEE_KEYS[inv.status] && <> · {t('calendar.invitations.yourAnswer', { answer: t(ATTENDEE_KEYS[inv.status]) })}</>}
        {error && <span role="alert" style={{ display: 'block', color: 'var(--red)' }}>{error}</span>}
      </span>
      <AnswerGroup status={pending ? null : inv.status} busy={busy || !pending} onAnswer={answer} label={t('calendar.reply.question')} />
      <button type="button" onClick={show} style={{
        background: 'none', border: 'none', padding: '3px 2px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
        color: 'var(--accent)',
      }}>{t('calendar.invitations.show')}</button>
    </div>
  );
}
