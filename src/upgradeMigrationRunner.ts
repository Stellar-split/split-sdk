import type { UpgradeEvent } from "./types.js";
import type { SimpleCache } from "./cache.js";

export type MigrateFn<T> = (entries: Map<string, T>) => Map<string, T>;

interface Migration<T> {
  fromVersion: string;
  toVersion: string;
  migrate: MigrateFn<T>;
}

const migrations: Migration<unknown>[] = [];

/** Progress state for a single migration step. */
export interface MigrationStepProgress {
  fromVersion: string;
  toVersion: string;
  completed: boolean;
}

/** Progress report for a version transition. */
export interface MigrationProgress {
  fromVersion: string;
  toVersion: string;
  steps: MigrationStepProgress[];
  completed: boolean;
}

const completedSteps = new Set<string>();

function stepKey(fromVersion: string, toVersion: string): string {
  return `${fromVersion}->${toVersion}`;
}

/**
 * Report which registered migrations apply to the `fromVersion` -> `toVersion`
 * transition and whether each step has completed. Steps are returned in
 * registration order.
 */
export function getMigrationProgress(
  fromVersion: string,
  toVersion: string
): MigrationProgress {
  const steps: MigrationStepProgress[] = migrations
    .filter((m) => m.fromVersion === fromVersion && m.toVersion === toVersion)
    .map((m) => ({
      fromVersion: m.fromVersion,
      toVersion: m.toVersion,
      completed: completedSteps.has(stepKey(m.fromVersion, m.toVersion)),
    }));

  return {
    fromVersion,
    toVersion,
    steps,
    completed: steps.length > 0 && steps.every((s) => s.completed),
  };
}

/**
 * Validate that the registered migrations for a transition form a contiguous
 * chain from `fromVersion` to `toVersion`. Throws a clear error if a step is
 * missing so migration guides can rely on deterministic behavior.
 */
export function validateMigrationChain(
  fromVersion: string,
  toVersion: string
): void {
  const matching = migrations.filter(
    (m) => m.fromVersion === fromVersion && m.toVersion === toVersion
  );

  if (matching.length === 0) {
    throw new Error(
      `No migration registered for ${fromVersion} -> ${toVersion}`
    );
  }

  // Ensure every step in the chain is present: each step's toVersion must be
  // reachable from fromVersion without gaps.
  const reachable = new Set<string>([fromVersion]);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const m of matching) {
      if (reachable.has(m.fromVersion) && !reachable.has(m.toVersion)) {
        reachable.add(m.toVersion);
        progressed = true;
      }
    }
  }

  if (!reachable.has(toVersion)) {
    throw new Error(
      `Migration chain from ${fromVersion} to ${toVersion} is incomplete: missing step`
    );
  }
}

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
  completedSteps.clear();
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

    // Validate the chain before running so missing steps fail deterministically.
    validateMigrationChain(event.previousHash, event.newHash);

    let entries = getCurrentEntries();
    for (const m of matching) {
      entries = m.migrate(entries);
      completedSteps.add(stepKey(m.fromVersion, m.toVersion));
    }
    replaceEntries(entries);
  };
}
