import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatWhen } from '../../utils/calendarDates.js';
import { ATTENDEE_KEYS } from './calendarEvents.js';
import { answerError, answerInvitation } from './invitations.js';
import { AnswerGroup, Btn, ErrorBox, Icon, IconBtn, Modal } from './calendarUi.jsx';
import { HIT, ICON_SMALL } from '../../utils/uiSizes.js';

const WIDTH = 380;

function Line({ icon, children, color = 'var(--text-secondary)' }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45, color, minWidth: 0 }}>
      <Icon name={icon} size={13} style={{ color: 'var(--text-tertiary)', marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

// What the server said beside a sent answer, as a line under the invitation's title.
function sentNotice(res, t) {
  if (res?.calendarError) return t('calendar.invitations.calendarFailed', { message: res.calendarError });
  if (res?.inviteError) return t('calendar.errors.inviteFailed', { message: res.inviteError });
  if (res?.noCalendar) return t('calendar.invitations.noCalendar');
  return null;
}

function Invitation({ inv, locale, meta, onAnswered, onOpenMail, onShow }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const organizer = inv.organizer?.name || inv.organizer?.email || '';
  const conflicts = inv.conflicts || [];

  const answer = async (status) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await answerInvitation(inv, status, meta);
      onAnswered?.(inv, status, sentNotice(res, t));
    } catch (err) {
      setError(answerError(err, t));
      setBusy(false);
    }
  };

  return (
    <li style={{ listStyle: 'none', padding: 12, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <h3 style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
          {inv.summary || t('common.noSubject')}
        </h3>
        {inv.isRecurring && <Icon name="repeat" size={12} style={{ color: 'var(--text-tertiary)' }} />}
      </div>
      <Line icon="clock">{formatWhen(inv, locale)}</Line>
      {inv.location && <Line icon="pin">{inv.location}</Line>}
      {organizer && (
        <Line icon="users">
          {t('calendar.invitations.from', { name: organizer })}
          {inv.organizer?.name && inv.organizer?.email && <span style={{ color: 'var(--text-tertiary)' }}> {inv.organizer.email}</span>}
        </Line>
      )}
      {inv.invitedAs && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', paddingLeft: 21, wordBreak: 'break-word' }}>
          {t('calendar.invitations.invitedAs', { email: inv.invitedAs })}{inv.accountName ? ` · ${inv.accountName}` : ''}
        </div>
      )}
      {conflicts.length > 0 && (
        <Line icon="alert" color="var(--amber, #f59e42)">
          {conflicts.length === 1
            ? t('calendar.invitations.conflict', { title: conflicts[0].summary || t('common.noSubject') })
            : t('calendar.invitations.conflictMore', { title: conflicts[0].summary || t('common.noSubject'), n: conflicts.length - 1 })}
        </Line>
      )}
      {error && <ErrorBox style={{ padding: '8px 10px', fontSize: 12.5 }}>{error}</ErrorBox>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        <AnswerGroup status={null} busy={busy} onAnswer={answer} label={t('calendar.reply.question')} />
        <span style={{ flex: 1 }} />
        {onShow && <IconBtn label={t('calendar.invitations.show')} icon="calendar" onClick={() => onShow(inv)} size={30} iconSize={ICON_SMALL} />}
        {onOpenMail && inv.messageId && <IconBtn label={t('calendar.invitations.openMail')} icon="mail" onClick={() => onOpenMail(inv)} size={30} iconSize={ICON_SMALL} />}
      </div>
    </li>
  );
}

function Contents({ data, error, locale, meta, onRetry, onAnswered, onOpenMail, onShow }) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState(null);
  if (!data) {
    return error
      ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <ErrorBox>{t('calendar.invitations.loadFailed', { message: error })}</ErrorBox>
          <Btn onClick={onRetry}>{t('common.retry')}</Btn>
        </div>
      )
      : <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>;
  }
  const { invitations, answered } = data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {notice && (
        <div role="status" style={{ fontSize: 12.5, lineHeight: 1.45, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{notice}</div>
      )}
      {invitations.length === 0
        ? <p style={{ margin: 0, padding: '14px 0', textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)' }}>{t('calendar.invitations.empty')}</p>
        : (
          <ul aria-label={t('calendar.invitations.title')} style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {invitations.map(inv => (
              <Invitation key={`${inv.uid}\n${inv.recurrenceId || ''}`} inv={inv} locale={locale} meta={meta}
                onOpenMail={onOpenMail} onShow={onShow}
                onAnswered={(i, status, text) => { setNotice(text); onAnswered?.(i, status); }} />
            ))}
          </ul>
        )}
      {answered.length > 0 && (
        <section aria-label={t('calendar.invitations.answered')}>
          <h4 style={{ margin: '6px 0 6px', fontSize: 12, fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('calendar.invitations.answered')}</h4>
          <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {answered.map(inv => (
              <li key={`${inv.uid}\n${inv.recurrenceId || ''}`} style={{ listStyle: 'none', display: 'flex', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)', padding: '3px 0' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.summary || t('common.noSubject')}</span>
                <span style={{ flexShrink: 0, color: 'var(--text-tertiary)' }}>{ATTENDEE_KEYS[inv.status] ? t(ATTENDEE_KEYS[inv.status]) : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// The calendar's inbox: invitations waiting for an answer, under the toolbar's button on a
// desktop, as a sheet on a phone.
export default function InvitationsPanel({ rect, isMobile, onClose, ...rest }) {
  const { t } = useTranslation();
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    if (isMobile) return;
    const vw = window.innerWidth;
    const left = Math.max(8, Math.min(vw - WIDTH - 8, (rect?.right ?? vw - 8) - WIDTH));
    setPos({ left, top: (rect?.bottom ?? 56) + 6, ready: true });
  }, [isMobile, rect]);

  useEffect(() => {
    if (isMobile || !ref.current) return undefined;
    const trigger = document.activeElement;
    ref.current.focus({ preventScroll: true });
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('[data-invitations-button]')) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      if (trigger && trigger !== document.body && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [isMobile, onClose]);

  if (isMobile) {
    return <Modal mobile title={t('calendar.invitations.title')} onClose={onClose}><Contents {...rest} /></Modal>;
  }
  return (
    <div ref={ref} role="dialog" tabIndex={-1} aria-label={t('calendar.invitations.title')} style={{
      outline: 'none', position: 'fixed', left: pos.left, top: pos.top, width: WIDTH, maxHeight: `calc(100vh - ${pos.top + 12}px)`,
      overflow: 'hidden auto', zIndex: 8000, padding: '12px 12px 14px', boxSizing: 'border-box', borderRadius: 12,
      background: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-popover)',
      visibility: pos.ready ? 'visible' : 'hidden',
      animation: pos.ready ? 'popover-in var(--motion-fast) var(--ease-emphasized) both' : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px 4px' }}>
        <h2 style={{ flex: 1, margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{t('calendar.invitations.title')}</h2>
        <IconBtn label={t('common.dismiss')} icon="close" onClick={onClose} size={HIT - 4} iconSize={ICON_SMALL} />
      </div>
      <Contents {...rest} />
    </div>
  );
}
