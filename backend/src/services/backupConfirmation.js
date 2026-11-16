// A backup holds every account's credentials, and a restore replaces the whole installation, so
// an admin's browser left unlocked must not be enough for either. The admin confirms who they are
// first, the way an API token is confirmed (apiTokenReauth.js: password, two-factor code or a
// fresh single sign-on), and the confirmation lasts a few minutes in this session only.
export const BACKUP_CONFIRMATION_MS = 5 * 60 * 1000;

export function recordBackupConfirmation(session, userId, now = Date.now()) {
  session.backupConfirmation = { userId, until: now + BACKUP_CONFIRMATION_MS };
  return new Date(session.backupConfirmation.until);
}

export function backupConfirmed(session, now = Date.now()) {
  const confirmation = session?.backupConfirmation;
  return Boolean(confirmation) && confirmation.userId === session.userId && confirmation.until > now;
}
