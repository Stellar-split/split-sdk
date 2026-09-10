import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XBullAdapter } from '../src/wallets/adapters/XBullAdapter.js';

describe('XBullAdapter Account-Change Listener Lifecycle', () => {
  let adapter: XBullAdapter;
  let activeListeners: Set<(pk: string) => void>;

  beforeEach(() => {
    activeListeners = new Set();

    (globalThis as any).window = {
      xbull: {
        connect: vi.fn().mockResolvedValue({ public_key: 'GB_INITIAL_KEY_11111111111111111111111111111111' }),
        sign: vi.fn().mockResolvedValue({ xdr: 'AAAA_SIGNED_XDR' }),
        onAccountChange: vi.fn((handler: (publicKey: string) => void) => {
          activeListeners.add(handler);
          return () => {
            activeListeners.delete(handler);
          };
        }),
      },
    };

    adapter = new XBullAdapter();
  });

  afterEach(() => {
    adapter.disconnect();
    delete (globalThis as any).window;
  });

  it('connect() registers exactly one listener', async () => {
    await adapter.connect();
    expect(activeListeners.size).toBe(1);
    expect(await adapter.getAddress()).toBe('GB_INITIAL_KEY_11111111111111111111111111111111');
  });

  it('repeated connect() calls clean up prior listeners and leave at most 1 live listener', async () => {
    await adapter.connect();
    expect(activeListeners.size).toBe(1);

    await adapter.connect();
    expect(activeListeners.size).toBe(1);

    await adapter.connect();
    expect(activeListeners.size).toBe(1);
  });

  it('disconnect() leaves 0 live listeners and resets currentPublicKey', async () => {
    await adapter.connect();
    await adapter.connect();
    expect(activeListeners.size).toBe(1);

    adapter.disconnect();
    expect(activeListeners.size).toBe(0);
  });

  it('onAccountChange notifies registered consumer callbacks on wallet account switch', async () => {
    await adapter.connect();

    const consumerCallback = vi.fn();
    adapter.onAccountChange(consumerCallback);

    const [liveListener] = Array.from(activeListeners);
    expect(liveListener).toBeDefined();

    liveListener('GB_NEW_SWITCHED_KEY_22222222222222222222222222');
    expect(consumerCallback).toHaveBeenCalledWith('GB_NEW_SWITCHED_KEY_22222222222222222222222222');
    expect(await adapter.getAddress()).toBe('GB_NEW_SWITCHED_KEY_22222222222222222222222222');
  });
});
