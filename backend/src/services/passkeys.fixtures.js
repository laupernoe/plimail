import crypto from 'crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

// A software authenticator for the passkey tests: an ES256 key pair that answers registration
// and authentication ceremonies as a platform authenticator would, so the tests run the real
// @simplewebauthn/server verification rather than a mock of it. Each answer can be bent (another
// origin, a counter, flags) to produce what an attacker or a cloned key would send.

const b64url = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = data => crypto.createHash('sha256').update(data).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export function softAuthenticator({ rpId = 'mail.example.com', origin = `https://${rpId}`, userHandle = null } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = crypto.randomBytes(32);
  const id = b64url(credentialId);
  let counter = 0;

  const coseKey = () => isoCBOR.encode(new Map([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
    [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
  ]));

  const clientData = (type, challenge, at) => Buffer.from(JSON.stringify({ type, challenge, origin: at, crossOrigin: false }));
  const counterBytes = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

  return {
    id,
    get counter() { return counter; },
    set counter(n) { counter = n; },

    // A RegistrationResponseJSON for `options` (from generateRegistrationOptions).
    register(options, { origin: at = origin, rpId: rp = rpId, userVerified = true } = {}) {
      const flags = FLAG_UP | FLAG_AT | (userVerified ? FLAG_UV : 0);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(rp), Buffer.from([flags]), counterBytes(counter), Buffer.alloc(16), idLength, credentialId, Buffer.from(coseKey()),
      ]);
      const attestationObject = isoCBOR.encode(new Map([
        ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)],
      ]));
      return {
        id, rawId: id, type: 'public-key',
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', options.challenge, at)),
          attestationObject: b64url(attestationObject),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },

    // An AuthenticationResponseJSON for `options` (from generateAuthenticationOptions). The
    // counter goes up by one first unless `counter` says what to send.
    authenticate(options, { origin: at = origin, rpId: rp = rpId, counter: sent, userVerified = true, handle = userHandle } = {}) {
      if (sent === undefined) counter += 1;
      const value = sent === undefined ? counter : sent;
      const authData = Buffer.concat([sha256(rp), Buffer.from([FLAG_UP | (userVerified ? FLAG_UV : 0)]), counterBytes(value)]);
      const clientDataJSON = clientData('webauthn.get', options.challenge, at);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      return {
        id, rawId: id, type: 'public-key',
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
          ...(handle ? { userHandle: handle } : {}),
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}
