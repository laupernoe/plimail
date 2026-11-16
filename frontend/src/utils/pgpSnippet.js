// The snippet the server stores for an encrypted message (backend services/pgpDetect.js): the armor
// line, in place of ciphertext. Lists show it as "Encrypted message" in the reader's language.
export const PGP_ENCRYPTED_SNIPPET = '-----BEGIN PGP MESSAGE-----';

export function snippetText(snippet, t) {
  return snippet === PGP_ENCRYPTED_SNIPPET ? t('pgp.read.listSnippet') : snippet;
}
