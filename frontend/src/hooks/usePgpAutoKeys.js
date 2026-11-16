import { useEffect, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { ensureAutoKeys, senderAddresses } from '../utils/pgpKeys.js';
import { loadOwnKeys, ownKeysChanged } from '../utils/pgpOwnKeys.js';
import { keySecret, subscribeKeySecret } from '../utils/pgpSecret.js';

// Every address the user sends from gets an OpenPGP key without being asked, in the background,
// once the tab has the secret from the Plimail password (signing in gives it; utils/pgpSecret.js).
// Nothing waits for it and nothing asks: a tab without the secret makes none, and the next one
// signed in does. ensureAutoKeys makes each address's key once, however often this runs.
export default function usePgpAutoKeys() {
  const userId = useStore(s => s.user?.id);
  const accounts = useStore(s => s.accounts);
  const accountsReady = useStore(s => s.accountsReady);
  const [secretVersion, setSecretVersion] = useState(0);
  useEffect(() => subscribeKeySecret(() => setSecretVersion(v => v + 1)), []);

  useEffect(() => {
    if (!userId || !accountsReady || !globalThis.crypto?.subtle) return undefined;
    const secret = keySecret(userId);
    const addresses = senderAddresses(accounts);
    if (!secret || !addresses.length) return undefined;
    let live = true;
    (async () => {
      let ownKeys;
      try { ownKeys = await loadOwnKeys(); } catch { return; }
      if (!live || useStore.getState().user?.id !== userId) return;
      const { changed } = await ensureAutoKeys({ userId, addresses, ownKeys, secret, addKey: api.pgp.addKey });
      if (changed) ownKeysChanged();
    })();
    return () => { live = false; };
  }, [userId, accounts, accountsReady, secretVersion]);
}
