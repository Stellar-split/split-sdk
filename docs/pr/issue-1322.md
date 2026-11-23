# Add SDK CORS handling (#1322)

## Summary

Adds a transport-agnostic `CorsHandler` so `@stellar-split/sdk` consumers can serve browser requests safely. It
resolves origins (including async allow-list predicates), answers preflight requests, applies credential-safe header
rules, supports custom headers and tracks decisions with bounded, payload-free events.

## What changed

- **New module `src/cors.ts`**
  - `CorsHandler.handle(request)` evaluates a minimal `{ method, origin, headers }` request and returns `{ allowed, isPreflight, headers, reason }` that any HTTP layer can apply.
  - **Origin support**: wildcard (`*`), explicit string, allow-list array, `true` (reflect any origin), or an async predicate function. `isOriginAllowed()` exposes the same rule for reuse.
  - **Preflight support**: detects `OPTIONS` + `Access-Control-Request-Method`, validates the requested method and headers case-insensitively, and emits `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` and `Access-Control-Max-Age`.
  - **Credential safety**: never emits `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true`; the concrete origin is reflected instead and `Vary: Origin` is always set on browser responses.
  - **Custom headers**: configurable `allowedHeaders` and `exposedHeaders` (`Access-Control-Expose-Headers`), plus default SDK trace headers.
  - `stats()` counts requests, preflights, approvals and denials; `eventsTrail()` keeps a bounded record of decisions including denial reasons; `reset()` clears state.
- **Exports** added to `src/index.ts` for the handler and all public types.
- **Tests** in `test/cors.test.ts` (11 tests) covering wildcard/fixed/predicate origins, missing origins, credential safety on actual and preflight requests, custom methods/headers/max-age, unsupported methods/headers, stats and bounded tracking.

## Acceptance criteria addressed

- **CORS works** — browser origins are resolved and correct response headers produced.
- **Preflight handled** — `OPTIONS` requests are validated and answered with method/header/max-age headers.
- **Credentials safe** — wildcard is never combined with credentials; origins are reflected and `Vary: Origin` is set.
- **Headers supported** — configurable allowed and exposed headers with case-insensitive matching.
- **All tests pass** — 11 new Vitest tests.
- **Browser compatible** — no Node-only APIs; the handler works with any request/response adapter.
- **Tracking** — bounded decision events and counters for observability.

## Testing

```bash
npx vitest run test/cors.test.ts
```

`npm run lint` was already failing before this change because of pre-existing syntax errors/merge-conflict markers in unrelated files; this change adds no new TypeScript errors.

## Backwards compatibility

Additive only; no existing module or API is modified.

closes #1322
