/**
 * Programmatic SDK Architecture Catalog & Validator (#1199).
 *
 * Maps architectural layers, design decisions (ADRs), Mermaid diagrams,
 * public API entrypoints, extension points, and specification references
 * for `@stellar-split/sdk`.
 */

export type ArchitectureLayerId =
  | "presentation-bindings"
  | "client-orchestration"
  | "domain-engines"
  | "plugin-middleware"
  | "resilience-transport"
  | "stellar-network";

export interface ArchitectureModuleDescriptor {
  name: string;
  path: string;
  layer: ArchitectureLayerId;
  responsibility: string;
  dependencies: string[];
  publicExports: string[];
}

export interface ArchitectureLayerDescriptor {
  id: ArchitectureLayerId;
  title: string;
  order: number;
  summary: string;
  modules: ArchitectureModuleDescriptor[];
}

export interface DesignDecisionRecord {
  id: string;
  title: string;
  status: "accepted" | "superseded";
  context: string;
  decision: string;
  consequences: string[];
  relatedModules: string[];
}

export interface ArchitectureDiagramDescriptor {
  id: string;
  title: string;
  diagramType: "flowchart" | "sequenceDiagram" | "stateDiagram-v2";
  description: string;
  mermaidSource: string;
}

export interface ApiSurfaceEntry {
  subpath: string;
  entrypoint: string;
  category: "core" | "ui" | "react" | "testing" | "telemetry" | "utilities" | "lazy";
  summary: string;
  keySymbols: Array<{
    symbol: string;
    kind: "class" | "function" | "interface" | "type" | "const";
    signature: string;
    description: string;
  }>;
}

export interface ExtensionPointDescriptor {
  id: string;
  name: string;
  contractSymbol: string;
  sourceModule: string;
  lifecycleHooks: string[];
  description: string;
  exampleCode: string;
}

export interface ArchitectureReference {
  id: string;
  title: string;
  category: "internal-doc" | "stellar-sep" | "external-spec" | "source-module";
  pathOrUrl: string;
  description: string;
}

export interface ArchitectureValidationReport {
  valid: boolean;
  layerCount: number;
  moduleCount: number;
  decisionCount: number;
  diagramCount: number;
  apiEntryCount: number;
  extensionPointCount: number;
  referenceCount: number;
  errors: string[];
}

