# Performance Tuning

This guide covers tuning knobs that affect SDK throughput and latency.

## Resource Pooling

The SDK reuses expensive resources (connections, buffers, clients) through a
pool subsystem. Pooling maximizes reuse by handing out idle resources before
creating new ones, and by returning resources to the pool on release.

### Pool lifecycle

Each pooled resource moves through a well-defined lifecycle:

1. **Create** — the pool calls the configured factory to build a new resource
   when no idle resource is available and the pool is below its maximum size.
2. **Validate** — before an idle resource is reused, the optional validator is
   invoked. Resources that fail validation are destroyed and replaced.
3. **Acquire / Release** — callers acquire a resource, use it, then release it
   back to the pool. Released resources become idle and eligible for reuse.
4. **Destroy** — resources are destroyed when they fail validation, exceed the
   idle timeout, or when the pool is drained.
5. **Drain / Close** — draining stops new acquisitions and destroys all idle
   resources; closing additionally waits for in-use resources to be released.

### Sizing

Pool size is configurable per pool:

| Option            | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `min`             | Minimum number of resources kept warm in the pool.                 |
| `max`             | Maximum number of resources (idle + in-use) the pool will create.  |
| `idleTimeout`     | How long an idle resource may sit before it is destroyed.          |
| `acquireTimeout`  | How long an acquire call waits for a resource before failing.      |

Guidance:

- Set `min` to the steady-state concurrency you expect so common requests are
  served from warm resources without a create/validate round trip.
- Set `max` to a value your downstream dependency can tolerate; the pool will
  never exceed it, and acquires beyond it wait up to `acquireTimeout`.
- Keep `idleTimeout` short enough to shed resources during quiet periods, but
  long enough to avoid churn during bursty traffic.
- Tune `acquireTimeout` so callers fail fast instead of queueing indefinitely
  when the pool is saturated.

### Tracking

Pools expose counters for observability: total created, currently idle,
currently in-use, waiting acquirers, and destroyed. Use these to confirm reuse
is high (few creates relative to acquires) and to spot saturation (growing
waiting count) before it becomes a latency problem.

### Tuning checklist

- [ ] `min` matches expected steady-state concurrency.
- [ ] `max` respects downstream capacity limits.
- [ ] `idleTimeout` balances churn against resource retention.
- [ ] `acquireTimeout` is set to fail fast under saturation.
- [ ] Pool counters are monitored for reuse ratio and waiting acquirers.
