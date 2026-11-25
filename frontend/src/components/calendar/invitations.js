import { api } from '../../utils/api.js';
import { useStore } from '../../store/index.js';

// Invitations waiting for an answer: the shared list in the store, and answering one from
// wherever it is shown (the calendar's inbox, the bar above the mail it came in).

export const INVITATIONS_CHANGED = 'mailflow:invitations-changed';

export const pendingCount = data => data?.invitations?.length || 0;

const sameInvite = (a, b) => a.uid === b.uid && (a.recurrenceId || null) === (b.recurrenceId || null);

// The lists once `inv` has its answer: out of the waiting ones, first among the answered.
export function afterAnswer(data, inv, status, now = new Date()) {
  if (!data) return data;
  return {
    invitations: data.invitations.filter(i => !sameInvite(i, inv)),
    answered: [{ ...inv, conflicts: [], status, answeredAt: now.toISOString() }, ...data.answered.filter(i => !sameInvite(i, inv))],
  };
}

// One request per invitation at a time: a second click while the first is out gets the same answer.
const inFlight = new Map();
export function answerInvitation(inv, status, meta) {
  const key = `${inv.uid}\n${inv.recurrenceId || ''}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const request = api.calendar.replyInvitation(inv, status, meta)
    .then((res) => {
      const { invitations, setInvitations } = useStore.getState();
      setInvitations(afterAnswer(invitations, inv, status));
      window.dispatchEvent(new CustomEvent(INVITATIONS_CHANGED, { detail: { uid: inv.uid, status } }));
      return res;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

// Why an answer did not go through, as the user is told it.
export function answerError(err, t) {
  if (err?.code === 'no_sender') return t('calendar.invitations.noSender');
  if (err?.code === 'gone' || err?.status === 404) return t('calendar.invitations.gone');
  return t('calendar.invitations.failed', { message: err?.message || '' });
}