export const SDK_ARCHITECTURE_LAYERS: readonly ArchitectureLayerDescriptor[] = [
  {
    id: "presentation-bindings",
    title: "Layer 1 — Presentation, UI & Framework Bindings",
    order: 1,
    summary:
      "Optional framework bindings (`./react`), headless UI primitives (`./ui`), QR generators (`src/qr`), and lazy bundle entrypoints (`./lazy`).",
    modules: [
      {
        name: "React Hooks & Providers",
        path: "src/react/index.ts",
        layer: "presentation-bindings",
        responsibility:
          "Provides React 18/19 hooks and context providers for reactive invoice state, wallet connection, and payment streaming.",
        dependencies: ["src/client.ts", "src/wallets"],
        publicExports: ["StellarSplitProvider", "useInvoice", "useSplitClient"],
      },
      {
        name: "UI Primitives",
        path: "src/ui/index.ts",
        layer: "presentation-bindings",
        responsibility:
          "Framework-agnostic UI state models for split previews, payment progress, and receipt rendering.",
        dependencies: ["src/splitPreview.ts", "src/receipt.ts"],
        publicExports: ["SplitPreviewModel", "PaymentProgressTracker"],
      },
    ],
  },
  {
    id: "client-orchestration",
    title: "Layer 2 — Client Orchestration & Event Bus",
    order: 2,
    summary:
      "Primary `StellarSplitClient` facade (`src/client.ts`), typed event emitter (`SplitClientEventMap`), and runtime network switching (`src/config.ts`).",
    modules: [
      {
        name: "StellarSplitClient",
        path: "src/client.ts",
        layer: "client-orchestration",
        responsibility:
          "Coordinates Soroban contract invocations, transaction simulation, preflight checks, signing, submission, and event emission.",
        dependencies: [
          "src/config.ts",
          "src/plugin.ts",
          "src/resilience/CircuitBreaker.ts",
          "src/rpc/RpcLoadBalancer.ts",
          "src/telemetryHooks.ts",
        ],
        publicExports: [
          "StellarSplitClient",
          "StellarSplitClientConfig",
          "NetworkConfig",
          "TxResult",
        ],
      },
      {
        name: "Network Configuration & Switcher",
        path: "src/config.ts",
        layer: "client-orchestration",
        responsibility:
          "Manages Mainnet, Testnet, Futurenet, and Custom network presets and runtime passphrase verification.",
        dependencies: ["src/errors.ts"],
        publicExports: [
          "NetworkEnvironment",
          "NETWORK_PRESETS",
          "getNetworkPreset",
          "detectNetworkEnvironment",
          "isNetworkPreset",
        ],
      },
    ],
  },
  {
    id: "domain-engines",
    title: "Layer 3 — Domain Engines (Invoices, Payments, Governance & Compliance)",
    order: 3,
    summary:
      "Core business logic for invoice lifecycles, multi-recipient split allocation, waterfall routing, escrow/dispute resolution, and SEP-41 token adapters.",
    modules: [
      {
        name: "Invoice State Machine & Query Engine",
        path: "src/state/InvoiceStateMachine.ts",
        layer: "domain-engines",
        responsibility:
          "Enforces deterministic invoice state transitions (pending -> partially_funded -> funded -> released / refunded / disputed).",
        dependencies: ["src/types/state.ts", "src/errors.ts"],
        publicExports: ["InvoiceStateMachine", "InvoiceQueryEngine"],
      },
      {
        name: "Payment Orchestrator & Allocation Engine",
        path: "src/paymentOrchestrator.ts",
        layer: "domain-engines",
        responsibility:
          "Computes exact BigInt split ratios, routes multi-asset path payments, and coordinates atomic batch settlements.",
        dependencies: [
          "src/paymentAllocation.ts",
          "src/paymentSplitCalculator.ts",
          "src/pathRouter.ts",
        ],
        publicExports: [
          "PaymentOrchestrator",
          "computePaymentValidation",
          "verifyBatchPayments",
        ],
      },
      {
        name: "Signing & Multi-Wallet Abstraction",
        path: "src/signing/signer.ts",
        layer: "domain-engines",
        responsibility:
          "Unifies Freighter, WalletConnect, Ledger WebHID, xBull, and custodial keypair signers behind a single `Signer` interface.",
        dependencies: ["src/wallet.ts", "src/multiSignature.ts"],
        publicExports: ["Signer", "signTransaction", "MultiSignatureCoordinator"],
      },
    ],
  },
  {
    id: "plugin-middleware",
    title: "Layer 4 — Plugin, Interceptor, Deduplication & Telemetry Pipeline",
    order: 4,
    summary:
      "Cross-cutting execution pipeline providing `PluginRegistry`, HTTP/RPC request & response interceptors, idempotency deduplication, and OpenTelemetry-compatible hooks.",
    modules: [
      {
        name: "Plugin Registry",
        path: "src/plugin.ts",
        layer: "plugin-middleware",
        responsibility:
          "Executes `beforeCall` (registration order), `afterCall` (reverse order), and `onError` lifecycle hooks around SDK operations.",
        dependencies: ["src/errors.ts"],
        publicExports: ["PluginRegistry", "LoggingPlugin", "MetricsPlugin", "SdkPlugin"],
      },
      {
        name: "Telemetry Hook Manager",
        path: "src/telemetryHooks.ts",
        layer: "plugin-middleware",
        responsibility:
          "Fire-and-forget observability hooks (`onCallStart`, `onCallEnd`, `onError`, `onProfile`) with sanitized arguments and trace IDs.",
        dependencies: ["src/traceId.ts", "src/profiler.ts"],
        publicExports: ["TelemetryHookManager", "TelemetryHooks"],
      },
      {
        name: "Request Deduplication & Idempotency",
        path: "src/dedup.ts",
        layer: "plugin-middleware",
        responsibility:
          "Serializes concurrent duplicate requests by `Idempotency-Key` or payload fingerprint and caches completed responses within TTL.",
        dependencies: ["src/idempotency.ts", "src/requestDebouncer.ts"],
        publicExports: ["Deduplicator", "RequestDebouncer"],
      },
    ],
  },
  {
    id: "resilience-transport",
    title: "Layer 5 — Resilience, Caching, Offline Queue & RPC Load Balancing",
    order: 5,
    summary:
      "Fault-tolerant transport layer featuring `RpcLoadBalancer`, `CircuitBreaker`, `OfflineQueue`, exponential backoff with jitter (`retryPolicy.ts`), and `RpcConnectionPool`.",
    modules: [
      {
        name: "RPC Load Balancer & Connection Pool",
        path: "src/rpc/RpcLoadBalancer.ts",
        layer: "resilience-transport",
        responsibility:
          "Distributes Soroban RPC and Horizon traffic across multiple endpoints with automatic health probing, quarantine demotion, and reinstatement.",
        dependencies: ["src/connectionPool.ts", "src/healthCheck.ts"],
        publicExports: ["RpcLoadBalancer", "RpcConnectionPool"],
      },
      {
        name: "Advanced Circuit Breaker & Retry Policy",
        path: "src/resilience/CircuitBreaker.ts",
        layer: "resilience-transport",
        responsibility:
          "Protects upstream RPC nodes using closed/open/half-open state transitions paired with per-method retry budgets and jitter.",
        dependencies: ["src/retryPolicy.ts", "src/errors.ts"],
        publicExports: ["CircuitBreaker", "executeWithRetry", "withRetry"],
      },
      {
        name: "Offline Queue & Conflict Resolver",
        path: "src/offlineQueue.ts",
        layer: "resilience-transport",
        responsibility:
          "Buffers mutating operations during network partitions and replays them deterministically on reconnection.",
        dependencies: ["src/conflictResolver.ts", "src/persistentQueue.ts"],
        publicExports: ["OfflineQueue", "QueuedOperation"],
      },
    ],
  },
  {
    id: "stellar-network",
    title: "Layer 6 — Stellar Horizon, Soroban RPC & XDR Protocol Boundary",
    order: 6,
    summary:
      "Low-level protocol adapters for `@stellar/stellar-sdk`, Soroban XDR encoding/decoding (`xdrDecoder.ts`), footprint optimization, and error classification (`errors.ts`).",
    modules: [
      {
        name: "Soroban XDR & Error Taxonomy",
        path: "src/errors.ts",
        layer: "stellar-network",
        responsibility:
          "Maps raw Soroban contract error codes and Horizon HTTP failures into 60+ typed `StellarSplitError` subclasses with recovery suggestions.",
        dependencies: ["src/xdrDecoder.ts", "src/horizonErrorClassifier.ts"],
        publicExports: [
          "StellarSplitError",
          "parseSorobanError",
          "ContractError",
          "RpcError",
          "SimulationFailedError",
        ],
      },
    ],
  },
];

