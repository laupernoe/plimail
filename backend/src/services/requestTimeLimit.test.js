import { describe, expect, it } from 'vitest';
import { liftRequestTimeout } from './requestTimeLimit.js';

describe('liftRequestTimeout', () => {
  it('lifts the limit until the last overlapping upload ends, then puts it back', () => {
    const server = { requestTimeout: 300000 };
    const first = liftRequestTimeout(server);
    const second = liftRequestTimeout(server);
    expect(server.requestTimeout).toBe(0);
    first();
    first();
    expect(server.requestTimeout).toBe(0);
    second();
    expect(server.requestTimeout).toBe(300000);
  });

  it('does nothing without a server', () => {
    expect(() => liftRequestTimeout(undefined)()).not.toThrow();
  });
});
