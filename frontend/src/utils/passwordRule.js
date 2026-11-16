// The server's rule for a new password (backend/src/utils/passwordPolicy.js): 8 characters at
// least, and at most the 72 bytes bcrypt reads. Checked here only to say so before the request.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export function passwordFitsRule(password) {
  return typeof password === 'string'
    && password.length >= PASSWORD_MIN_LENGTH
    && new TextEncoder().encode(password).length <= PASSWORD_MAX_BYTES;
}