export const SDK_DESIGN_DECISIONS: readonly DesignDecisionRecord[] = [
  {
    id: "ADR-001",
    title: "Strict BigInt Representation for Stroop & Token Amounts",
    status: "accepted",
    context:
      "IEEE-754 double-precision numbers lose precision above 2^53 - 1 and introduce rounding drift during multi-recipient invoice split allocations.",
    decision:
      "Represent all on-chain token quantities, stroop balances, and fee ceilings as native `bigint` values across public inputs and outputs, paired with `parseAmount` and `formatAmount` boundary helpers.",
    consequences: [
      "Zero floating-point rounding drift across waterfall and proportional split calculations.",
      "Direct 1:1 mapping to Soroban `i128` / `u64` XDR `ScVal` types.",
      "Callers migrating from v0.x/v1.x must convert `number` literals to `bigint` (e.g., `1000000n`).",
    ],
    relatedModules: ["src/utils.ts", "src/paymentSplitCalculator.ts", "src/xdrDecoder.ts"],
  },
  {
    id: "ADR-002",
    title: "Simulate-Before-Submit Transaction Pipeline with Preflight Guards",
    status: "accepted",
    context:
      "Submitting unverified Soroban transactions wastes base fees and exposes users to opaque on-chain traps when invoices are expired, frozen, or under-funded.",
    decision:
      "Every mutating contract call (`createInvoice`, `pay`, `release`, `refund`) executes local preflight validators (`preflightChecker.ts`), followed by Soroban `simulateTransaction` to compute exact ledger footprints and resource fees before invoking the wallet signer.",
    consequences: [
      "Catches `InvoiceExpired`, `InsufficientBalance`, and `NftGateRequired` errors prior to wallet prompt.",
      "Automatically sizes Soroban read/write footprint and instruction budgets.",
    ],
    relatedModules: [
      "src/preflightChecker.ts",
      "src/transactionSimulator.ts",
      "src/client.ts",
    ],
  },
  {
    id: "ADR-003",
    title: "Onion Middleware Pipeline via PluginRegistry and Fire-and-Forget Telemetry",
    status: "accepted",
    context:
      "Enterprise integrators require custom audit logging, OpenTelemetry tracing, and metric collection without bundling heavy observability SDKs in the core package.",
    decision:
      "Provide a two-tier extensibility model: `PluginRegistry` (`beforeCall` forward, `afterCall`/`onError` reverse) for functional interception, and `TelemetryHookManager` for non-blocking, exception-isolated observability callbacks.",
    consequences: [
      "Core bundle remains lightweight and tree-shakeable (`sideEffects: false`).",
      "Exceptions thrown inside user telemetry callbacks are caught and isolated so they never break payment flows.",
    ],
    relatedModules: ["src/plugin.ts", "src/telemetryHooks.ts", "src/telemetryModule.ts"],
  },
  {
    id: "ADR-004",
    title: "Request Deduplication & Idempotency Key Serialization",
    status: "accepted",
    context:
      "Network retries and double-clicks in browser dApps can trigger duplicate invoice creations or double payments if concurrent identical requests race.",
    decision:
      "Track idempotent operations by `Idempotency-Key` (or deterministic payload hash) across `in-flight` and `completed` states with configurable TTL eviction.",
    consequences: [
      "Concurrent duplicate calls coalesce onto the single in-flight promise.",
      "Retries within the retention window receive the cached outcome without re-submitting on-chain.",
    ],
    relatedModules: ["src/dedup.ts", "src/idempotency.ts", "src/requestDebouncer.ts"],
  },
  {
    id: "ADR-005",
    title: "Multi-Endpoint RPC Load Balancing with Circuit Breaking & Offline Queueing",
    status: "accepted",
    context:
      "Public and commercial Soroban RPC endpoints experience transient rate-limiting, ledger lag, and regional outages.",
    decision:
      "Combine `RpcLoadBalancer` (endpoint health scoring & automatic demotion/reinstatement) with `CircuitBreaker` (closed/open/half-open state machine) and `OfflineQueue` for disconnected environments.",
    consequences: [
      "Automatic failover across backup RPC providers without application intervention.",
      "Fast-fail semantics (`CircuitOpenError`) prevent cascading queue exhaustion during network-wide incidents.",
    ],
    relatedModules: [
      "src/rpc/RpcLoadBalancer.ts",
      "src/resilience/CircuitBreaker.ts",
      "src/offlineQueue.ts",
    ],
  },
  {
    id: "ADR-006",
    title: "Multi-Entrypoint Subpath Exports for Zero-Bloat Tree Shaking",
    status: "accepted",
    context:
      "Backend Node.js microservices should not pull in React components, UI state machines, or mock test harnesses when importing core client functionality.",
    decision:
      "Partition the package into 8 explicit subpath exports (`.`, `./ui`, `./react`, `./testing`, `./mock`, `./telemetry`, `./utils`, `./lazy`) enforced by `size-limits.config.ts`.",
    consequences: [
      "Minimal cold-start footprint for serverless and edge runtimes.",
      "Optional peer dependencies (`react`, `@opentelemetry/api`) remain strictly opt-in.",
    ],
    relatedModules: ["package.json", "tsup.config.ts", "size-limits.config.ts"],
  },
];

