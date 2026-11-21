# Debug logging

`SdkLogger` remains silent by default, so importing the SDK has no console or
network logging impact in production. Enable diagnostics explicitly with a
level, `logger: true`, or `debug: true` on `StellarSplitClient`.

```ts
import { LogLevel, SdkLogger } from "@stellar-split/sdk";

const logger = new SdkLogger({
  level: LogLevel.DEBUG,
  filter: (entry) => entry.context?.component !== "noisy-poller",
});

logger.debug("RPC request started", { component: "rpc", requestId: "req-42" });
console.log(logger.getStats());
```

`filter` receives already-redacted structured entries and can suppress a log
without changing the active level. `getStats()` reports counts only; it never
stores log payloads. `resetStats()` starts a fresh observation window.
