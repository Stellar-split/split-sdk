type TimeoutLike = ReturnType<typeof setInterval>;

export interface CountdownOptions {
  timezone?: string;
  businessHours?: {
    /** Inclusive start hour in local timezone (0-23). */
    start: number;
    /** Exclusive end hour in local timezone (0-23 or 24). */
    end: number;
    /** Day-of-week numbers: 0=Sun ... 6=Sat (matches JS Date.getDay()). */
    days: number[];
  };
}

export interface CountdownResult {
  expired: boolean;
  display: string;
  secondsRemaining: number;
  localDisplay: string;
}

type RegisteredCallback = {
  invoiceId: string;
  cb: (invoiceId: string) => void;
  fired: boolean;
};

type CallbackKey = string; // `${deadline}:${invoiceId}` not used; we group by deadline.
type DeadlineBucket = {
  deadline: number;
  callbacks: RegisteredCallback[];
};

function formatHMS(totalSeconds: number, expired: boolean): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  if (expired) return "Expired";

  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function getZonedParts(epochMs: number, timeZone: string) {
  // Intl.DateTimeFormat with formatToParts gives us DST-correct calendar parts.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = dtf.formatToParts(new Date(epochMs));
  const map = new Map(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );

  // weekday short -> convert to numeric by creating a temporary date at UTC midnight of that day
  // (we only need consistency for the weekday number).
  // Instead: use formatter without weekday and derive dayOfWeek from a synthetic date is risky.
  // We'll compute dayOfWeek by using an additional formatter for weekday numeric.
  const weekdayDtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour12: false,
  });
  const weekday = weekdayDtf.format(new Date(epochMs));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(map.get("year") ?? 0),
    month: Number(map.get("month") ?? 1),
    day: Number(map.get("day") ?? 1),
    hour: Number(map.get("hour") ?? 0),
    minute: Number(map.get("minute") ?? 0),
    second: Number(map.get("second") ?? 0),
    dayOfWeek: weekdayMap[weekday] ?? 0,
  };
}

function isBusinessDay(dayOfWeek: number, businessDays: number[]): boolean {
  return businessDays.includes(dayOfWeek);
}

function isBusinessHour(
  hour: number,
  businessStart: number,
  businessEnd: number,
): boolean {
  if (businessStart === businessEnd) return false;
  if (businessStart < businessEnd) {
    return hour >= businessStart && hour < businessEnd;
  }
  // crosses midnight: open from start..24 and 0..end
  return hour >= businessStart || hour < businessEnd;
}

function businessWindowForDayParts(
  dayOfWeek: number,
  _parts: ReturnType<typeof getZonedParts>,
  tz: string,
  bh: NonNullable<CountdownOptions["businessHours"]>,
) {
  // returns list of windows as {startMs,endMs} in epoch ms, in UTC but derived from tz parts.
  const windows: Array<{ startMs: number; endMs: number }> = [];

  if (!isBusinessDay(dayOfWeek, bh.days)) return windows;

  const startHour = bh.start;
  const endHour = bh.end;

  // Build epochMs for a specific zoned date+hour: by interpreting the zoned components as if they were UTC,
  // then adjusting by the actual offset in that timezone at that instant.
  // For DST correctness: we do the conversion by using Intl to get the offset at that calendar instant.
  const buildEpochMs = (
    year: number,
    month: number,
    day: number,
    hour: number,
  ): number => {
    // Create a naive UTC date for the zoned calendar components.
    const naiveUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
    // Find actual timezone components at that instant; then compute offset between desired zoned hour and actual.
    const actual = getZonedParts(naiveUtc, tz);
    // We want epoch such that in tz, hour==hour and Y/M/D match.
    // We'll compute by adjusting difference in hours between desired hour and actual hour, keeping date consistent by reusing naiveUtc.
    // Iterative refinement: for DST transitions, one adjustment is enough in practice for our use cases.
    const hourDelta = hour - actual.hour;
    return naiveUtc + hourDelta * 3600 * 1000;
  };

  const { year, month, day } = _parts;

  if (startHour < endHour) {
    const sMs = buildEpochMs(year, month, day, startHour);
    const eMs = buildEpochMs(year, month, day, endHour);
    windows.push({ startMs: sMs, endMs: eMs });
  } else {
    // start..24
    const s1 = buildEpochMs(year, month, day, startHour);
    const e1 = buildEpochMs(year, month, day, 24);
    windows.push({ startMs: s1, endMs: e1 });

    // 0..end next day
    const nextDay = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const ny = nextDay.getUTCFullYear();
    const nm = nextDay.getUTCMonth() + 1;
    const nd = nextDay.getUTCDate();

    const s2 = buildEpochMs(ny, nm, nd, 0);
    const e2 = buildEpochMs(ny, nm, nd, endHour);
    windows.push({ startMs: s2, endMs: e2 });
  }

  return windows;
}