export const SDK_DIAGRAMS: readonly ArchitectureDiagramDescriptor[] = [
  {
    id: "layered-system-architecture",
    title: "Layered System Architecture",
    diagramType: "flowchart",
    description:
      "High-level view of the 6 architectural layers from Presentation/Subpath exports down to Stellar Horizon and Soroban RPC.",
    mermaidSource: `flowchart TB
  subgraph L1["Layer 1: Presentation & Subpath Entrypoints"]
    React["@stellar-split/sdk/react"]
    UI["@stellar-split/sdk/ui"]
    Testing["@stellar-split/sdk/testing & /mock"]
  end

  subgraph L2["Layer 2: Client Orchestration"]
    Client["StellarSplitClient (src/client.ts)"]
    Config["NetworkEnvironment & Switcher (src/config.ts)"]
    Events["TypedEventEmitter (SplitClientEventMap)"]
  end

  subgraph L3["Layer 3: Domain Engines"]
    State["InvoiceStateMachine & QueryEngine"]
    Pay["PaymentOrchestrator & SplitCalculator"]
    Sign["Signer Vault & Wallet Adapters"]
  end

  subgraph L4["Layer 4: Plugin, Deduplication & Telemetry"]
    Plugins["PluginRegistry (beforeCall / afterCall)"]
    Dedup["Deduplicator & RequestDebouncer"]
    Telemetry["TelemetryHookManager & Profiler"]
  end

  subgraph L5["Layer 5: Resilience & Transport"]
    LB["RpcLoadBalancer & ConnectionPool"]
    CB["CircuitBreaker & RetryPolicy"]
    Offline["OfflineQueue & ConflictResolver"]
  end

  subgraph L6["Layer 6: Stellar Protocol Boundary"]
    Soroban["Soroban RPC (Simulate / Send / Events)"]
    Horizon["Stellar Horizon API (Accounts / Orderbook)"]
    XDR["XDR ScVal Codec & Error Classifier"]
  end

  L1 --> L2
  L2 --> L3
  L3 --> L4
  L4 --> L5
  L5 --> L6`,
  },
  {
    id: "transaction-lifecycle-sequence",
    title: "Mutating Transaction Lifecycle (Preflight -> Simulate -> Sign -> Submit -> Confirm)",
    diagramType: "sequenceDiagram",
    description:
      "End-to-end execution flow of `client.pay()` or `client.createInvoice()` through plugins, deduplication, preflight validation, Soroban simulation, wallet signing, and finality polling.",
    mermaidSource: `sequenceDiagram
  autonumber
  actor Caller as Application / dApp
  participant Client as StellarSplitClient
  participant Plugin as PluginRegistry & Telemetry
  participant Dedup as Deduplicator
  participant Preflight as PreflightChecker
  participant RPC as RpcLoadBalancer / Soroban RPC
  participant Signer as Wallet Signer
  participant Finality as FinalityChecker

  Caller->>Client: pay(params, { idempotencyKey })
  Client->>Plugin: runBeforeCall("pay", params) & onCallStart()
  Client->>Dedup: checkOrRegister(idempotencyKey)
  alt Duplicate Completed Request
    Dedup-->>Client: Return cached TxResult
  else New Request
    Client->>Preflight: checkInvoiceExpiry() & checkPayerReadiness()
    Client->>RPC: simulateTransaction(contractCall)
    RPC-->>Client: SimulationResult (footprint + resourceFee)
    Client->>Signer: signTransaction(assembledTxXdr)
    Signer-->>Client: signedTxXdr
    Client->>RPC: sendTransaction(signedTxXdr)
    RPC-->>Client: PENDING (txHash)
    Client->>Finality: pollTransactionStatus(txHash)
    Finality-->>Client: SUCCESS (returnValue, ledger)
    Client->>Dedup: recordCompleted(idempotencyKey, txResult)
    Client->>Plugin: runAfterCall("pay", txResult) & onCallEnd()
  end
  Client-->>Caller: TxResult`,
  },
  {
    id: "resilience-circuit-breaker-state",
    title: "Resilience & RPC Endpoint State Machine",
    diagramType: "stateDiagram-v2",
    description:
      "State transitions of the Advanced Circuit Breaker and RPC Load Balancer endpoint quarantine lifecycle.",
    mermaidSource: `stateDiagram-v2
  [*] --> Closed
  Closed --> Open: Failure threshold exceeded (emit circuit:open)
  Open --> HalfOpen: Cooldown timer elapsed (emit circuit:half-open)
  HalfOpen --> Closed: Probe request succeeded (emit circuit:close)
  HalfOpen --> Open: Probe request failed (emit circuit:open)`,
  },
];

