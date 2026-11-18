/* global URL, console */
// Writes demo/pgpFixtures.js: OpenPGP keys and messages for the demo's fictional people, made once
// and committed (`node demo/gen-pgp-fixtures.mjs` from frontend/). The keys protect nothing real.
import { writeFileSync } from 'node:fs';
import * as openpgp from 'openpgp';

const PASSPHRASE = 'plimail-demo';
const elena = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Elena Varga', email: 'elena@quillpress.example.org' }], format: 'object' });
const maya = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Maya Lindqvist', email: 'maya.lindqvist@example.org' }], passphrase: PASSPHRASE, format: 'object' });

const signedText = await openpgp.sign({
  message: await openpgp.createCleartextMessage({ text: [
    'Hi Maya,',
    '',
    'Here is the reading list for the book club, signed so you know it is really from me:',
    '',
    '  1. The Lighthouse Keeper\'s Almanac',
    '  2. Salt and Silver',
    '  3. A Short History of Small Boats',
    '',
    'We meet on the first Tuesday of the month, at the library cafe.',
    '',
    'Elena',
  ].join('\n') }),
  signingKeys: elena.privateKey,
});

const encryptedText = await openpgp.encrypt({
  message: await openpgp.createMessage({ text: [
    'Hi Maya,',
    '',
    'Thank you for reading the first three chapters. My notes, as promised:',
    '',
    '- Chapter 1 opens too slowly. Start with the storm, not the weather report.',
    '- Chapter 2 is perfect. Do not touch it.',
    '- Chapter 3: the lighthouse keeper needs a name before page 40.',
    '',
    'The publisher wants the full draft by the end of January. Nobody else has seen these',
    'notes, which is why they are encrypted to your key.',
    '',
    'Elena',
  ].join('\n') }),
  encryptionKeys: [maya.publicKey, elena.publicKey],
  signingKeys: elena.privateKey,
});

const info = key => ({ fingerprint: key.getFingerprint(), algorithm: 'curve25519', created: key.getCreationTime().toISOString() });
const out = {
  passphrase: PASSPHRASE,
  elenaPublic: elena.publicKey.armor(),
  elena: info(elena.publicKey),
  mayaPublic: maya.publicKey.armor(),
  mayaPrivate: maya.privateKey.armor(),
  maya: info(maya.publicKey),
  signedText,
  encryptedText,
};
writeFileSync(new URL('./pgpFixtures.js', import.meta.url),
  `// Made by gen-pgp-fixtures.mjs: fictional keys and messages for the demo, not to be used for anything else.\nexport const PGP = ${JSON.stringify(out, null, 2)};\n`);
console.log('written');
