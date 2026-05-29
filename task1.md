#19 Build payment retry mechanism
Repo Avatar
Stellar-split/split-sdk
Label: complexity: high
Points: 200

Description
Network errors during pay() cause the call to fail with no recovery. This issue adds automatic retry with exponential backoff — failed pay() calls retry up to 3 times with 1s, 2s, 4s delays before throwing, handling transient RPC errors transparently.

Technical Context
Involves src/client.ts and a new src/retry.ts. Define withRetry(fn: () => Promise, maxAttempts: number, baseDelayMs: number): Promise. Wrap the _submitTx call in pay() with withRetry. Only retry on network/timeout errors, not on contract logic errors.

Acceptance Criteria
 pay() retries up to 3 times on network errors
 Delays follow exponential backoff: 1s, 2s, 4s
 Contract logic errors (e.g. DeadlinePassedError) are not retried
 maxRetries configurable in StellarSplitClientConfig
 Test mocks 2 failures then success and verifies final result returned
 All existing tests pass
 TypeScript strict mode — zero any types