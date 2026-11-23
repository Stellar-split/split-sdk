# Implement SDK token refresh strategy (#1321)

## Summary

Adds `TokenRefreshManager`, a reusable authentication-token lifecycle manager. It refreshes JWTs shortly before
expiry, retries with exponential backoff, supports a fallback token source, coalesces concurrent callers, and reports
refresh activity through bounded tracking — without ever exposing tokens in logs or events.

## What changed

- **New module `src/tokenRefresh.ts`**
  - `decodeTokenExpiry()` reads the `exp` claim of a JWT (base64url safe) without verifying the signature; opaque tokens are handled by refreshing proactively.
  - `setToken()` installs a token and arms a **preemptive timer** based on `refreshBufferMs` (default 60 s), so refreshes happen before expiry rather than after a failure.
  - `getToken()` returns the cached token when valid, triggers a refresh when expiring/expired, and **queues concurrent callers** into one refresh cycle (`queued` counter).
  - `refresh()` performs up to `maxRetries` attempts with **exponential backoff and optional jitter**, emits typed failure events, and supports a static or async `fallbackToken` supplier when all attempts fail.
  - Supports refresh-token rotation from the endpoint response, custom headers, an injectable `fetch` and clock, and `expiresIn` based expiry.
  - `onRefreshed()` / `onRefreshFailed()` subscriptions return unsubscribe functions; `stats()`, `refreshedEvents()` and `failedEvents()` expose bounded, secret-free tracking.
  - `dispose()` clears timers, aborts in-flight requests via `AbortController`, rejects queued callers and cancels pending refreshes.
- **Exports** added to `src/index.ts` for the manager, error, helper and public types.
- **Tests** in `test/tokenRefresh.test.ts` (9 tests) cover expiry decoding, preemptive refresh, scheduled refresh, retry/backoff tracking, fallback, typed failure, concurrency coalescing, bounded tracking and disposal.

## Acceptance criteria addressed

- **Refresh works** — expired/near-expiry tokens are exchanged through the configured endpoint.
- **Timing optimal** — proactive scheduling plus jittered exponential backoff avoids thundering-herd retries.
- **Fallback functional** — a configurable token source is used when all attempts fail; a typed `TokenRefreshError` is thrown when none is configured.
- **Tracking complete** — success/failure events and counters are bounded and contain no token values.
- **All tests pass** — 9 new tests with injected clock/fetch and fake timers.
- **No auth failures** — concurrent callers share one cycle, refresh-token rotation is honoured, and disposal releases waiters cleanly.

## Testing

```bash
npx vitest run test/tokenRefresh.test.ts
```

Note: `npm run lint` was already failing before this change due to pre-existing syntax errors/merge-conflict markers in unrelated repository files; no new TypeScript errors are introduced here.

## Backwards compatibility

Additive only; no existing module or API is modified.

closes #1321
