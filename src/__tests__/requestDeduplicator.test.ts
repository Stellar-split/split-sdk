import { RequestDeduplicator, requestKey } from '../requestDeduplicator';

describe('requestKey', () => {
  it('produces stable keys regardless of param order', () => {
    const a = requestKey({ method: 'get', path: '/users', params: { b: 2, a: 1 } });
    const b = requestKey({ method: 'GET', path: '/users', params: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it('distinguishes different paths', () => {
    expect(requestKey({ method: 'GET', path: '/a' })).not.toBe(
      requestKey({ method: 'GET', path: '/b' }),
    );
  });
});

describe('RequestDeduplicator', () => {
  it('coalesces identical concurrent requests', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const fn = () => {
      calls += 1;
      return new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 10));
    };

    const results = await Promise.all([
      dedup.run({ method: 'GET', path: '/x' }, fn),
      dedup.run({ method: 'GET', path: '/x' }, fn),
      dedup.run({ method: 'GET', path: '/x' }, fn),
    ]);

    expect(results).toEqual(['ok', 'ok', 'ok']);
    expect(calls).toBe(1);
    expect(dedup.getStats().deduped).toBe(2);
    expect(dedup.getStats().executed).toBe(1);
  });

  it('does not coalesce distinct requests', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const fn = () => {
      calls += 1;
      return Promise.resolve(calls);
    };

    await Promise.all([
      dedup.run({ method: 'GET', path: '/a' }, fn),
      dedup.run({ method: 'GET', path: '/b' }, fn),
    ]);

    expect(calls).toBe(2);
  });

  it('caches resolved responses within the TTL', async () => {
    let clock = 0;
    const dedup = new RequestDeduplicator({ cacheTtlMs: 100, now: () => clock });
    let calls = 0;
    const fn = () => {
      calls += 1;
      return Promise.resolve(calls);
    };

    expect(await dedup.run({ method: 'GET', path: '/c' }, fn)).toBe(1);
    clock = 50;
    expect(await dedup.run({ method: 'GET', path: '/c' }, fn)).toBe(1);
    expect(calls).toBe(1);
    expect(dedup.getStats().cacheHits).toBe(1);

    clock = 200;
    expect(await dedup.run({ method: 'GET', path: '/c' }, fn)).toBe(2);
    expect(calls).toBe(2);
  });

  it('enforces timeouts', async () => {
    const dedup = new RequestDeduplicator({ timeoutMs: 10 });
    const fn = () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 100));

    await expect(dedup.run({ method: 'GET', path: '/slow' }, fn)).rejects.toThrow(/timed out/);
    expect(dedup.getStats().timeouts).toBe(1);
  });

  it('clears in-flight tracking after completion', async () => {
    const dedup = new RequestDeduplicator();
    const fn = () => Promise.resolve('done');

    await dedup.run({ method: 'GET', path: '/d' }, fn);
    await dedup.run({ method: 'GET', path: '/d' }, fn);

    expect(dedup.getStats().executed).toBe(2);
  });
});
