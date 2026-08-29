import { describe, expect, it, vi } from "vitest";
import { WebSocketTransport } from "../src/websocket.js";

describe("WebSocketTransport", () => {
  it("stops reconnecting after maxReconnectAttempts and emits connection_failed", () => {
    vi.useFakeTimers();

    const wsFactory = () => {
      throw new Error("connect failed");
    };
    const transport = new WebSocketTransport("https://rpc.example.com", undefined, wsFactory as () => WebSocket, 2);
    const onFailed = vi.fn();

    transport.onConnectionFailed(onFailed);
    transport.subscribe("inv-1", () => undefined);

    vi.runAllTimers();

    expect(onFailed).toHaveBeenCalledWith(2);
    expect(transport.getStatus().reconnectAttempts).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });
});
