import {
  WebAuthnAbortService, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration,
} from '@simplewebauthn/browser';
import { api } from './api.js';

// Passkeys in the browser (routes/passkeys.js on the server).
//
// A passkey is bound to a domain name, the RP ID the server derives from APP_URL. A browser
// refuses one at an IP address (a LAN or staging install opened at https://192.168.x.y), without
// a secure context, or on a host that is not the RP ID or below it. passkeyBlocker says which of
// those applies, so the page can say it instead of failing in the browser.
//
// Signing in with a passkey gives no password, so the secret that unlocks the user's OpenPGP keys
// (utils/pgpSecret.js) is not derived: the unlock prompt asks for the password the first time a
// key is needed in the tab, as after a single sign-on (utils/pgpUnlock.js).

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const isIpHost = host => IPV4.test(host) || host.includes(':') || host.startsWith('[');

// Why passkeys cannot be used in this tab, or null when they can:
//   'ip'         the server's address, or this page's, is an IP address
//   'server'     the server has no usable address (APP_URL unset, or not HTTPS)
//   'browser'    this browser, or this page (not a secure context), cannot use them
//   'otherHost'  this page is not at the server's address (status.rpId)
export function passkeyBlocker(status, here = currentPage()) {
  if (!status) return 'server';
  if (!status.available) return status.reason === 'ip' ? 'ip' : 'server';
  const host = String(here.hostname || '').toLowerCase();
  if (isIpHost(host)) return 'ip';
  if (!here.secure || !here.webauthn) return 'browser';
  const rpId = String(status.rpId || '').toLowerCase();
  if (host !== rpId && !host.endsWith(`.${rpId}`)) return 'otherHost';
  return null;
}

function currentPage() {
  const w = typeof window !== 'undefined' ? window : {};
  return {
    hostname: w.location?.hostname || '',
    secure: w.isSecureContext === true,
    webauthn: browserSupportsWebAuthn(),
  };
}

// The user closed the browser's dialog, or another ceremony replaced this one: nothing to report.
export const isPasskeyCancel = err => err?.name === 'NotAllowedError' || err?.name === 'AbortError' || err?.code === 'ERROR_CEREMONY_ABORTED';

export const autofillAvailable = () => browserSupportsWebAuthnAutofill().catch(() => false);

// Signs in with a passkey and returns the user. `autofill`: offered in the username field's
// suggestions (conditional mediation), and waiting until one is picked.
// `proceed`: asked once the options are in; false gives up before the browser is involved, so a
// late autofill ceremony cannot replace one the user started with the button.
export async function signInWithPasskey({ autofill = false, proceed = () => true, client = api.passkeys, start = startAuthentication } = {}) {
  const { options } = await client.loginOptions();
  if (!proceed()) throw Object.assign(new Error('Passkey sign-in replaced'), { name: 'AbortError' });
  const response = await start({ optionsJSON: options, useBrowserAutofill: autofill });
  const { user } = await client.loginVerify(response);
  return user;
}

// Adds a passkey for the signed-in user, after the password, and returns it.
export async function addPasskey({ password, name, client = api.passkeys, start = startRegistration }) {
  const { options } = await client.registrationOptions(password);
  const response = await start({ optionsJSON: options });
  const { passkey } = await client.registrationVerify(response, name);
  return passkey;
}

export const cancelPasskeyCeremony = () => WebAuthnAbortService.cancelCeremony();
