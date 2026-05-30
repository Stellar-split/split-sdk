import type { StellarSplitClientConfig } from "./client.js";
import { StellarSplitClient } from "./client.js";

interface Disposable {
  close(): void;
}

interface DisposableWithDispose {
  dispose(): void;
}

function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === "object" &&
    value !== null &&
    "close" in value &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

function isDisposableWithDispose(value: unknown): value is DisposableWithDispose {
  return (
    typeof value === "object" &&
    value !== null &&
    "dispose" in value &&
    typeof (value as { dispose?: unknown }).dispose === "function"
  );
}

export class MultiTenantClient {
  private readonly clients = new Map<string, StellarSplitClient>();
  private readonly clientFactory: (tenantId: string) => StellarSplitClientConfig;

  constructor(clientFactory: (tenantId: string) => StellarSplitClientConfig) {
    this.clientFactory = clientFactory;
  }

  getClient(tenantId: string): StellarSplitClient {
    const existing = this.clients.get(tenantId);
    if (existing) {
      return existing;
    }

    const config = this.clientFactory(tenantId);
    const client = new StellarSplitClient(config);
    this.clients.set(tenantId, client);
    return client;
  }

  evict(tenantId: string): boolean {
    const client = this.clients.get(tenantId);
    if (!client) {
      return false;
    }

    this.clients.delete(tenantId);

    if (isDisposable(client)) {
      client.close();
    } else if (isDisposableWithDispose(client)) {
      client.dispose();
    }

    return true;
  }

  evictAll(): void {
    for (const tenantId of Array.from(this.clients.keys())) {
      this.evict(tenantId);
    }
  }
}
