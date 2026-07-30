import { describe, it, expect, beforeEach } from "vitest";

interface MigrationFn<From, To> {
  (data: From): To;
}

interface Invoice {
  id: string;
  created_at?: number;
  created: number;
}

interface Payment {
  payer: string;
  amount: bigint;
  ledger?: number;
  timestamp?: number;
}

interface Recipient {
  address: string;
  amount: bigint;
}

class NoMigrationPathError extends Error {
  constructor(fromVersion: number, toVersion: number) {
    super(
      `No migration path from version ${fromVersion} to version ${toVersion}`
    );
    this.name = "NoMigrationPathError";
  }
}

interface MigrationRegistry {
  from: number;
  to: number;
  fn: MigrationFn<any, any>;
}

class SchemaMigrationLayer {
  private migrations: MigrationRegistry[] = [];
  private currentVersion: number = 1;

  register<From, To>(
    fromVersion: number,
    toVersion: number,
    fn: MigrationFn<From, To>
  ): void {
    this.migrations.push({
      from: fromVersion,
      to: toVersion,
      fn,
    });
  }

  setCurrentVersion(version: number): void {
    this.currentVersion = version;
  }

  private findMigrationPath(fromVersion: number, toVersion: number): MigrationRegistry[] {
    if (fromVersion === toVersion) {
      return [];
    }

    const visited = new Set<number>();
    const path: MigrationRegistry[] = [];

    const dfs = (current: number): boolean => {
      if (current === toVersion) {
        return true;
      }

      if (visited.has(current)) {
        return false;
      }

      visited.add(current);

      const nextMigrations = this.migrations.filter(
        (m) => m.from === current
      );

      for (const migration of nextMigrations) {
        path.push(migration);
        if (dfs(migration.to)) {
          return true;
        }
        path.pop();
      }

      return false;
    };

    if (dfs(fromVersion)) {
      return path;
    }

    return [];
  }

  migrate<T>(data: any): T {
    const version = data.__schemaVersion ?? 1;

    if (version === this.currentVersion) {
      const { __schemaVersion, ...rest } = data;
      return rest as T;
    }

    const path = this.findMigrationPath(version, this.currentVersion);

    if (path.length === 0) {
      throw new NoMigrationPathError(version, this.currentVersion);
    }

    let result: any = { ...data };

    for (const migration of path) {
      result = migration.fn(result);
    }

    const { __schemaVersion, ...rest } = result;
    return rest as T;
  }
}

