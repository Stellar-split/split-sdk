import { getCursor } from "./cursorTracker.js";
import { emitSdkEvent } from "./events.js";

export interface MonitoredStream {
  close(): void;
  on?(event: "message" | "event", handler: (event: unknown) => void): void;
  off?(event: "message" | "event", handler: (event: unknown) => void): void;
  addEventListener?(event: "message" | "event", handler: (event: unknown) => void): void;
  removeEventListener?(event: "message" | "event", handler: (event: unknown) => void): void;
}

export interface StreamHealthProbeOptions {
  stalledThresholdMs?: number;
  checkIntervalMs?: number;
  autoReset?: boolean;
  onStall?: (streamId: string) => void;
  streamFactory?: (streamId: string, cursor: string | null) => MonitoredStream;
}

interface Attachment {
  stream: MonitoredStream;
  lastEventAt: number;
  timer: ReturnType<typeof setInterval>;
  handler: (event: unknown) => void;
}

export class StreamHealthProbe {
  private readonly attachments = new Map<string, Attachment>();
  private readonly stalledThresholdMs: number;
  private readonly checkIntervalMs: number;

  constructor(private readonly options: StreamHealthProbeOptions = {}) {
    this.stalledThresholdMs = options.stalledThresholdMs ?? 30_000;
    this.checkIntervalMs = options.checkIntervalMs ?? Math.min(this.stalledThresholdMs, 5_000);
  }

  attach(streamId: string, stream: MonitoredStream): void {
    this.detach(streamId);

    const handler = (): void => {
      const attachment = this.attachments.get(streamId);
      if (attachment) attachment.lastEventAt = Date.now();
    };

    this.bind(stream, handler);
    const timer = setInterval(() => this.check(streamId), this.checkIntervalMs);
    this.attachments.set(streamId, { stream, lastEventAt: Date.now(), timer, handler });
  }

  detach(streamId: string): void {
    const attachment = this.attachments.get(streamId);
    if (!attachment) return;

    clearInterval(attachment.timer);
    this.unbind(attachment.stream, attachment.handler);
    this.attachments.delete(streamId);
  }

  private check(streamId: string): void {
    const attachment = this.attachments.get(streamId);
    if (!attachment) return;

    if (Date.now() - attachment.lastEventAt <= this.stalledThresholdMs) return;

    emitSdkEvent("streamStallDetected", { streamId });
    this.options.onStall?.(streamId);

    if (this.options.autoReset) {
      attachment.stream.close();
      const replacement = this.options.streamFactory?.(streamId, getCursor(streamId));
      emitSdkEvent("streamAutoReset", { streamId });
      this.detach(streamId);
      if (replacement) this.attach(streamId, replacement);
    } else {
      attachment.lastEventAt = Date.now();
    }
  }

  private bind(stream: MonitoredStream, handler: (event: unknown) => void): void {
    stream.on?.("message", handler);
    stream.on?.("event", handler);
    stream.addEventListener?.("message", handler);
    stream.addEventListener?.("event", handler);
  }

  private unbind(stream: MonitoredStream, handler: (event: unknown) => void): void {
    stream.off?.("message", handler);
    stream.off?.("event", handler);
    stream.removeEventListener?.("message", handler);
    stream.removeEventListener?.("event", handler);
  }
}