export const SDK_API_CATALOG: readonly ApiSurfaceEntry[] = [
  {
    subpath: "@stellar-split/sdk",
    entrypoint: "src/index.ts",
    category: "core",
    summary:
      "Primary SDK entrypoint exporting `StellarSplitClient`, network configuration, plugin system, error taxonomy, health checks, and metrics.",
    keySymbols: [
      {
        symbol: "StellarSplitClient",
        kind: "class",
        signature: "new StellarSplitClient(config: StellarSplitClientConfig)",
        description:
          "Main client for creating invoices, executing split payments, managing escrow/disputes, subscribing to contract events, and switching networks.",
      },
      {
        symbol: "NetworkEnvironment",
        kind: "const",
        signature: "enum NetworkEnvironment { MAINNET, TESTNET, FUTURENET, CUSTOM }",
        description:
          "Built-in Stellar network environment identifiers used with `NETWORK_PRESETS` and `client.switchNetwork()`.",
      },
      {
        symbol: "PluginRegistry",
        kind: "class",
        signature: "use(plugin: SdkPlugin, options?: Record<string, unknown>): void",
        description:
          "Registers functional middleware plugins that intercept `createInvoice` and `pay` calls.",
      },
      {
        symbol: "StellarSplitError",
        kind: "class",
        signature: "class StellarSplitError extends Error { readonly code: string }",
        description:
          "Base class for all typed SDK errors including `InvoiceNotFoundError`, `SimulationFailedError`, and `CircuitOpenError`.",
      },
    ],
  },
  {
    subpath: "@stellar-split/sdk/ui",
    entrypoint: "src/ui/index.ts",
    category: "ui",
    summary:
      "Headless UI view-models, formatting helpers, and interactive state controllers for invoice split visualization.",
    keySymbols: [
      {
        symbol: "SplitPreview",
        kind: "function",
        signature: "buildSplitPreview(params: SplitPreviewInput): SplitPreviewOutput",
        description:
          "Calculates per-recipient stroop allocations, fee breakdowns, and rounding adjustments for UI preview prior to signing.",
      },
    ],
  },
  {
    subpath: "@stellar-split/sdk/react",
    entrypoint: "src/react/index.ts",
    category: "react",
    summary: "React 18 & 19 hooks and context bindings for StellarSplit dApps.",
    keySymbols: [
      {
        symbol: "useSplitClient",
        kind: "function",
        signature: "useSplitClient(): StellarSplitClient",
        description: "Accesses the active `StellarSplitClient` instance from React context.",
      },
    ],
  },
  {
    subpath: "@stellar-split/sdk/testing",
    entrypoint: "src/testing/index.ts",
    category: "testing",
    summary:
      "Deterministic test harnesses, fixture factories, and simulation sandboxes for consumer unit and integration tests.",
    keySymbols: [
      {
        symbol: "SimulationSandbox",
        kind: "class",
        signature: "new SimulationSandbox(options?: SandboxOptions)",
        description:
          "In-memory Soroban contract simulation environment for testing invoice workflows without network calls.",
      },
    ],
  },
  {
    subpath: "@stellar-split/sdk/mock",
    entrypoint: "src/mock/index.ts",
    category: "testing",
    summary: "Drop-in mock client and deterministic wallet stubs.",
    keySymbols: [
      {
        symbol: "MockStellarSplitClient",
        kind: "class",
        signature: "new MockStellarSplitClient(overrides?: Partial<StellarSplitClientConfig>)",
        description: "In-memory mock implementation of `StellarSplitClient` for rapid UI prototyping.",
      },
    ],
  },
  {
    subpath: "@stellar-split/sdk/telemetry",
    entrypoint: "src/telemetryModule.ts",
    category: "telemetry",
    summary:
      "OpenTelemetry bridge, metrics exporters, and structured performance profiling utilities.",
    keySymbols: [
      {
        symbol: "TelemetryHookManager",
        kind: "class",
        signature: "new TelemetryHookManager(hooks?: TelemetryHooks)",
        description:
          "Coordinates `onCallStart`, `onCallEnd`, `onError`, and `onProfile` callbacks with zero impact on caller control flow.",
      },
    ],
  },
  {
    subpath: "@stellar-split/sdk/utils",
    entrypoint: "src/utils.ts",
    category: "utilities",
    summary:
      "Pure utility functions for Stellar address validation, BigInt stroop conversion, and deadline expiration checks.",
    keySymbols: [
      {
        symbol: "parseAmount",
        kind: "function",
        signature: "parseAmount(displayAmount: string, decimals?: number): bigint",
        description: "Converts a human-readable decimal string into an exact `bigint` stroop value.",
      },
      {
        symbol: "formatAmount",
        kind: "function",
        signature: "formatAmount(stroops: bigint, decimals?: number): string",
        description: "Formats an exact `bigint` stroop value into a human-readable decimal string.",
      },
    ],
  },
  {
    subpath: "@stellar-split/sdk/lazy",
    entrypoint: "src/lazy/index.ts",
    category: "lazy",
    summary:
      "Code-split dynamic loaders for heavy optional subsystems (PDF export, analytics engines, forensics).",
    keySymbols: [
      {
        symbol: "LazyInitializer",
        kind: "class",
        signature: "new LazyInitializer<T>(loader: () => Promise<T>)",
        description: "Defers loading and instantiation of heavy modules until first invocation.",
      },
    ],
  },
];

