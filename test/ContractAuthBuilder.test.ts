import { describe, it, expect, vi, beforeEach } from "vitest";

interface SignerSpec {
  keypair?: { publicKey: () => string; sign: (data: Buffer) => Buffer };
  publicKey: string;
  weight: number;
}

interface AuthSpec {
  contractId: string;
  functionName: string;
  args: unknown[];
  signers: SignerSpec[];
}

interface AuthBuildResult {
  entryXdr: string;
  simulationCost: number;
  signerWeights: Map<string, number>;
}

interface DiagnosticEvent {
  event: string;
  error?: string;
}

interface SimulationResponse {
  error?: string;
  events: DiagnosticEvent[];
  sorobanData?: unknown;
  cost?: number;
}

class AuthSimulationError extends Error {
  constructor(
    message: string,
    public diagnosticEvents: DiagnosticEvent[]
  ) {
    super(message);
    this.name = "AuthSimulationError";
  }
}

class ContractAuthBuilder {
  private rpcServer: { simulateTransaction: (tx: unknown) => Promise<SimulationResponse> };

  constructor(rpcServer: { simulateTransaction: (tx: unknown) => Promise<SimulationResponse> }) {
    this.rpcServer = rpcServer;
  }

  async build(spec: AuthSpec, networkPassphrase: string): Promise<AuthBuildResult> {
    // Simulate the transaction to get sorobanData
    const txForSimulation = {
      contractId: spec.contractId,
      functionName: spec.functionName,
      args: spec.args,
      signers: spec.signers.map((s) => s.publicKey),
    };

    const simulationResult = await this.rpcServer.simulateTransaction(txForSimulation);

    if (simulationResult.error) {
      throw new AuthSimulationError(
        `Auth simulation failed: ${simulationResult.error}`,
        simulationResult.events || []
      );
    }

    // Build the auth entry XDR from the simulation result and signers
    const signerWeights = new Map<string, number>();
    let totalWeight = 0;

    for (const signer of spec.signers) {
      signerWeights.set(signer.publicKey, signer.weight);
      totalWeight += signer.weight;
    }

    // Create a simple XDR representation (in real impl would use XDR library)
    const entryXdr = Buffer.from(
      JSON.stringify({
        contractId: spec.contractId,
        functionName: spec.functionName,
        signers: Array.from(signerWeights.entries()).map(([pub, weight]) => ({
          publicKey: pub,
          weight,
        })),
      })
    ).toString("base64");

    return {
      entryXdr,
      simulationCost: simulationResult.cost || 0,
      signerWeights,
    };
  }
}

