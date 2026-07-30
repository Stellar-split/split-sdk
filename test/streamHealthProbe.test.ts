import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { sdkEvents } from "../src/events.js";
import { StreamHealthProbe, type MonitoredStream } from "../src/streamHealthProbe.js";

class FakeStream extends EventEmitter implements MonitoredStream {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

describe("StreamHealthProbe", () => {
  it("emits streamStallDetected and calls onStall when a stream stalls", () => {
    vi.useFakeTimers();
    const stream = new FakeStream();
    const onStall = vi.fn();
    const detected = vi.fn();
    const off = sdkEvents.on("streamStallDetected", detected);
    const probe = new StreamHealthProbe({ stalledThresholdMs: 10, checkIntervalMs: 5, onStall });

    probe.attach("stream-1", stream);
    vi.advanceTimersByTime(20);

    expect(detected).toHaveBeenCalledWith({ streamId: "stream-1" });
    expect(onStall).toHaveBeenCalledWith("stream-1");
    probe.detach("stream-1");
    off();
    vi.useRealTimers();
  });
});