export const SDK_EXTENSION_POINTS: readonly ExtensionPointDescriptor[] = [
  {
    id: "ext-sdk-plugin",
    name: "SDK Lifecycle Plugins (`SdkPlugin`)",
    contractSymbol: "SdkPlugin",
    sourceModule: "src/plugin.ts",
    lifecycleHooks: ["install", "beforeCall", "afterCall", "onError"],
    description:
      "Intercepts SDK method calls (`createInvoice`, `pay`) to inject custom validation, argument enrichment, caching, or audit logging without modifying core client code.",
    exampleCode: `import { SdkPlugin } from "@stellar-split/sdk";

export const AuditTrailPlugin: SdkPlugin = {
  name: "audit-trail",
  beforeCall(method, args) {
    console.info(\`[Audit] invoking \${method}\`);
    return args;
  },
  afterCall(method, result) {
    console.info(\`[Audit] completed \${method} tx=\${result.txHash}\`);
    return result;
  },
  onError(method, err) {
    console.error(\`[Audit] failed \${method}\`, err);
  },
};`,
  },
  {
    id: "ext-telemetry-hooks",
    name: "Observability & Telemetry Hooks (`TelemetryHooks`)",
    contractSymbol: "TelemetryHooks",
    sourceModule: "src/telemetryHooks.ts",
    lifecycleHooks: ["onCallStart", "onCallEnd", "onError", "onProfile"],
    description:
      "Fire-and-forget callbacks for bridging SDK traces, latency histograms, and structured errors into OpenTelemetry, Sentry, or Datadog.",
    exampleCode: `import { TelemetryHooks } from "@stellar-split/sdk";

export const datadogHooks: TelemetryHooks = {
  onCallStart: ({ method, traceId }) =>
    console.debug(\`start \${method} [\${traceId}]\`),
  onCallEnd: ({ method, durationMs, success }) =>
    console.debug(\`end \${method} (\${durationMs}ms) ok=\${success}\`),
  onError: (error, ctx) =>
    console.error(\`error in \${ctx.method}:\`, error.code),
};`,
  },
  {
    id: "ext-wallet-signer",
    name: "Custom Wallet & HSM Signer (`Signer`)",
    contractSymbol: "Signer",
    sourceModule: "src/signing/signer.ts",
    lifecycleHooks: ["getPublicKey", "signTransaction", "signAuthEntry"],
    description:
      "Allows integrating hardware security modules (HSM), KMS custody backends, or custom browser wallets into the transaction signing pipeline.",
    exampleCode: `import type { Signer } from "@stellar-split/sdk";

export class CustomKmsSigner implements Signer {
  constructor(private readonly publicKey: string) {}
  async getPublicKey(): Promise<string> {
    return this.publicKey;
  }
  async signTransaction(xdr: string): Promise<string> {
    return xdr; // Sign XDR payload via KMS
  }
}`,
  },
  {
    id: "ext-request-interceptors",
    name: "Transport Request & Response Interceptors",
    contractSymbol: "addRequestInterceptor / addResponseInterceptor",
    sourceModule: "src/interceptors.ts",
    lifecycleHooks: ["onRequest", "onResponse"],
    description:
      "Transforms outgoing RPC/Horizon HTTP requests (e.g., HMAC signing, payload compression, custom auth headers) and incoming responses.",
    exampleCode: `import { addRequestInterceptor } from "@stellar-split/sdk";

addRequestInterceptor((request) => ({
  ...request,
  headers: { ...request.headers, "X-Tenant-Id": "acme-corp" },
}));`,
  },
  {
    id: "ext-custom-health-check",
    name: "Custom Dependency Health Checks (`HealthCheckRegistry`)",
    contractSymbol: "HealthCheckRegistry",
    sourceModule: "src/healthCheck.ts",
    lifecycleHooks: ["register", "runAll"],
    description:
      "Registers custom liveness and readiness probes (e.g., Redis cache, IPFS gateway, custom indexer) into the SDK health endpoint aggregator.",
    exampleCode: `import { createCustomHealthCheck } from "@stellar-split/sdk";

const ipfsCheck = createCustomHealthCheck("ipfs-gateway", async () => {
  return true;
});`,
  },
  {
    id: "ext-upgrade-migration",
    name: "Contract Upgrade State Migrations (`registerUpgradeMigration`)",
    contractSymbol: "registerUpgradeMigration",
    sourceModule: "src/upgradeMigrationRunner.ts",
    lifecycleHooks: ["registerUpgradeMigration", "makeMigrationCallback"],
    description:
      "Registers automatic in-memory cache transformation functions triggered when `watchContractUpgrade` detects an on-chain WASM hash transition.",
    exampleCode: `import { registerUpgradeMigration } from "@stellar-split/sdk";

registerUpgradeMigration("hash-v1", "hash-v2", (entries) => {
  return new Map(entries);
});`,
  },
];