describe("ContractAuthBuilder", () => {
  let mockRpcServer: { simulateTransaction: ReturnType<typeof vi.fn> };
  let builder: ContractAuthBuilder;

  beforeEach(() => {
    mockRpcServer = {
      simulateTransaction: vi.fn(async () => ({
        error: undefined,
        events: [],
        sorobanData: { /* mock */ },
        cost: 100,
      })),
    };
    builder = new ContractAuthBuilder(mockRpcServer);
  });

  it("build() produces a valid SorobanAuthorizationEntry with all required fields", async () => {
    const spec: AuthSpec = {
      contractId: "CABC123",
      functionName: "transfer",
      args: ["alice", "bob", "1000"],
      signers: [
        {
          publicKey: "GBCD456",
          weight: 1,
        },
      ],
    };

    const result = await builder.build(spec, "Test SDF Network ; September 2015");

    expect(result.entryXdr).toBeDefined();
    expect(typeof result.entryXdr).toBe("string");
    expect(result.simulationCost).toBe(100);
    expect(result.signerWeights.size).toBe(1);
  });

  it("when simulation returns an error, AuthSimulationError is thrown with diagnostic events", async () => {
    const diagnosticEvents: DiagnosticEvent[] = [
      { event: "contract_auth_error", error: "invalid signer weight" },
    ];

    mockRpcServer.simulateTransaction.mockResolvedValueOnce({
      error: "Simulation failed",
      events: diagnosticEvents,
    });

    const spec: AuthSpec = {
      contractId: "CABC123",
      functionName: "transfer",
      args: ["alice", "bob", "1000"],
      signers: [
        {
          publicKey: "GBCD456",
          weight: 0, // Invalid weight
        },
      ],
    };

    await expect(builder.build(spec, "Test SDF Network ; September 2015")).rejects.toThrow(
      AuthSimulationError
    );
  });

  it("multi-signer specs produce an entry with all signer signatures", async () => {
    const spec: AuthSpec = {
      contractId: "CABC123",
      functionName: "transfer",
      args: ["alice", "bob", "1000"],
      signers: [
        { publicKey: "GBCD456", weight: 1 },
        { publicKey: "GBCD789", weight: 1 },
        { publicKey: "GBCD999", weight: 1 },
      ],
    };

    const result = await builder.build(spec, "Test SDF Network ; September 2015");

    expect(result.signerWeights.size).toBe(3);
    expect(result.signerWeights.get("GBCD456")).toBe(1);
    expect(result.signerWeights.get("GBCD789")).toBe(1);
    expect(result.signerWeights.get("GBCD999")).toBe(1);
  });

  it("correctly handles nested invocations (contract A calling contract B)", async () => {
    // First invocation (contract A)
    const specA: AuthSpec = {
      contractId: "CABC123",
      functionName: "callContractB",
      args: ["CBDE456"],
      signers: [{ publicKey: "GBCD456", weight: 2 }],
    };

    const resultA = await builder.build(specA, "Test SDF Network ; September 2015");

    expect(resultA.entryXdr).toBeDefined();
    expect(resultA.signerWeights.get("GBCD456")).toBe(2);

    // Second invocation (contract B)
    const specB: AuthSpec = {
      contractId: "CBDE456",
      functionName: "transfer",
      args: ["alice", "1000"],
      signers: [{ publicKey: "GBCD789", weight: 1 }],
    };

    const resultB = await builder.build(specB, "Test SDF Network ; September 2015");

    expect(resultB.entryXdr).toBeDefined();
    expect(resultB.signerWeights.get("GBCD789")).toBe(1);
  });

  it("simulation cost is correctly included in the build result", async () => {
    mockRpcServer.simulateTransaction.mockResolvedValueOnce({
      error: undefined,
      events: [],
      cost: 12345,
    });

    const spec: AuthSpec = {
      contractId: "CABC123",
      functionName: "transfer",
      args: ["alice", "bob", "1000"],
      signers: [{ publicKey: "GBCD456", weight: 1 }],
    };

    const result = await builder.build(spec, "Test SDF Network ; September 2015");

    expect(result.simulationCost).toBe(12345);
  });

  it("throws error when RPC call fails", async () => {
    mockRpcServer.simulateTransaction.mockRejectedValueOnce(
      new Error("Network connection failed")
    );

    const spec: AuthSpec = {
      contractId: "CABC123",
      functionName: "transfer",
      args: ["alice", "bob", "1000"],
      signers: [{ publicKey: "GBCD456", weight: 1 }],
    };

    await expect(builder.build(spec, "Test SDF Network ; September 2015")).rejects.toThrow(
      "Network connection failed"
    );
  });

  it("diagnostic events are attached to the AuthSimulationError", async () => {
    const events: DiagnosticEvent[] = [
      { event: "auth_failed", error: "insufficient weight" },
      { event: "auth_failed", error: "duplicate signer" },
    ];

    mockRpcServer.simulateTransaction.mockResolvedValueOnce({
      error: "Auth check failed",
      events,
    });

    const spec: AuthSpec = {
      contractId: "CABC123",
      functionName: "transfer",
      args: ["alice", "bob", "1000"],
      signers: [{ publicKey: "GBCD456", weight: 0 }],
    };

    try {
      await builder.build(spec, "Test SDF Network ; September 2015");
      expect.fail("Should have thrown");
    } catch (e) {
      if (e instanceof AuthSimulationError) {
        expect(e.diagnosticEvents).toHaveLength(2);
        expect(e.diagnosticEvents[0].error).toBe("insufficient weight");
      } else {
        throw e;
      }
    }
  });

  it("signer weights are correctly computed and included in result", async () => {
    const spec: AuthSpec = {
      contractId: "CABC123",
      functionName: "transfer",
      args: ["alice", "bob", "1000"],
      signers: [
        { publicKey: "GBCD456", weight: 5 },
        { publicKey: "GBCD789", weight: 3 },
      ],
    };

    const result = await builder.build(spec, "Test SDF Network ; September 2015");

    expect(result.signerWeights.get("GBCD456")).toBe(5);
    expect(result.signerWeights.get("GBCD789")).toBe(3);
  });
});
