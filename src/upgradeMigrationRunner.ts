import type { UpgradeEvent } from "./types.js";
import type { SimpleCache } from "./cache.js";

export type MigrateFn<T> = (entries: Map<string, T>) => Map<string, T>;

interface Migration<T> {
  fromVersion: string;
  toVersion: string;
  migrate: MigrateFn<T>;
}

const migrations: Migration<unknown>[] = [];

/**
 * Register a migration function to run when an upgrade from `fromVersion` to
 * `toVersion` is detected. Multiple migrations are run in registration order.
 */
export function registerUpgradeMigration<T>(
  fromVersion: string,
  toVersion: string,
  migrateFn: MigrateFn<T>
): void {
  migrations.push({ fromVersion, toVersion, migrate: migrateFn as MigrateFn<unknown> });
}

/** Remove all registered migrations (useful in tests). */
export function clearUpgradeMigrations(): void {
  migrations.length = 0;
}

/**
 * Build an UpgradeEvent callback that runs registered migrations against the
 * provided cache. Entries for unknown versions are invalidated.
 */
export function makeMigrationCallback<T>(
  cache: SimpleCache<T>,
  getCurrentEntries: () => Map<string, T>,
  replaceEntries: (next: Map<string, T>) => void
): (event: UpgradeEvent) => void {
  return (event: UpgradeEvent) => {
    const matching = migrations.filter(
      (m) => m.fromVersion === event.previousHash && m.toVersion === event.newHash
    ) as Migration<T>[];

    if (matching.length === 0) {
      // Unknown version transition — invalidate all cached state
      cache.clear();
      return;
    }

    let entries = getCurrentEntries();
    for (const m of matching) {
      entries = m.migrate(entries);
    }
    replaceEntries(entries);
  };
}