export const SDK_REFERENCES: readonly ArchitectureReference[] = [
  {
    id: "ref-api-doc",
    title: "StellarSplit SDK API Reference",
    category: "internal-doc",
    pathOrUrl: "docs/API.md",
    description: "Complete method signatures, parameter schemas, and return types for `StellarSplitClient`.",
  },
  {
    id: "ref-error-codes",
    title: "Error Codes & Recovery Catalog",
    category: "internal-doc",
    pathOrUrl: "docs/ERROR_CODES.md",
    description: "Reference table of all `StellarSplitError` codes, Soroban contract error mappings, and remediation guidance.",
  },
  {
    id: "ref-telemetry-hooks",
    title: "Telemetry Hooks Specification",
    category: "internal-doc",
    pathOrUrl: "docs/TELEMETRY_HOOKS.md",
    description: "Detailed guide on configuring `TelemetryHooks`, profiler metrics, and OpenTelemetry exporters.",
  },
  {
    id: "ref-signing-vault",
    title: "Signing Vault & Multi-Signature Architecture",
    category: "internal-doc",
    pathOrUrl: "docs/SIGNING_VAULT.md",
    description: "Security architecture for key management, hardware wallets, and threshold signatures.",
  },
  {
    id: "ref-performance-tuning",
    title: "Performance Tuning & Footprint Optimization",
    category: "internal-doc",
    pathOrUrl: "docs/PERFORMANCE_TUNING.md",
    description: "Benchmarks and configuration guidelines for connection pooling, batching, and Soroban ledger footprints.",
  },
  {
    id: "ref-migration-guide",
    title: "SDK Version Migration Guide",
    category: "internal-doc",
    pathOrUrl: "docs/MIGRATION.md",
    description: "Step-by-step upgrade instructions, breaking changes, and automated validation across major SDK versions.",
  },
  {
    id: "ref-sep-0041",
    title: "SEP-0041: Soroban Token Interface",
    category: "stellar-sep",
    pathOrUrl: "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md",
    description: "Standard token interface used by `sep41Adapter.ts` for multi-asset invoice settlement.",
  },
  {
    id: "ref-sep-0010",
    title: "SEP-0010: Stellar Web Authentication",
    category: "stellar-sep",
    pathOrUrl: "https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md",
    description: "Challenge-response authentication flow used by enterprise and anchor integrations.",
  },
  {
    id: "ref-soroban-rpc",
    title: "Stellar Soroban RPC Specification",
    category: "external-spec",
    pathOrUrl: "https://developers.stellar.org/docs/data/rpc",
    description: "JSON-RPC methods (`simulateTransaction`, `sendTransaction`, `getEvents`, `getLedgerEntries`) consumed by the transport layer.",
  },
];

