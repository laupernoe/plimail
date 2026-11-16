import { useEffect, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { checkLoginKeys, ensureAutoKeys, senderAddresses } from '../utils/pgpKeys.js';
import { loadOwnKeys, ownKeysChanged } from '../utils/pgpOwnKeys.js';
import { keySecretEntry, subscribeKeySecret } from '../utils/pgpSecret.js';

// Every address the user sends from gets an OpenPGP key without being asked, in the background,
// once the tab has the secret from the Plimail password (signing in gives it; utils/pgpSecret.js).
// Nothing waits for it and nothing asks: a tab without the secret makes none, and the next one
// signed in does. ensureAutoKeys makes each address's key once, however often this runs.
//
// With the current password's secret it also checks the keys protected by the password: one it no
// longer opens (the password was reset) is marked stale, so the server stops publishing it and
// Settings and the composer say so (checkLoginKeys). "Create and publish my keys automatically"
// off (pgpAutoKeys): no key is made.
export default function usePgpAutoKeys() {
  const userId = useStore(s => s.user?.id);
  const accounts = useStore(s => s.accounts);
  const accountsReady = useStore(s => s.accountsReady);
  const autoKeys = useStore(s => s.pgpAutoKeys);
  const [secretVersion, setSecretVersion] = useState(0);
  useEffect(() => subscribeKeySecret(() => setSecretVersion(v => v + 1)), []);

  useEffect(() => {
    if (!userId || !accountsReady || !globalThis.crypto?.subtle) return undefined;
    const entry = keySecretEntry(userId);
    const secret = entry?.secret;
    const addresses = senderAddresses(accounts);
    if (!secret) return undefined;
    let live = true;
    (async () => {
      let ownKeys;
      try { ownKeys = await loadOwnKeys(); } catch { return; }
      if (!live || useStore.getState().user?.id !== userId) return;
      const marked = await checkLoginKeys({ keys: ownKeys, entry, markStale: (id, stale) => api.pgp.markStale(id, stale) }).catch(() => false);
      if (!live) return;
      const { changed } = autoKeys && addresses.length
        ? await ensureAutoKeys({ userId, addresses, ownKeys, secret, addKey: api.pgp.addKey })
        : { changed: false };
      if (marked || changed) ownKeysChanged();
    })();
    return () => { live = false; };
  }, [userId, accounts, accountsReady, secretVersion, autoKeys]);
}
