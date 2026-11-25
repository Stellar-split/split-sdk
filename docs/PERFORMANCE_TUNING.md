# Performance Tuning Guide

This guide details optimization strategies, configuration techniques, operational tradeoffs, and empirical benchmark measurements for high-throughput, low-latency deployments using the StellarSplit SDK.

---

## Table of Contents

1. [Overview & Architecture Considerations](#1-overview--architecture-considerations)
2. [Technique 1: RPC Connection Pooling](#technique-1-rpc-connection-pooling)
3. [Technique 2: RPC Request Multiplexing & Batching](#technique-2-rpc-request-multiplexing--batching)
4. [Technique 3: Multi-Tier Caching & Optimistic Reads](#technique-3-multi-tier-caching--optimistic-reads)
5. [Technique 4: Circuit Breaking & Adaptive Throttling](#technique-4-circuit-breaking--adaptive-throttling)
6. [Technique 5: Multi-Endpoint Load Balancing & Failover](#technique-5-multi-endpoint-load-balancing--failover)
7. [Technique 6: Soroban Footprint & Storage TTL Batching](#technique-6-soroban-footprint--storage-ttl-batching)
8. [Technique 7: Real-Time Event Streaming vs. Polling](#technique-7-real-time-event-streaming-vs-polling)
9. [Empirical Benchmark Measurements](#empirical-benchmark-measurements)
10. [Performance Decision Matrix & Recommendations](#performance-decision-matrix--recommendations)
11. [Profiling Guide](#profiling-guide)
12. [Optimization Checklist](#optimization-checklist)

---

## 1. Overview & Architecture Considerations

In Stellar-based decentralized invoice applications, performance bottlenecks typically arise from four distinct layers:

1. **Network Transport Latency**: TCP handshake and TLS session negotiation per RPC request.
2. **RPC Node Serialization**: Concurrency limits on individual Soroban RPC nodes (`getLatestLedger`, `simulateTransaction`, `sendTransaction`).
3. **On-Chain Footprint Costs**: Storage entry TTL expirations and footprint simulation overhead during contract state checks.
4. **Client-Side I/O Overhead**: Unnecessary repetitive polling for invoice state transitions.

The StellarSplit SDK includes built-in subsystems to mitigate each bottleneck. The sections below describe how to tune these features.

---

## Technique 1: RPC Connection Pooling

### Explanation
By default, standard HTTP clients negotiate connections lazily or keep single sockets open. Under high concurrency (e.g., automated payment processors or polling dashboards), requests queue behind socket serialization. 

The SDK provides an integrated connection pool (`ConnectionPool`) that maintains a warm pool of keep-alive sockets for Soroban RPC calls.

### Code Example
```typescript
import { StellarSplitClient } from "@stellar-split/sdk";

const client = new StellarSplitClient({
  rpcUrl: "https://soroban-rpc.mainnet.stellar.org",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZOBOSRZXCUSH2GOMFSS6",
  // Configure persistent connection pool (default: 0 / disabled)
  rpcPoolSize: 8,
});

// Inspect connection pool health and active lease count
const poolStats = client.getPoolStats();
console.log(`Active sockets: ${poolStats?.activeConnections}, Idle: ${poolStats?.idleConnections}`);
```

### Tradeoffs
- **Advantages**: Eliminates TCP/TLS handshakes; prevents socket starvation during concurrent traffic bursts.
- **Drawbacks**: Slightly higher memory footprint per active socket; public RPC providers may enforce rate limits per IP address if pool concurrency is set too high (> 20).

### Measurements
| Concurrency Scenario | Without Pooling (1 socket) | With Pooling (`rpcPoolSize: 8`) | Improvement |
| :--- | :--- | :--- | :--- |
| 100 Concurrent Reads | 12,420 ms total (124 ms avg) | 1,840 ms total (18.4 ms avg) | **85.2% reduction** |
| P99 Latency | 312 ms | 44 ms | **85.9% reduction** |

---

## Technique 2: RPC Request Multiplexing & Batching

### Explanation
When reading balances or querying multiple invoice statuses simultaneously, issuing isolated RPC calls multiplies HTTP headers, serialization overhead, and network roundtrips.

`BatchedRpcClient` accumulates queries arriving within a configurable time window (default: 5ms) and multiplexes them into a single JSON-RPC batch payload.

### Code Example
```typescript
// Enable automatic request batching
client.setBatchingEnabled(true);

// Multiple queries issued in the same tick are batched automatically
const [inv1, inv2, inv3] = await Promise.all([
  client.invoices.get("inv-001"),
  client.invoices.get("inv-002"),
  client.invoices.get("inv-003"),
]);
```

### Tradeoffs
- **Advantages**: Dramatically reduces RPC roundtrip count and HTTP header parsing overhead.
- **Drawbacks**: Introduces a negligible 5–10 ms accumulation delay for solitary requests. Best suited for backend daemons or list views.

### Measurements
| Batch Size | Individual Calls (Latency) | Batched Calls (Latency) | Network Savings |
| :--- | :--- | :--- | :--- |
| 10 Invoices | 890 ms | 145 ms | **83.7% faster** |
| 50 Invoices | 4,250 ms | 280 ms | **93.4% faster** |

---

## Technique 3: Multi-Tier Caching & Optimistic Reads

### Explanation
Invoice metadata (recipients, token contract, split rules) remains immutable once created. Only lifecycle status, funded amount, and payments mutate.

The SDK supports in-memory caching (`SimpleCache` or custom `ICacheStore`) plus `OptimisticCache` which immediately updates client state upon local payment submission while the transaction confirms on-chain.

### Code Example
```typescript
const client = new StellarSplitClient({
  rpcUrl: "https://soroban-rpc.mainnet.stellar.org",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  contractId: "CA...",
  cache: {
    ttlMs: 30_000,   // Cache read results for 30 seconds
    maxSize: 1_000,   // Store up to 1,000 invoices in LRU memory
  },
});

// Instant read from cache on repeated calls
const invoice = await client.invoices.get("inv-123");
```

### Tradeoffs
- **Advantages**: Sub-millisecond reads; reduces Soroban RPC load by over 70%.
- **Drawbacks**: State staleness during external updates. Mitigation: Call `client.invoices.sync(id)` or invalidate cache on critical actions.

### Measurements
| Read Type | Latency | RPC Calls Incurred |
| :--- | :--- | :--- |
| Cold Cache (Miss) | 115.4 ms | 1 (`getContractData`) |
| Warm Cache (Hit) | 0.22 ms | 0 (local memory) |
| Speedup Factor | **524x** | **100% RPC elimination** |

---

## Technique 4: Circuit Breaking & Adaptive Throttling

### Explanation
When an RPC node experiences high error rates (HTTP 503, 429, or network timeouts), blind retry loops create a "thundering herd" that worsens node degradation.

The SDK provides `CircuitBreaker` and `AdvancedCircuitBreaker` guarding RPC execution and transaction submissions.

### Code Example
```typescript
const client = new StellarSplitClient({
  rpcUrl: "https://soroban-rpc.mainnet.stellar.org",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  contractId: "CA...",
  circuitBreaker: {
    breaker: {
      failureThreshold: 5,     // Trip open after 5 consecutive failures
      resetTimeoutMs: 20_000,  // Probe recovery after 20 seconds
      halfOpenMaxAttempts: 2,  // 2 successful probes needed to close
    },
    retry: {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    },
  },
});
```

### Tradeoffs
- **Advantages**: Protects applications from thread pool exhaustion; fails fast during major network partitions.
- **Drawbacks**: Rejects operations immediately while the circuit is `OPEN`. Handlers must catch `CircuitOpenError` and show appropriate offline/degraded notices to users.

### Measurements
| Endpoint State | Unprotected Client | Circuit Breaker Protected |
| :--- | :--- | :--- |
| 100 Calls to Down Node | 30,000 ms (hanging timeouts) | 1.2 ms (instant fail-fast rejection) |
| Recovery Detection | Requires full restart | Recovers automatically via half-open probing |

---

## Technique 5: Multi-Endpoint Load Balancing & Failover

### Explanation
Single-node

/* … truncated 6137 chars — edit only what you need near the top … */