/**
 * Validates that the architecture catalog is complete, internally consistent,
 * and covers all required architectural dimensions.
 */
export function validateArchitectureCatalog(): ArchitectureValidationReport {
  const errors: string[] = [];

  if (SDK_ARCHITECTURE_LAYERS.length < 6) {
    errors.push(`Expected at least 6 architecture layers, found ${SDK_ARCHITECTURE_LAYERS.length}`);
  }

  const layerIds = new Set(SDK_ARCHITECTURE_LAYERS.map((l) => l.id));
  let moduleCount = 0;

  for (const layer of SDK_ARCHITECTURE_LAYERS) {
    if (!layer.title || !layer.summary) {
      errors.push(`Layer ${layer.id} is missing title or summary`);
    }
    if (layer.modules.length === 0) {
      errors.push(`Layer ${layer.id} must contain at least one module descriptor`);
    }
    for (const mod of layer.modules) {
      moduleCount++;
      if (!layerIds.has(mod.layer)) {
        errors.push(`Module ${mod.name} references unknown layer ${mod.layer}`);
      }
      if (mod.publicExports.length === 0) {
        errors.push(`Module ${mod.name} must declare at least one public export`);
      }
    }
  }

  for (const adr of SDK_DESIGN_DECISIONS) {
    if (!adr.id.startsWith("ADR-") || !adr.context || !adr.decision || adr.consequences.length === 0) {
      errors.push(`Invalid design decision record: ${adr.id}`);
    }
  }

  for (const diagram of SDK_DIAGRAMS) {
    if (!diagram.mermaidSource.includes(diagram.diagramType)) {
      errors.push(`Diagram ${diagram.id} source does not match declared type ${diagram.diagramType}`);
    }
  }

  for (const ext of SDK_EXTENSION_POINTS) {
    if (ext.lifecycleHooks.length === 0 || !ext.exampleCode.trim()) {
      errors.push(`Extension point ${ext.id} is missing lifecycle hooks or example code`);
    }
  }

  return {
    valid: errors.length === 0,
    layerCount: SDK_ARCHITECTURE_LAYERS.length,
    moduleCount,
    decisionCount: SDK_DESIGN_DECISIONS.length,
    diagramCount: SDK_DIAGRAMS.length,
    apiEntryCount: SDK_API_CATALOG.length,
    extensionPointCount: SDK_EXTENSION_POINTS.length,
    referenceCount: SDK_REFERENCES.length,
    errors,
  };
}

/**
 * Queries architecture descriptors by layer, module path, or extension point ID.
 */
export class ArchitectureRegistry {
  getLayers(): readonly ArchitectureLayerDescriptor[] {
    return SDK_ARCHITECTURE_LAYERS;
  }

  getLayerById(id: ArchitectureLayerId): ArchitectureLayerDescriptor | undefined {
    return SDK_ARCHITECTURE_LAYERS.find((l) => l.id === id);
  }

  getDesignDecisions(): readonly DesignDecisionRecord[] {
    return SDK_DESIGN_DECISIONS;
  }

  getDiagrams(): readonly ArchitectureDiagramDescriptor[] {
    return SDK_DIAGRAMS;
  }

  getApiCatalog(): readonly ApiSurfaceEntry[] {
    return SDK_API_CATALOG;
  }

  getExtensionPoints(): readonly ExtensionPointDescriptor[] {
    return SDK_EXTENSION_POINTS;
  }

  getReferences(): readonly ArchitectureReference[] {
    return SDK_REFERENCES;
  }

  validate(): ArchitectureValidationReport {
    return validateArchitectureCatalog();
  }
}
