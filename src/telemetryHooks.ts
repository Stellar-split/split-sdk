/**
 * Opt-in telemetry hook system for SDK error and performance monitoring.
 * 
 * Allows application developers to integrate their own monitoring solutions
 * (Sentry, Datadog, custom telemetry) without the SDK having direct dependencies.
 * 
 * All hooks are fire-and-forget — exceptions within hooks do not propagate to SDK callers.
 */

import type { StellarSplitError } from "./errors.js";

/**
 * Context provided to the onError hook when an SDK error occurs.
 */
export interface TelemetryErrorContext {
  /** The SDK method that threw the error (e.g., "createInvoice", "pay"). */
  method: string;
  /** Method arguments (sanitized, no sensitive data). */
  args?: Record<string, unknown>;
  /** Timestamp when the error occurred (milliseconds since epoch). */
  timestamp: number;
  /** Trace ID for correlating this error with the originating SDK call. */
  traceId?: string;
}

/**
 * Parameters passed to onCallStart before each RPC call.
 */
export interface TelemetryCallStartParams {
  /** The SDK method name being invoked (e.g., "getInvoice", "pay"). */
  method: string;
  /** Method arguments (sanitized, no sensitive data). */
  args?: Record<string, unknown>;
  /** Timestamp when the call started (milliseconds since epoch). */
  timestamp: number;
  /** Unique trace ID for this SDK method invocation. */
  traceId?: string;
}

/**
 * Parameters passed to onCallEnd after each RPC call completes.
 */
export interface TelemetryCallEndParams {
  /** The SDK method name that was invoked. */
  method: string;
  /** Duration of the call in milliseconds. */
  durationMs: number;
  /** Whether the call succeeded without throwing an error. */
  success: boolean;
  /** The error that occurred, if any. */
  error?: StellarSplitError;
  /** Timestamp when the call ended (milliseconds since epoch). */
  timestamp: number;
  /** Unique trace ID for this SDK method invocation. */
  traceId?: string;
}

/**
 * Telemetry hooks that can be registered with the SDK.
 * All hooks are optional and fire-and-forget.
 */
export interface TelemetryHooks {
  /**
   * Called whenever an SDK error is thrown, before it propagates to the caller.
   * 
   * @param error - The error instance that was thrown.
   * @param context - Additional context about the error (method, args, timestamp).
   */
  onError?(error: StellarSplitError, context: TelemetryErrorContext): void;

  /**
   * Called before each SDK method invocation that makes an RPC call.
   * 
   * @param params - Call parameters including method name, args, and timestamp.
   */
  onCallStart?(params: TelemetryCallStartParams): void;

  /**
   * Called after each SDK method invocation completes (success or failure).
   * 
   * @param params - Call results including method name, duration, success status, and optional error.
   */
  onCallEnd?(params: TelemetryCallEndParams): void;
}

/**
 * Internal telemetry hook manager for the SDK.
 * Handles safe invocation of user-provided hooks with error isolation.
 */
export class TelemetryHookManager {
  private hooks: TelemetryHooks = {};

  /**
   * Register telemetry hooks.
   * Replaces any previously registered hooks.
   * 
   * @param hooks - The telemetry hooks to register.
   */
  setHooks(hooks: TelemetryHooks): void {
    this.hooks = hooks;
  }

  /**
   * Clear all registered telemetry hooks.
   */
  clearHooks(): void {
    this.hooks = {};
  }

  /**
   * Invoke the onError hook if registered.
   * Exceptions within the hook are caught and logged to console but do not propagate.
   * 
   * @param error - The error that occurred.
   * @param context - Context about the error.
   */
  fireOnError(error: StellarSplitError, context: TelemetryErrorContext): void {
    if (!this.hooks.onError) {
      return;
    }

    try {
      this.hooks.onError(error, context);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onError hook threw an exception:", hookError);
    }
  }

  /**
   * Invoke the onCallStart hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   * 
   * @param params - Call start parameters.
   */
  fireOnCallStart(params: TelemetryCallStartParams): void {
    if (!this.hooks.onCallStart) {
      return;
    }

    try {
      this.hooks.onCallStart(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onCallStart hook threw an exception:", hookError);
    }
  }

  /**
   * Invoke the onCallEnd hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   * 
   * @param params - Call end parameters.
   */
  fireOnCallEnd(params: TelemetryCallEndParams): void {
    if (!this.hooks.onCallEnd) {
      return;
    }

    try {
      this.hooks.onCallEnd(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onCallEnd hook threw an exception:", hookError);
    }
  }

  /**
   * Check if any hooks are registered.
   */
  hasHooks(): boolean {
    return !!(this.hooks.onError || this.hooks.onCallStart || this.hooks.onCallEnd);
  }
}