function sumBusinessSecondsBetween(
  startEpochMs: number,
  endEpochMs: number,
  tz: string,
  bh: NonNullable<CountdownOptions["businessHours"]>,
): number {
  if (endEpochMs <= startEpochMs) return 0;

  // Iterate day by day in the target timezone.
  // We step calendar days at 00:00 in the target zone based on Intl parts.
  const startParts = getZonedParts(startEpochMs, tz);
  const endParts = getZonedParts(endEpochMs, tz);

  // Convert zoned day boundaries by using UTC approximation; then adjust with hourDelta in build epoch.
  // We'll just advance by a fixed UTC day increment until tz date changes.
  let cursorMs = startEpochMs;
  let seconds = 0;

  // Safety bound to avoid infinite loops.
  const maxDays = 370;
  for (let i = 0; i < maxDays; i++) {
    if (cursorMs >= endEpochMs) break;

    const parts = getZonedParts(cursorMs, tz);
    const dayStartParts = { ...parts, hour: 0, minute: 0, second: 0 };

    const buildEpochMs = (
      year: number,
      month: number,
      day: number,
      hour: number,
    ): number => {
      const naiveUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
      const actual = getZonedParts(naiveUtc, tz);
      const hourDelta = hour - actual.hour;
      return naiveUtc + hourDelta * 3600 * 1000;
    };

    const dayStartMs = buildEpochMs(
      dayStartParts.year,
      dayStartParts.month,
      dayStartParts.day,
      0,
    );
    const dayEndMs = buildEpochMs(
      dayStartParts.year,
      dayStartParts.month,
      dayStartParts.day,
      24,
    );

    const windowStart = Math.max(cursorMs, dayStartMs);
    const windowEnd = Math.min(endEpochMs, dayEndMs);

    if (windowEnd > windowStart && isBusinessDay(parts.dayOfWeek, bh.days)) {
      const windows = businessWindowForDayParts(parts.dayOfWeek, parts, tz, bh);
      for (const w of windows) {
        const overlapStart = Math.max(windowStart, w.startMs);
        const overlapEnd = Math.min(windowEnd, w.endMs);
        if (overlapEnd > overlapStart) {
          seconds += (overlapEnd - overlapStart) / 1000;
        }
      }
    }

    // advance to next day in UTC roughly; then loop will correct.
    cursorMs = dayEndMs + 1;

    if (parts.dayOfWeek === endParts.dayOfWeek && i > 1) {
      // heuristic only
    }
  }

  return Math.max(0, Math.floor(seconds));
}

export class DeadlineEngine {
  private interval: TimeoutLike | null = null;

  private readonly intervalMs: number;
  private destroyed = false;
  private readonly buckets = new Map<number, DeadlineBucket>();
  // kept for potential future extensions (e.g., per-deadline options)
  private readonly optionsByDeadline = new Map<number, CountdownOptions>();

  constructor(options?: { intervalMs?: number }) {
    this.intervalMs = options?.intervalMs ?? 1000;
  }

  getCountdown(deadline: number, options?: CountdownOptions): CountdownResult {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = nowSeconds > deadline;

    const tz =
      options?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC";
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

    const secondsRemainingRaw = Math.max(0, deadline - nowSeconds);

    const secondsRemaining = options?.businessHours
      ? sumBusinessSecondsBetween(
          nowSeconds * 1000,
          deadline * 1000,
          tz,
          options.businessHours,
        )
      : secondsRemainingRaw;

    const display = formatHMS(
      secondsRemaining,
      expired || secondsRemainingRaw <= 0,
    );

    // localDisplay uses the runtime tz for the same remaining seconds computation.
    // If businessHours are set, recompute with local timezone for display purposes.
    const localSecondsRemaining = options?.businessHours
      ? sumBusinessSecondsBetween(
          nowSeconds * 1000,
          deadline * 1000,
          localTz,
          options.businessHours,
        )
      : secondsRemainingRaw;

    const localDisplay = formatHMS(
      localSecondsRemaining,
      expired || secondsRemainingRaw <= 0,
    );

    return {
      expired,
      display,
      secondsRemaining,
      localDisplay,
    };
  }

  registerExpiryCallback(
    deadline: number,
    invoiceId: string,
    cb: (invoiceId: string) => void,
  ): () => void {
    if (this.destroyed) {
      return () => {};
    }

    const bucket = this.buckets.get(deadline) ?? { deadline, callbacks: [] };
    const existing = bucket.callbacks.find(
      (c) => c.invoiceId === invoiceId && c.cb === cb,
    );
    if (!existing) {
      bucket.callbacks.push({ invoiceId, cb, fired: false });
    }
    this.buckets.set(deadline, bucket);

    if (!this.interval) {
      this.interval = setInterval(() => this.tick(), this.intervalMs);
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const b = this.buckets.get(deadline);
      if (!b) return;
      b.callbacks = b.callbacks.filter(
        (c) => !(c.invoiceId === invoiceId && c.cb === cb),
      );
      if (b.callbacks.length === 0) this.buckets.delete(deadline);

      if (this.buckets.size === 0) {
        this.destroyInternal(false);
      }
    };
  }

  private tick(): void {
    if (this.destroyed) return;
    const nowSeconds = Math.floor(Date.now() / 1000);

    for (const [deadline, bucket] of this.buckets.entries()) {
      const expired = nowSeconds > deadline || nowSeconds === deadline;
      if (!expired) continue;

      // Fire once per callback.
      for (const cbEntry of bucket.callbacks) {
        if (cbEntry.fired) continue;
        cbEntry.fired = true;
        try {
          cbEntry.cb(cbEntry.invoiceId);
        } catch {
          // ignore callback errors
        }
      }

      // Remove fired callbacks bucket to avoid re-firing.
      this.buckets.delete(deadline);
    }

    if (this.buckets.size === 0) {
      this.destroyInternal();
    }
  }

  private destroyInternal(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.buckets.clear();
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