describe("SchemaMigrationLayer", () => {
  let layer: SchemaMigrationLayer;

  beforeEach(() => {
    layer = new SchemaMigrationLayer();
    layer.setCurrentVersion(3);
  });

  it("returns data unchanged when version matches current version", () => {
    const data = {
      __schemaVersion: 3,
      id: "inv-001",
      created: 1234567890,
    };

    const result: Invoice = layer.migrate(data);

    expect(result).toEqual({
      id: "inv-001",
      created: 1234567890,
    });
    expect(result).not.toHaveProperty("__schemaVersion");
  });

  it("defaults to version 1 when __schemaVersion is missing", () => {
    layer.register(1, 2, (data: any) => ({
      ...data,
      created: data.created_at || 0,
    }));

    layer.register(2, 3, (data: any) => ({
      ...data,
      id: data.id.toString(),
    }));

    const data = {
      id: "inv-001",
      created_at: 1234567890,
    };

    const result: Invoice = layer.migrate(data);

    expect(result.created).toBe(1234567890);
    expect(result.id).toBe("inv-001");
  });

  it("applies single migration correctly", () => {
    layer.register(2, 3, (data: any) => ({
      ...data,
      id: data.id.toString(),
    }));

    const data = {
      __schemaVersion: 2,
      id: 123,
      created: 1234567890,
    };

    const result: Invoice = layer.migrate(data);

    expect(result.id).toBe("123");
  });

  it("applies two-step migration chain v1 → v2 → v3", () => {
    layer.register(1, 2, (data: any) => ({
      ...data,
      created: data.created_at || 0,
    }));

    layer.register(2, 3, (data: any) => ({
      ...data,
      id: data.id.toString(),
    }));

    const data = {
      __schemaVersion: 1,
      id: 456,
      created_at: 1234567890,
    };

    const result: Invoice = layer.migrate(data);

    expect(result.created).toBe(1234567890);
    expect(result.id).toBe("456");
  });

  it("throws NoMigrationPathError when no path exists", () => {
    const data = {
      __schemaVersion: 5,
      id: "inv-001",
      created: 1234567890,
    };

    expect(() => layer.migrate(data)).toThrow(NoMigrationPathError);
  });

  it("handles complex migration with Payment type", () => {
    layer.register(
      1,
      2,
      (data: any) => ({
        ...data,
        amount: BigInt(data.amount),
      })
    );

    layer.register(2, 3, (data: any) => ({
      ...data,
      timestamp: data.timestamp || data.ledger_time,
    }));

    const data = {
      __schemaVersion: 1,
      payer: "GBPW7KX3ELW6S4CPJV7EN5CQZXDQY2C5XADFVQKK3GYXRM4MFVNX6AKY",
      amount: "1000000",
      ledger_time: 1234567890,
    };

    const result: Payment = layer.migrate(data);

    expect(result.amount).toBe(BigInt(1000000));
    expect(result.timestamp).toBe(1234567890);
  });

  it("handles Recipient type migration", () => {
    layer.register(1, 2, (data: any) => ({
      ...data,
      amount: BigInt(data.amount),
    }));

    layer.register(2, 3, (data: any) => ({
      ...data,
      address: data.address.toUpperCase(),
    }));

    const data = {
      __schemaVersion: 1,
      address: "gbpw7kx3elw6s4cpjv7en5cqzxdqy2c5xadfvqkk3gyxrm4mfvnx6aky",
      amount: "5000000",
    };

    const result: Recipient = layer.migrate(data);

    expect(result.amount).toBe(BigInt(5000000));
    expect(result.address).toBe(
      "GBPW7KX3ELW6S4CPJV7EN5CQZXDQY2C5XADFVQKK3GYXRM4MFVNX6AKY"
    );
  });

  it("preserves all data fields through migration chain", () => {
    layer.register(1, 2, (data: any) => ({
      ...data,
      updated: true,
    }));

    layer.register(2, 3, (data: any) => ({
      ...data,
      migrated: true,
    }));

    const data = {
      __schemaVersion: 1,
      id: "inv-001",
      created: 1234567890,
      metadata: { key: "value" },
    };

    const result: any = layer.migrate(data);

    expect(result.id).toBe("inv-001");
    expect(result.created).toBe(1234567890);
    expect(result.metadata).toEqual({ key: "value" });
    expect(result.updated).toBe(true);
    expect(result.migrated).toBe(true);
  });

  it("supports multiple independent migration chains", () => {
    layer.register(1, 2, (data: any) => ({
      ...data,
      v1_to_v2: true,
    }));

    layer.register(2, 3, (data: any) => ({
      ...data,
      v2_to_v3: true,
    }));

    const data = {
      __schemaVersion: 1,
      id: "inv-001",
    };

    const result: any = layer.migrate(data);

    expect(result.v1_to_v2).toBe(true);
    expect(result.v2_to_v3).toBe(true);
  });

  it("handles versions jumping multiple steps", () => {
    layer.register(1, 3, (data: any) => ({
      ...data,
      direct_migration: true,
    }));

    const data = {
      __schemaVersion: 1,
      id: "inv-001",
    };

    const result: any = layer.migrate(data);

    expect(result.direct_migration).toBe(true);
  });

  it("removes __schemaVersion from final result", () => {
    const data = {
      __schemaVersion: 3,
      id: "inv-001",
      created: 1234567890,
    };

    const result: any = layer.migrate(data);

    expect(result).not.toHaveProperty("__schemaVersion");
  });

  it("applies migrations in correct order for complex paths", () => {
    const order: number[] = [];

    layer.register(1, 2, (data: any) => {
      order.push(1);
      return { ...data, step1: true };
    });

    layer.register(2, 3, (data: any) => {
      order.push(2);
      return { ...data, step2: true };
    });

    const data = {
      __schemaVersion: 1,
      id: "inv-001",
    };

    layer.migrate(data);

    expect(order).toEqual([1, 2]);
  });

  it("handles empty data object", () => {
    const data = {
      __schemaVersion: 3,
    };

    const result: any = layer.migrate(data);

    expect(result).toEqual({});
  });

  it("rejects migration from unknown version", () => {
    const data = {
      __schemaVersion: 99,
      id: "inv-001",
    };

    expect(() => layer.migrate(data)).toThrow(NoMigrationPathError);
  });
});
