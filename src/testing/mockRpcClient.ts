/**
 * MockRpcClient — in-process RpcClient implementation for unit testing.
 * Exported from @stellar-split/sdk/testing.
 *
 * All methods return configurable responses without making network calls.
 * Set up responses before calling SDK methods under test.
 */

import type { RpcClient } from "../rpcClient.js";
import type { rpc as SorobanRpc, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { Account } from "@stellar/stellar-sdk";

type SimulateResponse = SorobanRpc.Api.SimulateTransactionResponse;
type SendResponse = SorobanRpc.Api.SendTransactionResponse;
type GetTxResponse = SorobanRpc.Api.GetTransactionResponse;
type GetEventsResponse = SorobanRpc.Api.GetEventsResponse;
type GetLatestLedgerResponse = SorobanRpc.Api.GetLatestLedgerResponse;
type GetFeeStatsResponse = SorobanRpc.Api.GetFeeStatsResponse;

export interface MockRpcClientOptions {
  /** Default simulate response (can be overridden per-call by `simulateResponses`). */
  defaultSimulateResponse?: SimulateResponse;
  /** Default send response. */
  defaultSendResponse?: SendResponse;
  /** Default getTransaction response. */
  defaultGetTransactionResponse?: GetTxResponse;
  /** Default getEvents response. */
  defaultGetEventsResponse?: GetEventsResponse;
  /** Default getLatestLedger response. */
  defaultGetLatestLedgerResponse?: GetLatestLedgerResponse;
  /** Default getFeeStats response. */
  defaultGetFeeStatsResponse?: GetFeeStatsResponse;
  /** Network passphrase for Account objects (default: "Test SDF Network ; September 2015"). */
  networkPassphrase?: string;
}

export class MockRpcClient implements RpcClient {
  private _simulateQueue: Array<SimulateResponse | Error> = [];
  private _sendQueue: Array<SendResponse | Error> = [];
  private _getTxQueue: Array<GetTxResponse | Error> = [];

  private _defaultSimulate: SimulateResponse;
  private _defaultSend: SendResponse;
  private _defaultGetTx: GetTxResponse;
  private _defaultGetEvents: GetEventsResponse;
  private _defaultGetLatestLedger: GetLatestLedgerResponse;
  private _defaultGetFeeStats: GetFeeStatsResponse;

  readonly calls: {
    simulate: Transaction[];
    send: Array<Transaction | FeeBumpTransaction>;
    getTransaction: string[];
    getEvents: Array<SorobanRpc.Server.GetEventsRequest>;
  } = { simulate: [], send: [], getTransaction: [], getEvents: [] };

  constructor(options: MockRpcClientOptions = {}) {
    this._defaultSimulate = options.defaultSimulateResponse ?? ({
      result: undefined,
      error: undefined,
      events: [],
      id: "mock",
      latestLedger: 100,
    } as unknown as SimulateResponse);

    this._defaultSend = options.defaultSendResponse ?? ({
      status: "PENDING",
      hash: "mock_tx_hash_" + Math.random().toString(36).slice(2),
      latestLedger: 100,
      latestLedgerCloseTime: 0,
    } as unknown as SendResponse);

    this._defaultGetTx = options.defaultGetTransactionResponse ?? ({
      status: "SUCCESS",
      latestLedger: 100,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
      ledger: 100,
      returnValue: undefined,
    } as unknown as GetTxResponse);

    this._defaultGetEvents = options.defaultGetEventsResponse ?? ({
      events: [],
      latestLedger: 100,
    } as unknown as GetEventsResponse);

    this._defaultGetLatestLedger = options.defaultGetLatestLedgerResponse ?? ({
      id: "mock",
      sequence: 100,
      protocolVersion: 21,
    } as unknown as GetLatestLedgerResponse);

    this._defaultGetFeeStats = options.defaultGetFeeStatsResponse ?? ({
      sorobanInclusionFee: { p50: "100", p99: "1000" },
      inclusionFee: { p50: "100", p99: "1000" },
      latestLedger: 100,
    } as unknown as GetFeeStatsResponse);
  }

  /** Queue a simulate response (or Error to throw) for the next call. */
  queueSimulateResponse(response: SimulateResponse | Error): this {
    this._simulateQueue.push(response);
    return this;
  }

  /** Queue a sendTransaction response (or Error to throw) for the next call. */
  queueSendResponse(response: SendResponse | Error): this {
    this._sendQueue.push(response);
    return this;
  }

  /** Queue a getTransaction response (or Error to throw) for the next call. */
  queueGetTransactionResponse(response: GetTxResponse | Error): this {
    this._getTxQueue.push(response);
    return this;
  }

  /** Override the default simulate response for all calls without a queued response. */
  setDefaultSimulateResponse(response: SimulateResponse): this {
    this._defaultSimulate = response;
    return this;
  }

  /** Override the default send response for all calls without a queued response. */
  setDefaultSendResponse(response: SendResponse): this {
    this._defaultSend = response;
    return this;
  }

  /** Override the default getTransaction response for all calls without a queued response. */
  setDefaultGetTransactionResponse(response: GetTxResponse): this {
    this._defaultGetTx = response;
    return this;
  }

  async simulateTransaction(
    transaction: Transaction,
    _addlResources?: SorobanRpc.Server.ResourceLeeway
  ): Promise<SimulateResponse> {
    this.calls.simulate.push(transaction);
    const next = this._simulateQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? this._defaultSimulate;
  }

  async sendTransaction(
    transaction: Transaction | FeeBumpTransaction
  ): Promise<SendResponse> {
    this.calls.send.push(transaction);
    const next = this._sendQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? this._defaultSend;
  }

  async getTransaction(hash: string): Promise<GetTxResponse> {
    this.calls.getTransaction.push(hash);
    const next = this._getTxQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? this._defaultGetTx;
  }

  async getEvents(
    request: SorobanRpc.Server.GetEventsRequest
  ): Promise<GetEventsResponse> {
    this.calls.getEvents.push(request);
    return this._defaultGetEvents;
  }

  async getLatestLedger(): Promise<GetLatestLedgerResponse> {
    return this._defaultGetLatestLedger;
  }

  async getAccount(address: string): Promise<Account> {
    try {
      return new Account(address, "0");
    } catch {
      // Contract addresses (C...) are not valid Account IDs —
      // return a duck-typed mock that satisfies TransactionBuilder.
      return {
        accountId: () => address,
        sequenceNumber: () => "0",
        incrementSequenceNumber: () => {},
      } as unknown as Account;
    }
  }

  async getFeeStats(): Promise<GetFeeStatsResponse> {
    return this._defaultGetFeeStats;
  }

  /** Reset all call records and queues. */
  reset(): this {
    this._simulateQueue = [];
    this._sendQueue = [];
    this._getTxQueue = [];
    this.calls.simulate = [];
    this.calls.send = [];
    this.calls.getTransaction = [];
    this.calls.getEvents = [];
    return this;
  }
}
