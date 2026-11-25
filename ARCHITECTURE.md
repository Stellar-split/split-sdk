# Architecture

This document describes the high-level architecture of the project.

## Overview

The system is organized into a small number of cooperating layers. Each layer has a single responsibility and communicates with adjacent layers through well-defined interfaces.

## Layers

- **Client / SDK** — user-facing entry points that translate calls into HTTP requests.
- **Transport** — performs HTTP requests and returns raw responses.
- **Domain** — business logic and data models.
- **Persistence** — storage and retrieval of data.

## SDK Response Caching

The SDK caches HTTP responses to reduce redundant network traffic and improve latency. The cache is designed to be transparent to callers: reads are served from the cache when a fresh entry exists, and mutations invalidate affected entries.

### Cache System Design

- **Cache key** — derived from the request method, URL (including query string), and any request body that affects the response. Only idempotent, cacheable methods (e.g. `GET`) are cached by default.
- **Cache entry** — stores the response payload, status, relevant headers, the time it was stored, and its TTL.
- **Cache store** — an in-memory map keyed by cache key, with an interface that allows swapping in an external store later.

### Caching in the Request Path

1. Build the cache key for the outgoing request.
2. If the method is cacheable and a fresh entry exists, return the cached response without hitting the network.
3. Otherwise perform the request through the transport.
4. On a successful, cacheable response, store it with the configured TTL.

### TTL and Expiration

- Each entry carries a TTL. A configurable default TTL applies when none is specified per request.
- An entry is considered fresh while `now < storedAt + ttl`; expired entries are treated as misses and evicted lazily on access.

### Invalidation

- **Smart invalidation on mutations** — a successful non-idempotent request (e.g. `POST`, `PUT`, `PATCH`, `DELETE`) invalidates cache entries whose keys share the affected resource path, so subsequent reads observe the mutation.
- **Explicit invalidation** — callers may invalidate a specific key or the entire cache when they know data has changed out of band.

### Tracking

- The cache tracks hits, misses, stores, evictions, and invalidations.
- These counters are exposed for observability so hit rate and cache effectiveness can be monitored.

## Testing

Caching behavior — hits, misses, TTL expiration, and invalidation — is covered by tests to ensure correctness.
