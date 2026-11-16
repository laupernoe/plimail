import { describe, it, expect, vi } from 'vitest';
import { createClientAddressWatch } from './clientAddressWatch.js';

const run = (watch, ip, { encrypted = false } = {}) => {
  const next = vi.fn();
  watch({ ip, socket: { encrypted } }, {}, next);
  expect(next).toHaveBeenCalledOnce();
};

describe('createClientAddressWatch', () => {
  it('warns once when every request seems to come from one private address', () => {
    const warn = vi.fn();
    const watch = createClientAddressWatch({ sample: 3, warn, hops: 1 });
    for (let i = 0; i < 10; i++) run(watch, '172.18.0.4');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/172\.18\.0\.4.*TRUST_PROXY_HOPS.*now 1/);
  });

  it('warns about loopback, as a tunnel on the same host would be', () => {
    const warn = vi.fn();
    const watch = createClientAddressWatch({ sample: 2, warn });
    run(watch, '::ffff:127.0.0.1');
    run(watch, '::ffff:127.0.0.1');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('stays quiet once two clients are told apart, or a client has a public address', () => {
    const warn = vi.fn();
    const mixed = createClientAddressWatch({ sample: 3, warn });
    for (const ip of ['192.168.1.10', '192.168.1.11', '192.168.1.10', '192.168.1.10', '192.168.1.10']) run(mixed, ip);
    const real = createClientAddressWatch({ sample: 2, warn });
    for (let i = 0; i < 4; i++) run(real, '203.0.113.7');
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves out the built-in HTTPS listener, which browsers reach directly', () => {
    const warn = vi.fn();
    const watch = createClientAddressWatch({ sample: 2, warn });
    for (let i = 0; i < 4; i++) run(watch, '192.168.1.10', { encrypted: true });
    expect(warn).not.toHaveBeenCalled();
  });
});
