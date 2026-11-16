// What every password Plimail stores has to meet: registration, a reset link, an admin setting one
// and a user changing their own. bcrypt ignores everything past 72 bytes, so a longer password
// would not mean what it says: anything that matches its first 72 bytes would sign in too.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

// The error to answer with, or null when the password will do.
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return `Password must be at most ${PASSWORD_MAX_BYTES} bytes`;
  }
  return null;
}
