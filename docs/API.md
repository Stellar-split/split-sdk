# API Reference

Auto-generated API documentation for @stellar-split/sdk. Total exports: 156

## Table of Contents

- [addRequestInterceptor](#addrequestinterceptor)
- [addResponseInterceptor](#addresponseinterceptor)
- [applyFilter](#applyfilter)
- [BatcherConfig](#batcherconfig)
- [BatchPayment](#batchpayment)
- [builtInNotificationTemplates](#builtinnotificationtemplates)
- [calculateFee](#calculatefee)
- [checkRPCHealth](#checkrpchealth)
- [CircuitBreakerMonitor](#circuitbreakermonitor)
- [CircuitBreakerStatus](#circuitbreakerstatus)
- [clearFeatureCache](#clearfeaturecache)
- [CloneOverrides](#cloneoverrides)
- [CompiledFilter](#compiledfilter)
- [compileFilter](#compilefilter)
- [ComplianceReport](#compliancereport)
- [CompressedPayload](#compressedpayload)
- [CompressionAlgorithm](#compressionalgorithm)
- [CompressionConfig](#compressionconfig)
- [CompressionPayload](#compressionpayload)
- [compressPayload](#compresspayload)
- [connectWallet](#connectwallet)
- [ContractFeatures](#contractfeatures)
- [createCompressionRequestInterceptor](#createcompressionrequestinterceptor)
- [createCompressionResponseInterceptor](#createcompressionresponseinterceptor)
- [CreateInvoiceParams](#createinvoiceparams)
- [createRequestSigningInterceptor](#createrequestsigninginterceptor)
- [DeadlineEngine](#deadlineengine)
- [deadlineFromDays](#deadlinefromdays)
- [DeadlinePassedError](#deadlinepassederror)
- [decompressPayload](#decompresspayload)
- [Deduplicator](#deduplicator)
- [defaultCircuitBreakerMonitor](#defaultcircuitbreakermonitor)
- [detectContractFeatures](#detectcontractfeatures)
- [DIContainer](#dicontainer)
- [diffInvoice](#diffinvoice)
- [diffSimulations](#diffsimulations)
- [EndpointState](#endpointstate)
- [EnrichedInvoice](#enrichedinvoice)
- [enrichInvoice](#enrichinvoice)
- [ExpiryCallback](#expirycallback)
- [ExpiryEvent](#expiryevent)
- [ExportPipeline](#exportpipeline)
- [FallbackChain](#fallbackchain)
- [FallbackExhaustedError](#fallbackexhaustederror)
- [FeeBreakdown](#feebreakdown)
- [FilterCriteria](#filtercriteria)
- [FilterIndex](#filterindex)
- [formatAmount](#formatamount)
- [generateFlowDiagram](#generateflowdiagram)
- [generateGraphQLSchema](#generategraphqlschema)
- [generateMerkleProof](#generatemerkleproof)
- [getInvoiceAtTime](#getinvoiceattime)
- [getOptimisticInvoice](#getoptimisticinvoice)
- [getPublicKey](#getpublickey)
- [getSDKHealth](#getsdkhealth)
- [groupInvoicesByPattern](#groupinvoicesbypattern)
- [HistoricalInvoice](#historicalinvoice)
- [ICacheStore](#icachestore)
- [initPoller](#initpoller)
- [InvalidTransitionError](#invalidtransitionerror)
- [Invoice](#invoice)
- [InvoiceCluster](#invoicecluster)
- [InvoiceDiff](#invoicediff)
- [InvoiceEvent](#invoiceevent)
- [InvoiceEventCallbacks](#invoiceeventcallbacks)
- [InvoiceEventType](#invoiceeventtype)
- [InvoiceExt](#invoiceext)
- [InvoiceFlowFetcher](#invoiceflowfetcher)
- [InvoiceFrozenError](#invoicefrozenerror)
- [InvoiceNotFoundError](#invoicenotfounderror)
- [InvoiceNotPendingError](#invoicenotpendingerror)
- [InvoiceReceipt](#invoicereceipt)
- [InvoiceStatus](#invoicestatus)
- [InvoiceTemplate](#invoicetemplate)
- [IRPCClient](#irpcclient)
- [isExpired](#isexpired)
- [isValidAddress](#isvalidaddress)
- [IWalletAdapter](#iwalletadapter)
- [LoadBalancer](#loadbalancer)
- [LoadBalancerOptions](#loadbalanceroptions)
- [MerkleProof](#merkleproof)
- [MultiplexedClient](#multiplexedclient)
- [MultiTenantClient](#multitenantclient)
- [negotiateVersion](#negotiateversion)
- [NetworkConfig](#networkconfig)
- [NotificationCenter](#notificationcenter)
- [OverflowBehavior](#overflowbehavior)
- [PaginatedResult](#paginatedresult)
- [PaginationOptions](#paginationoptions)
- [parseAmount](#parseamount)
- [parseSorobanError](#parsesorobanerror)
- [Payment](#payment)
- [PaymentAggregator](#paymentaggregator)
- [PaymentExceedsRemainingError](#paymentexceedsremainingerror)
- [PaymentLedger](#paymentledger)
- [PaymentProof](#paymentproof)
- [PaymentSnapshot](#paymentsnapshot)
- [PaymentSnapshotPayer](#paymentsnapshotpayer)
- [PaymentSnapshotPayment](#paymentsnapshotpayment)
- [PaymentSummary](#paymentsummary)
- [PaymentValidation](#paymentvalidation)
- [PayParams](#payparams)
- [PipelineSink](#pipelinesink)
- [PipelineStage](#pipelinestage)
- [pollUSDCBalance](#pollusdcbalance)
- [ProfileReport](#profilereport)
- [ProfilerSession](#profilersession)
- [Recipient](#recipient)
- [registerInvoiceFetcher](#registerinvoicefetcher)
- [registerInvoiceFlowFetcher](#registerinvoiceflowfetcher)
- [registerWebhook](#registerwebhook)
- [renderTemplate](#rendertemplate)
- [replayEvents](#replayevents)
- [RequestBatcher](#requestbatcher)
- [RequestInterceptor](#requestinterceptor)
- [resetSDKHealth](#resetsdkhealth)
- [resolveToken](#resolvetoken)
- [ResourceDelta](#resourcedelta)
- [ResponseInterceptor](#responseinterceptor)
- [RPCRequest](#rpcrequest)
- [RPCResponse](#rpcresponse)
- [ScheduledPayment](#scheduledpayment)
- [ScheduledPaymentManager](#scheduledpaymentmanager)
- [SDK_CONTRACT_VERSION](#sdk_contract_version)
- [SDKHealth](#sdkhealth)
- [signTransaction](#signtransaction)
- [SimpleCache](#simplecache)
- [SimulateCreateInvoiceResult](#simulatecreateinvoiceresult)
- [SimulatePayResult](#simulatepayresult)
- [SimulationDiff](#simulationdiff)
- [SimulationDiffNotComparable](#simulationdiffnotcomparable)
- [SimulationDiffSuccess](#simulationdiffsuccess)
- [StellarSplitClient](#stellarsplitclient)
- [StellarSplitClientConfig](#stellarsplitclientconfig)
- [StellarSplitError](#stellarspliterror)
- [StellarSplitTxBuilder](#stellarsplittxbuilder)
- [telemetry](#telemetry)
- [TelemetryCollector](#telemetrycollector)
- [TelemetryReport](#telemetryreport)
- [TokenInfo](#tokeninfo)
- [TopPayer](#toppayer)
- [triggerWebhook](#triggerwebhook)
- [truncateAddress](#truncateaddress)
- [TxQueue](#txqueue)
- [TxResult](#txresult)
- [validateTransition](#validatetransition)
- [validateWebhookSignature](#validatewebhooksignature)
- [verifyMerkleProof](#verifymerkleproof)
- [VersionInfo](#versioninfo)
- [WalletAdapter](#walletadapter)
- [WalletConnectAdapter](#walletconnectadapter)
- [watchContractUpgrade](#watchcontractupgrade)
- [watchExpiry](#watchexpiry)
- [WebhookConfig](#webhookconfig)
- [WebhookEvent](#webhookevent)
- [WeightedEndpoint](#weightedendpoint)

---

## addRequestInterceptor

**Kind:** `function`

### Signature

```typescript
export function addRequestInterceptor(fn: RequestInterceptor): void {
  requestInterceptors.push(fn);
}
```

---

## addResponseInterceptor

**Kind:** `function`

### Signature

```typescript
export function addResponseInterceptor(fn: ResponseInterceptor): void {
  responseInterceptors.push(fn);
}
```

---

## applyFilter

**Kind:** `function`

### Signature

```typescript
export function applyFilter(invoices: Invoice[], filter: CompiledFilter): Invoice[] {
  return invoices.filter(filter.predicate);
}
```

---

## BatcherConfig

**Kind:** `interface`

Configuration for the request batcher.
/

### Signature

```typescript
export interface BatcherConfig {
  /** Time window in milliseconds to collect requests before batching */
  windowMs: number;
  /** Maximum number of requests to include in a single batch */
  maxBatchSize: number; ...
```

---

## BatchPayment

**Kind:** `interface`

### Signature

```typescript
export interface BatchPayment {
  /** Invoice ID to pay toward. */
  invoiceId: string;
  /** Amount to pay in stroops. */
  amount: bigint; ...
```

---

## builtInNotificationTemplates

**Kind:** `const`

### Signature

```typescript
builtInNotificationTemplates: Record<InvoiceEventType, string> = {
  created: "Invoice {{invoiceId}} was created by {{creator}} for {{amount}}.",
  payment: "Payment of {{amount}} received for invoice {{invoiceId}}.",
  released: "Invoice {{invoiceId}} has been released to recipients.",
  refunded: "Invoice {{invoiceId}} has been refunded by {{creator}}.", ...
```

---

## calculateFee

**Kind:** `function`

Calculate the protocol fee for a given amount.
Fetches the current fee basis points from the contract and computes
the fee and net amounts.

### Signature

```typescript
export async function calculateFee(
  amount: bigint,
  config: StellarSplitClientConfig
): Promise<FeeBreakdown> {
  const rpcUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl; ...
```

### Parameters

| Name | Description |
|------|-------------|
| `amount` | Gross amount in stroops |
| `config` | Client configuration |

### Returns

Fee breakdown with gross, fee, net, and feeBps /

---

## checkRPCHealth

**Kind:** `function`

Check the health of the configured RPC endpoint.

### Signature

```typescript
export async function checkRPCHealth(server: SorobanRpc.Server): Promise<RPCHealth> {
  const startTime = Date.now();

  try {
    const ledger = await server.getLatestLedger(); ...
```

### Parameters

| Name | Description |
|------|-------------|
| `server` | Soroban RPC server instance |

### Returns

Health status with latency and block height /

---

## CircuitBreakerMonitor

**Kind:** `class`

### Signature

```typescript
export class CircuitBreakerMonitor extends EventEmitter {
  private _breakers = new Map<string, BreakerEntry>();

  constructor() {
    super(); ...
```

---

## CircuitBreakerStatus

**Kind:** `interface`

### Signature

```typescript
export interface CircuitBreakerStatus {
  endpoint: string;
  state: CircuitState;
  failureCount: number;
  lastFailure: number | null; ...
```

---

## clearFeatureCache

**Kind:** `function`

### Signature

```typescript
export function clearFeatureCache(): void {
  _cached = null;
}
```

---

## CloneOverrides

**Kind:** `interface`

### Signature

```typescript
export interface CloneOverrides {
  newDeadline?: number;
  newAmounts?: bigint[];
  newRecipients?: string[];
  newOverflowBehavior?: OverflowBehavior; ...
```

---

## CompiledFilter

**Kind:** `interface`

### Signature

```typescript
export interface CompiledFilter {
  predicate: (invoice: Invoice) => boolean;
  criteria: FilterCriteria;
}
```

---

## compileFilter

**Kind:** `function`

### Signature

```typescript
export function compileFilter(criteria: FilterCriteria): CompiledFilter {
  return { predicate: buildPredicate(criteria), criteria };
}
```

---

## ComplianceReport

**Kind:** `interface`

### Signature

```typescript
export interface ComplianceReport {
  passed: boolean;
  violations: string[];
}
```

---

## CompressedPayload

**Kind:** `interface`

### Signature

```typescript
export interface CompressedPayload {
  compressed: true;
  algorithm: CompressionAlgorithm;
  body: Uint8Array;
  originalBytes: number; ...
```

---

## CompressionAlgorithm

**Kind:** `type`

### Signature

```typescript
export type CompressionAlgorithm = "gzip" | "deflate";
```

---

## CompressionConfig

**Kind:** `interface`

### Signature

```typescript
export interface CompressionConfig {
  enabled: boolean;
  algorithm: CompressionAlgorithm;
}
```

---

## CompressionPayload

**Kind:** `type`

### Signature

```typescript
export type CompressionPayload = string | Uint8Array;
```

---

## compressPayload

**Kind:** `function`

### Signature

```typescript
export async function compressPayload(
  payload: CompressionPayload,
  algorithm: CompressionAlgorithm = "gzip"
): Promise<CompressedPayload> {
  const bytes = toBytes(payload); ...
```

---

## connectWallet

**Kind:** `function`

### Signature

```typescript
export async function connectWallet(): Promise<string> {
  const { isConnected: connected } = await isConnected();
  if (!connected) {
    throw new Error(
      "Freighter wallet is not installed. Please install it from https://freighter.app" ...
```

---

## ContractFeatures

**Kind:** `interface`

Feature detection result indicating which contract features are available.
Each field is true if the deployed contract supports the corresponding method.
/

### Signature

```typescript
export interface ContractFeatures {
  batchPay: boolean;
  cloneInvoice: boolean;
  invoiceGroups: boolean;
  templates: boolean; ...
```

---

## createCompressionRequestInterceptor

**Kind:** `function`

### Signature

```typescript
export function createCompressionRequestInterceptor(config: CompressionConfig): RequestInterceptor {
  return async (req) => {
    if (!config.enabled) {
      return req;
    } ...
```

---

## createCompressionResponseInterceptor

**Kind:** `function`

### Signature

```typescript
export function createCompressionResponseInterceptor(_config: CompressionConfig): ResponseInterceptor {
  return async (res) => {
    if (!isCompressedPayload(res.result)) {
      return res;
    } ...
```

---

## CreateInvoiceParams

**Kind:** `interface`

### Signature

```typescript
export interface CreateInvoiceParams {
  /** Stellar address of the creator (must sign). */
  creator: string;
  /** Recipients and their owed amounts. */
  recipients: Recipient[]; ...
```

---

## createRequestSigningInterceptor

**Kind:** `function`

### Signature

```typescript
export function createRequestSigningInterceptor(keypair: Keypair): RequestInterceptor {
  return async (req: RPCRequest): Promise<RPCRequest> => {
    const timestamp = Date.now();
    const message = `stellar-split:${timestamp}`;
    // Keypair.sign accepts Uint8Array / Buffer ...
```

---

## DeadlineEngine

**Kind:** `class`

### Signature

```typescript
export class DeadlineEngine {
  private interval: TimeoutLike | null = null;

  private readonly intervalMs: number;
  private destroyed = false; ...
```

---

## deadlineFromDays

**Kind:** `function`

Return a Unix timestamp (seconds) for a date that is `days` from now.
/

### Signature

```typescript
export function deadlineFromDays(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 86_400;
}
```

---

## DeadlinePassedError

**Kind:** `class`

### Signature

```typescript
export class DeadlinePassedError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice deadline has passed: ${invoiceId}`, raw); ...
```

---

## decompressPayload

**Kind:** `function`

### Signature

```typescript
export async function decompressPayload(payload: CompressedPayload): Promise<Uint8Array> {
  return isDecompressionStreamAvailable()
    ? await decompressInBrowser(payload.body, payload.algorithm)
    : await decompressInNode(payload.body, payload.algorithm);
}
```

---

## Deduplicator

**Kind:** `class`

### Signature

```typescript
export class Deduplicator<T> {
  private _inflight = new Map<string, Promise<T>>();
  private _hits = 0;
  private _misses = 0;
 ...
```

---

## defaultCircuitBreakerMonitor

**Kind:** `const`

### Signature

```typescript
defaultCircuitBreakerMonitor = new CircuitBreakerMonitor()
```

---

## detectContractFeatures

**Kind:** `function`

Detect which optional features the deployed Soroban contract supports.
The result is cached for 5 minutes. Call `clearFeatureCache()` to reset.

### Signature

```typescript
export async function detectContractFeatures(
  config: StellarSplitClientConfig,
  source?: string,
): Promise<ContractFeatures> {
  // Return cached result if still valid ...
```

### Parameters

| Name | Description |
|------|-------------|
| `config` | StellarSplit client configuration (must include rpcUrl, contractId, networkPassphrase). |
| `source` | A valid Stellar public key (G...) to use as the simulation source. Defaults to a well-known testnet address if omitted. |

### Returns

A `ContractFeatures` object with booleans for each optional feature. /

---

## DIContainer

**Kind:** `class`

### Signature

```typescript
export class DIContainer {
  private rpcClient?: IRPCClient;
  private cacheStore?: ICacheStore<Invoice>;
  private walletAdapter?: IWalletAdapter;
 ...
```

---

## diffInvoice

**Kind:** `function`

### Signature

```typescript
export function diffInvoice(oldInvoice: Invoice, newInvoice: Invoice): InvoiceDiff {
  const changed: InvoiceDiff["changed"] = [];

  for (const key of INVOICE_KEYS) {
    const oldVal = oldInvoice[key]; ...
```

---

## diffSimulations

**Kind:** `function`

Diff two `SimulateTransactionResponse` objects.
If either response is an error or a restore response, returns
`{ comparable: false }` instead of throwing.
/

### Signature

```typescript
export function diffSimulations(
  before: SorobanRpc.Api.SimulateTransactionResponse,
  after: SorobanRpc.Api.SimulateTransactionResponse,
): SimulationDiff {
  if (SorobanRpc.Api.isSimulationError(before)) { ...
```

---

## EndpointState

**Kind:** `interface`

### Signature

```typescript
export interface EndpointState {
  url: string;
  healthy: boolean;
  averageLatencyMs: number | null;
  consecutiveFailures: number; ...
```

---

## EnrichedInvoice

**Kind:** `interface`

### Signature

```typescript
export interface EnrichedInvoice extends Invoice {
  metadata: Record<string, unknown> | null;
}
```

---

## enrichInvoice

**Kind:** `function`

### Signature

```typescript
export async function enrichInvoice(
  invoiceId: string,
  getInvoice?: InvoiceFetcher
): Promise<EnrichedInvoice> {
  const fetcher = getInvoice ?? invoiceFetcher; ...
```

---

## ExpiryCallback

**Kind:** `type`

### Signature

```typescript
export type ExpiryCallback = (event: ExpiryEvent) => void;
```

---

## ExpiryEvent

**Kind:** `interface`

### Signature

```typescript
export interface ExpiryEvent {
  /** Invoice ID. */
  invoiceId: string;
  /** Unix timestamp deadline (seconds). */
  deadline: number; ...
```

---

## ExportPipeline

**Kind:** `class`

### Signature

```typescript
export class ExportPipeline {
  private filters: Array<PipelineStage<Invoice[]>> = [];
  private transforms: Array<PipelineStage<Invoice[]>> = [];
  private formatters: Array<PipelineStage<Invoice[]>> = [];
  private sinks: PipelineSink[] = []; ...
```

---

## FallbackChain

**Kind:** `class`

### Signature

```typescript
export class FallbackChain {
  private readonly urls: string[];
  private readonly logger: FallbackFailureLogger;

  constructor(urls: string[], options?: { logger?: FallbackFailureLogger }) { ...
```

---

## FallbackExhaustedError

**Kind:** `class`

### Signature

```typescript
export class FallbackExhaustedError extends Error {
  public readonly attempts: FallbackAttemptLog[];

  constructor(attempts: FallbackAttemptLog[]) {
    super(`Fallback chain exhausted after ${attempts.length} attempts.`); ...
```

---

## FeeBreakdown

**Kind:** `interface`

### Signature

```typescript
export interface FeeBreakdown {
  /** Gross amount before fee deduction. */
  gross: bigint;
  /** Protocol fee amount. */
  fee: bigint; ...
```

---

## FilterCriteria

**Kind:** `interface`

### Signature

```typescript
export interface FilterCriteria {
  and?: FilterCriteria[];
  or?: FilterCriteria[];
  status?: InvoiceStatus;
  creator?: string; ...
```

---

## FilterIndex

**Kind:** `class`

### Signature

```typescript
export class FilterIndex {
  private statusIndex = new Map<string, Set<Invoice>>();
  private creatorIndex = new Map<string, Set<Invoice>>();
  private tokenIndex = new Map<string, Set<Invoice>>();
  private invoicesRef: Invoice[] | null = null; ...
```

---

## formatAmount

**Kind:** `function`

Format a stroop amount as a human-readable USDC string.

### Signature

```typescript
export function formatAmount(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = stroops % STROOPS_PER_UNIT;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}
```

### Examples

```typescript
formatAmount(10_000_000n) // "1.0000000"
/
```

---

## generateFlowDiagram

**Kind:** `function`

### Signature

```typescript
export async function generateFlowDiagram(
  invoiceId: string,
  getInvoice?: InvoiceFlowFetcher
): Promise<string> {
  const fetcher = getInvoice ?? invoiceFlowFetcher; ...
```

---

## generateGraphQLSchema

**Kind:** `function`

generateGraphQLSchema — builds a GraphQL SDL string from SDK TypeScript interfaces.
Type mapping:
bigint  → String  (GraphQL has no native 64-bit int)
string  → String
number  → Int
boolean → Boolean
/

### Signature

```typescript
export function generateGraphQLSchema(): string {
  return `
type Recipient {
  address: String!
  amount: String! ...
```

---

## generateMerkleProof

**Kind:** `function`

Generate a Merkle proof for a specific payment within an invoice.

### Signature

```typescript
export async function generateMerkleProof(
  invoiceId: string,
  paymentIndex: number
): Promise<MerkleProof> {
  // In a real implementation, this would: ...
```

### Parameters

| Name | Description |
|------|-------------|
| `invoiceId` | The invoice ID |
| `paymentIndex` | The index of the payment in the invoice's payments array |

### Returns

A Merkle proof object /

---

## getInvoiceAtTime

**Kind:** `function`

### Signature

```typescript
export async function getInvoiceAtTime(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: string,
  timestamp: number ...
```

---

## getOptimisticInvoice

**Kind:** `function`

Get an optimistically updated invoice reflecting a pending payment.
Returns a new invoice object with the payment applied immediately,
without waiting for on-chain confirmation. Does not mutate the input.

### Signature

```typescript
export function getOptimisticInvoice(invoice: Invoice, payment: Payment): Invoice {
  const newFunded = invoice.funded + payment.amount;
  const newPayments = [...invoice.payments, payment];
  const newStatus =
    newFunded >= invoice.recipients.reduce((sum, r) => sum + r.amount, 0n) ...
```

### Parameters

| Name | Description |
|------|-------------|
| `invoice` | The current invoice state |
| `payment` | The pending payment to apply |

### Returns

A new invoice with the payment applied /

---

## getPublicKey

**Kind:** `function`

### Signature

```typescript
export async function getPublicKey(): Promise<string> {
  const { isConnected: connected } = await isConnected();
  if (!connected) {
    throw new Error("Freighter wallet is not connected.");
  } ...
```

---

## getSDKHealth

**Kind:** `function`

### Signature

```typescript
export async function getSDKHealth(): Promise<SDKHealth> {
  const latencyStart = Date.now();
  let rpcLatency = 0;

  if (serverRef) { ...
```

---

## groupInvoicesByPattern

**Kind:** `function`

### Signature

```typescript
export function groupInvoicesByPattern(invoices: Invoice[]): InvoiceCluster[] {
  if (invoices.length === 0) {
    return [];
  }
 ...
```

---

## HistoricalInvoice

**Kind:** `interface`

### Signature

```typescript
export interface HistoricalInvoice {
  reconstructedAt: number;
}
```

---

## ICacheStore

**Kind:** `interface`

### Signature

```typescript
export interface ICacheStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  invalidate(key: string): void;
  clear(): void; ...
```

---

## initPoller

**Kind:** `function`

Initialize the poller with RPC configuration.
Must be called before using pollUSDCBalance.
/

### Signature

```typescript
export function initPoller(rpcUrl: string, networkPassphrase: string): void {
  pollerServer = new SorobanRpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });
}
```

---

## InvalidTransitionError

**Kind:** `class`

### Signature

```typescript
export class InvalidTransitionError extends Error {
  constructor(from: InvoiceStatus, to: InvoiceStatus) {
    super(`Invalid transition from "${from}" to "${to}"`);
    this.name = "InvalidTransitionError";
  } ...
```

---

## Invoice

**Kind:** `interface`

### Signature

```typescript
export interface Invoice {
  /** Invoice ID (u64 from the contract). */
  id: string;
  /** Address that created the invoice. */
  creator: string; ...
```

---

## InvoiceCluster

**Kind:** `interface`

### Signature

```typescript
export interface InvoiceCluster {
  label: string;
  invoices: Invoice[];
  similarity: number;
}
```

---

## InvoiceDiff

**Kind:** `interface`

### Signature

```typescript
export interface InvoiceDiff {
  changed: Array<{
    field: string;
    from: unknown;
    to: unknown; ...
```

---

## InvoiceEvent

**Kind:** `interface`

### Signature

```typescript
export interface InvoiceEvent {
  type: InvoiceEventType;
  invoiceId: string;
  amount?: bigint | number | string;
  creator?: string; ...
```

---

## InvoiceEventCallbacks

**Kind:** `interface`

### Signature

```typescript
export interface InvoiceEventCallbacks {
  /** Fired when a payment event is detected. */
  onPayment?: (payment: Payment) => void;
  /** Fired when the invoice status changes to Released. */
  onReleased?: () => void; ...
```

---

## InvoiceEventType

**Kind:** `type`

### Signature

```typescript
export type InvoiceEventType = "created" | "payment" | "released" | "refunded" | "expiring";
```

---

## InvoiceExt

**Kind:** `interface`

### Signature

```typescript
export interface InvoiceExt {
  parentInvoiceId: string | null;
  cloneDepth: number;
}
```

---

## InvoiceFlowFetcher

**Kind:** `type`

### Signature

```typescript
export type InvoiceFlowFetcher = (invoiceId: string) => Promise<Invoice>;
```

---

## InvoiceFrozenError

**Kind:** `class`

### Signature

```typescript
export class InvoiceFrozenError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice is frozen: ${invoiceId}`, raw); ...
```

---

## InvoiceNotFoundError

**Kind:** `class`

### Signature

```typescript
export class InvoiceNotFoundError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice not found: ${invoiceId}`, raw ?? `Invoice not found: ${invoiceId}`); ...
```

---

## InvoiceNotPendingError

**Kind:** `class`

### Signature

```typescript
export class InvoiceNotPendingError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice is not in Pending state: ${invoiceId}`, raw); ...
```

---

## InvoiceReceipt

**Kind:** `interface`

### Signature

```typescript
export interface InvoiceReceipt {
  /** Deterministic receipt identifier. */
  receiptId: string;
  /** Invoice ID this receipt belongs to. */
  invoiceId: string; ...
```

---

## InvoiceStatus

**Kind:** `type`

### Signature

```typescript
export type InvoiceStatus = "Pending" | "Released" | "Refunded" | "Cancelled";
```

---

## InvoiceTemplate

**Kind:** `interface`

### Signature

```typescript
export interface InvoiceTemplate {
  /** Template name. */
  name: string;
  /** Recipients and their owed amounts. */
  recipients: Recipient[]; ...
```

---

## IRPCClient

**Kind:** `interface`

### Signature

```typescript
export interface IRPCClient extends SorobanRpc.Server {
  getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse>;
  close?(): Promise<void> | void;
}
```

---

## isExpired

**Kind:** `function`

Return true if a Unix timestamp deadline has passed.
/

### Signature

```typescript
export function isExpired(deadline: number): boolean {
  return Math.floor(Date.now() / 1000) > deadline;
}
```

---

## isValidAddress

**Kind:** `function`

Validate a Stellar public key (G... address).
Uses a simple regex; for full validation use stellar-sdk StrKey.
/

### Signature

```typescript
export function isValidAddress(address: string): boolean {
  return /^G[A-Z2-7]{54,55}$/.test(address);
}
```

---

## IWalletAdapter

**Kind:** `interface`

### Signature

```typescript
export interface IWalletAdapter {
  getAddress(): Promise<string>;
  signTransaction(xdr: string, network: string): Promise<string>;
}
```

---

## LoadBalancer

**Kind:** `class`

### Signature

```typescript
export class LoadBalancer {
  private readonly endpoints: MutableEndpointState[];
  private readonly maxLatencySamples: number;
  private readonly failureThreshold: number;
  private readonly reprobeIntervalMs: number; ...
```

---

## LoadBalancerOptions

**Kind:** `interface`

### Signature

```typescript
export interface LoadBalancerOptions {
  maxLatencySamples?: number;
  failureThreshold?: number;
  reprobeIntervalMs?: number;
  now?: () => number; ...
```

---

## MerkleProof

**Kind:** `interface`

Merkle proof structure for invoice payment verification.
/

### Signature

```typescript
export interface MerkleProof {
  /** The leaf hash being proven (payment hash) */
  leaf: string;
  /** Sibling hashes along the path to the root */
  path: string[]; ...
```

---

## MultiplexedClient

**Kind:** `class`

MultiplexedClient distributes requests across multiple RPC endpoints
using weighted round-robin load balancing based on endpoint health scores.
/

### Signature

```typescript
export class MultiplexedClient {
  private endpoints: WeightedEndpoint[];
  private currentWeights: number[];
  private healthScores: number[];
   ...
```

---

## MultiTenantClient

**Kind:** `class`

### Signature

```typescript
export class MultiTenantClient {
  private readonly clients = new Map<string, StellarSplitClient>();
  private readonly clientFactory: (tenantId: string) => StellarSplitClientConfig;

  constructor(clientFactory: (tenantId: string) => StellarSplitClientConfig) { ...
```

---

## negotiateVersion

**Kind:** `function`

Reads the contract's on-chain `get_version()` and compares it against
{@link SDK_CONTRACT_VERSION}.
- `compatible: true`  — major versions match.
- `compatible: false` — major versions differ (incompatible ABI).
- Logs a warning when minor versions differ (compatible but potentially stale).
/

### Signature

```typescript
export async function negotiateVersion(
  config: StellarSplitClientConfig
): Promise<VersionInfo> {
  const rpcUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl;
  const server = new SorobanRpc.Server(rpcUrl, { ...
```

---

## NetworkConfig

**Kind:** `interface`

### Signature

```typescript
export interface NetworkConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string; ...
```

---

## NotificationCenter

**Kind:** `class`

### Signature

```typescript
export class NotificationCenter extends EventEmitter {
  private _watchers = new Map<string, NodeJS.Timeout>();
  private _fetchInvoice: (invoiceId: string) => Promise<Invoice>;

  constructor(fetchInvoice: (invoiceId: string) => Promise<Invoice>) { ...
```

---

## OverflowBehavior

**Kind:** `type`

### Signature

```typescript
export type OverflowBehavior = "refund" | "rollback" | "escalate";
```

---

## PaginatedResult

**Kind:** `interface`

### Signature

```typescript
export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}
```

---

## PaginationOptions

**Kind:** `interface`

### Signature

```typescript
export interface PaginationOptions {
  /** Cursor (invoice ID) to start after. */
  cursor?: string;
  /** Maximum number of items to return. Defaults to 20. */
  limit?: number; ...
```

---

## parseAmount

**Kind:** `function`

Parse a human-readable USDC string into stroops.

### Signature

```typescript
export function parseAmount(value: string): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fracPadded);
}
```

### Examples

```typescript
parseAmount("1.5") // 15_000_000n
/
```

---

## parseSorobanError

**Kind:** `function`

Parse a raw Soroban error string and return the appropriate typed error.

### Signature

```typescript
export function parseSorobanError(raw: string, invoiceId: string = ""): StellarSplitError {
  for (const { pattern, factory } of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return factory(invoiceId, raw);
    } ...
```

### Parameters

| Name | Description |
|------|-------------|
| `raw` | The raw error message from the RPC. |
| `invoiceId` | The invoice ID involved in the operation, if known. |

### Returns

A typed StellarSplitError subclass, or a generic StellarSplitError. /

---

## Payment

**Kind:** `interface`

### Signature

```typescript
export interface Payment {
  /** Stellar address of the payer. */
  payer: string;
  /** Amount paid in stroops (1 XLM = 10_000_000 stroops). */
  amount: bigint; ...
```

---

## PaymentAggregator

**Kind:** `class`

### Signature

```typescript
export class PaymentAggregator {
  public totalFunded: bigint;
  public percentFunded: number;
  public readonly payerBreakdown: Map<string, bigint>;
  public paymentCount: number; ...
```

---

## PaymentExceedsRemainingError

**Kind:** `class`

### Signature

```typescript
export class PaymentExceedsRemainingError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Payment exceeds remaining balance for invoice: ${invoiceId}`, raw); ...
```

---

## PaymentLedger

**Kind:** `type`

### Signature

```typescript
export type PaymentLedger = Payment & { ledger: number };
```

---

## PaymentProof

**Kind:** `interface`

### Signature

```typescript
export interface PaymentProof {
  /** Transaction hash. */
  txHash: string;
  /** Payer's Stellar address. */
  payer: string; ...
```

---

## PaymentSnapshot

**Kind:** `interface`

### Signature

```typescript
export interface PaymentSnapshot {
  snapshotId: string;
  capturedAt: number;
  invoiceId: string;
  invoiceTotal: string; ...
```

---

## PaymentSnapshotPayer

**Kind:** `interface`

### Signature

```typescript
export interface PaymentSnapshotPayer {
  address: string;
  amount: string;
}
```

---

## PaymentSnapshotPayment

**Kind:** `interface`

### Signature

```typescript
export interface PaymentSnapshotPayment {
  payer: string;
  amount: string;
  ledger: number;
  timestamp?: number; ...
```

---

## PaymentSummary

**Kind:** `interface`

### Signature

```typescript
export interface PaymentSummary {
  totalFunded: bigint;
  percentFunded: number;
  payerBreakdown: Map<string, bigint>;
  paymentCount: number; ...
```

---

## PaymentValidation

**Kind:** `interface`

### Signature

```typescript
export interface PaymentValidation {
  valid: boolean;
  errors: string[];
}
```

---

## PayParams

**Kind:** `interface`

### Signature

```typescript
export interface PayParams {
  /** Stellar address of the payer (must sign). */
  payer: string;
  /** Invoice ID to pay toward. */
  invoiceId: string; ...
```

---

## PipelineSink

**Kind:** `type`

A sink consumes the final formatted output string.
/

### Signature

```typescript
export type PipelineSink = (output: string) => void | Promise<void>;
```

---

## PipelineStage

**Kind:** `type`

A pipeline stage receives an invoice and may return a transformed value
(sync or async).
/

### Signature

```typescript
export type PipelineStage<T> = (input: T) => T | Promise<T>;
```

---

## pollUSDCBalance

**Kind:** `function`

Poll a wallet's USDC balance and invoke callback when it changes.

### Signature

```typescript
export function pollUSDCBalance(
  address: string,
  callback: (balance: bigint) => void,
  intervalMs: number = 10000
): () => void { ...
```

### Parameters

| Name | Description |
|------|-------------|
| `address` | Stellar address to monitor |
| `callback` | Function invoked with new balance when it changes |
| `intervalMs` | Poll interval in milliseconds (default: 10000) |

### Returns

Cleanup function to stop polling /

---

## ProfileReport

**Kind:** `interface`

### Signature

```typescript
export interface ProfileReport {
  sessions: ProfileSession[];
}
```

---

## ProfilerSession

**Kind:** `class`

### Signature

```typescript
export class ProfilerSession {
  private sessions: ProfileSession[] = [];
  private active = false;
  private currentEntries: ProfileEntry[] = [];
  private currentStartedAt = 0; ...
```

---

## Recipient

**Kind:** `interface`

### Signature

```typescript
export interface Recipient {
  /** Stellar address of the recipient. */
  address: string;
  /** Amount owed in stroops. */
  amount: bigint; ...
```

---

## registerInvoiceFetcher

**Kind:** `function`

### Signature

```typescript
export function registerInvoiceFetcher(fetcher: InvoiceFetcher): void {
  invoiceFetcher = fetcher;
}
```

---

## registerInvoiceFlowFetcher

**Kind:** `function`

### Signature

```typescript
export function registerInvoiceFlowFetcher(fetcher: InvoiceFlowFetcher): void {
  invoiceFlowFetcher = fetcher;
}
```

---

## registerWebhook

**Kind:** `function`

### Signature

```typescript
export function registerWebhook(
  invoiceId: string,
  url: string,
  events: WebhookEvent[],
): void { ...
```

---

## renderTemplate

**Kind:** `function`

### Signature

```typescript
export function renderTemplate(event: InvoiceEvent, template?: string): string {
  const source = template ?? builtInNotificationTemplates[event.type];
  const values: Record<"invoiceId" | "amount" | "creator", string> = {
    invoiceId: event.invoiceId,
    amount: stringifyTemplateValue(event.amount), ...
```

---

## replayEvents

**Kind:** `function`

Replay historical contract events in a ledger range.

### Signature

```typescript
export async function replayEvents(
  server: SorobanRpc.Server,
  contractId: string,
  fromLedger: number,
  toLedger: number ...
```

### Parameters

| Name | Description |
|------|-------------|
| `server` | Soroban RPC server |
| `contractId` | The contract ID to filter events |
| `fromLedger` | Starting ledger sequence |
| `toLedger` | Ending ledger sequence |

### Returns

Array of contract events in chronological order /

---

## RequestBatcher

**Kind:** `class`

RequestBatcher collects read requests within a configurable time window
and submits them as a single batch RPC call.
/

### Signature

```typescript
export class RequestBatcher {
  private pendingRequests: Array<{
    invoiceId: string;
    resolve: (invoice: Invoice) => void;
    reject: (error: Error) => void; ...
```

---

## RequestInterceptor

**Kind:** `type`

### Signature

```typescript
export type RequestInterceptor = (req: RPCRequest) => RPCRequest | Promise<RPCRequest>;
```

---

## resetSDKHealth

**Kind:** `function`

### Signature

```typescript
export function resetSDKHealth(): void {
  totalCalls = 0;
  errorCalls = 0;
  startTime = Date.now();
}
```

---

## resolveToken

**Kind:** `function`

Resolve token metadata from a SAC contract address.
Fetches symbol, name, and decimals from the contract and caches results.

### Signature

```typescript
export async function resolveToken(
  address: string,
  config: StellarSplitClientConfig
): Promise<TokenInfo> {
  // Check cache first ...
```

### Parameters

| Name | Description |
|------|-------------|
| `address` | Token contract address |
| `config` | Client configuration |

### Returns

Token metadata /

---

## ResourceDelta

**Kind:** `interface`

### Signature

```typescript
export interface ResourceDelta {
  /** Difference in CPU instructions (after − before). */
  cpuInstructions: bigint;
  /** Difference in read-bytes (after − before). */
  readBytes: bigint; ...
```

---

## ResponseInterceptor

**Kind:** `type`

### Signature

```typescript
export type ResponseInterceptor = (res: RPCResponse) => RPCResponse | Promise<RPCResponse>;
```

---

## RPCRequest

**Kind:** `interface`

### Signature

```typescript
export interface RPCRequest {
  method: string;
  params: unknown[];
}
```

---

## RPCResponse

**Kind:** `interface`

### Signature

```typescript
export interface RPCResponse {
  method: string;
  result: unknown;
  durationMs: number;
}
```

---

## ScheduledPayment

**Kind:** `interface`

### Signature

```typescript
export interface ScheduledPayment {
  id: string;
  invoiceId: string;
  amount: bigint;
  executeAt: number; ...
```

---

## ScheduledPaymentManager

**Kind:** `class`

### Signature

```typescript
export class ScheduledPaymentManager {
  private _payments: ScheduledPayment[] = load();
  private _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private _pay: PayFn;
 ...
```

---

## SDK_CONTRACT_VERSION

**Kind:** `const`

### Signature

```typescript
SDK_CONTRACT_VERSION = "1.0.0"
```

---

## SDKHealth

**Kind:** `interface`

### Signature

```typescript
export interface SDKHealth {
  rpcLatency: number;
  cacheHitRate: number;
  errorRate: number;
  uptimeMs: number; ...
```

---

## signTransaction

**Kind:** `function`

Sign a Stellar transaction XDR string using Freighter.

### Signature

```typescript
export async function signTransaction(
  xdr: string,
  network: string
): Promise<string> {
  const result = await freighterSignTransaction(xdr, { networkPassphrase: network }); ...
```

### Parameters

| Name | Description |
|------|-------------|
| `xdr` | Base64-encoded transaction XDR. |
| `network` | Network passphrase (e.g. "Test SDF Network ; September 2015"). |

### Returns

Signed transaction XDR. /

---

## SimpleCache

**Kind:** `class`

### Signature

```typescript
export class SimpleCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) { ...
```

---

## SimulateCreateInvoiceResult

**Kind:** `interface`

### Signature

```typescript
export interface SimulateCreateInvoiceResult {
  /** The invoice ID that would be created. */
  invoiceId: string;
  /** Estimated fee in stroops. */
  fee: string; ...
```

---

## SimulatePayResult

**Kind:** `interface`

### Signature

```typescript
export interface SimulatePayResult {
  /** Estimated fee in stroops. */
  fee: string;
}
```

---

## SimulationDiff

**Kind:** `type`

### Signature

```typescript
export type SimulationDiff = SimulationDiffSuccess | SimulationDiffNotComparable;
```

---

## SimulationDiffNotComparable

**Kind:** `interface`

### Signature

```typescript
export interface SimulationDiffNotComparable {
  comparable: false;
  reason: string;
}
```

---

## SimulationDiffSuccess

**Kind:** `interface`

### Signature

```typescript
export interface SimulationDiffSuccess {
  comparable: true;
  /** Difference in minResourceFee expressed in stroops (after − before). */
  feeDelta: bigint;
  /** Number of diagnostic events that appear only in `after`. */ ...
```

---

## StellarSplitClient

**Kind:** `class`

### Signature

```typescript
export class StellarSplitClient {
  private _mainServer!: SorobanRpc.Server;
  private _standby: WarmStandby | null = null;
  private _queue = new PriorityQueue();
  private contract: Contract; ...
```

---

## StellarSplitClientConfig

**Kind:** `interface`

### Signature

```typescript
export interface StellarSplitClientConfig {
  /** Soroban RPC endpoint URL. Pass an array to enable warm-standby failover. */
  rpcUrl: string | string[];
  /** Stellar network passphrase. */
  networkPassphrase: string; ...
```

---

## StellarSplitError

**Kind:** `class`

### Signature

```typescript
export class StellarSplitError extends Error {
  /** The raw error string from the Soroban RPC, if available. */
  readonly raw: string;

  constructor(message: string, raw: string = message) { ...
```

---

## StellarSplitTxBuilder

**Kind:** `class`

### Signature

```typescript
export class StellarSplitTxBuilder {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly config: StellarSplitClientConfig;
  private readonly sourceAddress: string; ...
```

---

## telemetry

**Kind:** `const`

### Signature

```typescript
telemetry = new Telemetry()
```

---

## TelemetryCollector

**Kind:** `class`

### Signature

```typescript
export class TelemetryCollector {
  private startTime = Date.now();
  private methods = new Map<string, MethodMetrics>();
  private readonly windowSize = 100;
 ...
```

---

## TelemetryReport

**Kind:** `interface`

### Signature

```typescript
export interface TelemetryReport {
  period: number;
  methods: Record<string, MethodLatencyReport>;
}
```

---

## TokenInfo

**Kind:** `interface`

### Signature

```typescript
export interface TokenInfo {
  /** Token contract address. */
  address: string;
  /** Token symbol (e.g., "USDC"). */
  symbol: string; ...
```

---

## TopPayer

**Kind:** `interface`

### Signature

```typescript
export interface TopPayer {
  address: string;
  amount: bigint;
}
```

---

## triggerWebhook

**Kind:** `function`

### Signature

```typescript
export async function triggerWebhook(
  invoiceId: string,
  event: WebhookEvent,
  data: unknown,
): Promise<void> { ...
```

---

## truncateAddress

**Kind:** `function`

Truncate a Stellar address for display: "GABC...XYZ".
/

### Signature

```typescript
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
```

---

## TxQueue

**Kind:** `class`

### Signature

```typescript
export class TxQueue {
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  private sourceAddress: string;
  private queue: Promise<TxResult> = Promise.resolve({ txHash: "" }); ...
```

---

## TxResult

**Kind:** `interface`

### Signature

```typescript
export interface TxResult {
  txHash: string;
}
```

---

## validateTransition

**Kind:** `function`

### Signature

```typescript
export function validateTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  } ...
```

---

## validateWebhookSignature

**Kind:** `function`

### Signature

```typescript
export async function validateWebhookSignature(
  payload: unknown,
  signature: string,
  secret: string
): Promise<boolean> { ...
```

---

## verifyMerkleProof

**Kind:** `function`

Verify a Merkle proof against a given root hash.

### Signature

```typescript
export function verifyMerkleProof(proof: MerkleProof): boolean {
  // In a real implementation, this would:
  // 1. Recompute the root hash from the leaf and path
  // 2. Compare the computed root with the provided root
   ...
```

### Parameters

| Name | Description |
|------|-------------|
| `proof` | The Merkle proof to verify |

### Returns

true if the proof is valid, false otherwise /

---

## VersionInfo

**Kind:** `interface`

### Signature

```typescript
export interface VersionInfo {
  contractVersion: string;
  sdkVersion: string;
  compatible: boolean;
}
```

---

## WalletAdapter

**Kind:** `interface`

### Signature

```typescript
export interface WalletAdapter {
  /** Return the wallet's public key (G... address). */
  getAddress(): Promise<string>;
  /**
   * Sign a transaction XDR string. ...
```

---

## WalletConnectAdapter

**Kind:** `class`

WalletConnect adapter — routes signing through a WalletConnect session
instead of the Freighter browser extension.
/

### Signature

```typescript
export class WalletConnectAdapter implements WalletAdapter {
  private readonly opts: WalletConnectAdapterOptions;

  constructor(opts: WalletConnectAdapterOptions) {
    this.opts = opts; ...
```

---

## watchContractUpgrade

**Kind:** `function`

Watch for contract WASM upgrades and invoke callback when detected.
Polls the contract's WASM hash every 60 seconds. When a change is detected,
invokes the callback with the upgrade event.

### Signature

```typescript
export function watchContractUpgrade(
  server: SorobanRpc.Server,
  contractId: string,
  callback: (event: UpgradeEvent) => void
): () => void { ...
```

### Parameters

| Name | Description |
|------|-------------|
| `server` | Soroban RPC server instance |
| `contractId` | The contract ID to watch |
| `callback` | Function to invoke when upgrade is detected |

### Returns

Cleanup function that stops polling /

---

## watchExpiry

**Kind:** `function`

Watch an invoice for expiry and fire a callback when approaching deadline.
Polls the invoice deadline and fires the callback when the deadline is within
the warning window or has passed.

### Signature

```typescript
export function watchExpiry(
  invoiceId: string,
  client: StellarSplitClient,
  callback: ExpiryCallback,
  warningSeconds: number = 3600 ...
```

### Parameters

| Name | Description |
|------|-------------|
| `invoiceId` | Invoice ID to watch |
| `client` | StellarSplitClient instance |
| `callback` | Function to call when expiry event occurs |
| `warningSeconds` | Seconds before deadline to trigger callback (default: 3600) |

### Returns

Cleanup function to stop polling /

---

## WebhookConfig

**Kind:** `type`

### Signature

```typescript
export type WebhookConfig = {
  url: string;
  events: WebhookEvent[];
};
```

---

## WebhookEvent

**Kind:** `type`

### Signature

```typescript
export type WebhookEvent = "payment" | "released" | "refunded";
```

---

## WeightedEndpoint

**Kind:** `interface`

Weighted endpoint configuration for load balancing.
/

### Signature

```typescript
export interface WeightedEndpoint {
  /** RPC endpoint URL */
  url: string;
  /** Weight for this endpoint (higher = more requests) */
  weight: number; ...
```

---

