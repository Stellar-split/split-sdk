/**
 * Deadline countdown and expiry-callback helpers.
 */

export interface BusinessHours {
  /** Local start hour, 0-23, inclusive. */
  start: number;
  /** Local end hour, 1-24, exclusive. */
  end: number;
  /** Business days using JavaScript day numbers: 0 Sunday through 6 Saturday. */
  days: number[];
}

export interface CountdownOptions {
  /** IANA timezone used for local display and business-hours windows. */
  timezone?: string;
  /** Optional local business-hours window for effective remaining time. */
  businessHours?: BusinessHours;
}

export interface CountdownResult {
  /** True when the absolute deadline has passed. */
  expired: boolean;
  /** Human-readable remaining duration, based on effective seconds remaining. */
  display: string;
  /** Seconds remaining, optionally counting only business-hours seconds. */
  secondsRemaining: number;
  /** Deadline rendered in the selected timezone. */
  localDisplay: string;
}

export interface DeadlineEngineOptions {
  /** Poll interval for registered expiry callbacks. */
  pollIntervalMs?: number;
  /** Clock source in milliseconds, primarily useful for tests. */
  now?: () => number;
}

type ExpiryCallback = (invoiceId: string) => void;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

interface CallbackRegistration {
  deadline: number;
  invoiceId: string;
  cb: ExpiryCallback;
}

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getDateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function getZonedParts(date: Date, timezone: string): ZonedParts {
  const values = new Map(
    getDateTimeFormatter(timezone)
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const hour = Number(values.get("hour"));

  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: hour === 24 ? 0 : hour,
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
    weekday: WEEKDAY_TO_INDEX[values.get("weekday") ?? "Sun"] ?? 0,
  };
}

function getTimezoneOffsetMs(date: Date, timezone: string): number {
  const parts = getZonedParts(date, timezone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return localAsUtc - date.getTime();
}

function zonedWallTimeToUtcMs(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number
): number {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  let utc = localAsUtc - getTimezoneOffsetMs(new Date(localAsUtc), timezone);

  for (let i = 0; i < 3; i += 1) {
    const nextUtc = localAsUtc - getTimezoneOffsetMs(new Date(utc), timezone);
    if (Math.abs(nextUtc - utc) < MS_PER_SECOND) {
      return nextUtc;
    }
    utc = nextUtc;
  }

  return utc;
}

function addLocalDays(parts: ZonedParts, days: number): Pick<ZonedParts, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localDateKey(parts: Pick<ZonedParts, "year" | "month" | "day">): number {
  return parts.year * 10_000 + parts.month * 100 + parts.day;
}

function assertBusinessHours(businessHours: BusinessHours): void {
  if (
    !Number.isInteger(businessHours.start) ||
    !Number.isInteger(businessHours.end) ||
    businessHours.start < 0 ||
    businessHours.start > 23 ||
    businessHours.end < 1 ||
    businessHours.end > 24 ||
    businessHours.start >= businessHours.end
  ) {
    throw new RangeError("businessHours start/end must define a valid local hour range");
  }

  for (const day of businessHours.days) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new RangeError("businessHours days must use JavaScript day numbers 0-6");
    }
  }
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) {
    return "expired";
  }

  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainingSeconds = seconds % SECONDS_PER_MINUTE;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${remainingSeconds}s`);

  return parts.join(" ");
}

function formatLocalDeadline(deadline: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(deadline * MS_PER_SECOND));
}

/**
 * Computes deadline countdowns and manages invoice expiry callbacks.
 */
export class DeadlineEngine {
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private callbacks = new Map<symbol, CallbackRegistration>();
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(options: DeadlineEngineOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Return countdown state for an absolute Unix timestamp deadline.
   */
  getCountdown(deadline: number, options: CountdownOptions = {}): CountdownResult {
    const timezone = options.timezone ?? DEFAULT_TIMEZONE;
    const nowMs = this.now();
    const deadlineMs = deadline * MS_PER_SECOND;
    const expired = deadlineMs <= nowMs;
    const secondsRemaining = expired
      ? 0
      : options.businessHours
        ? this.countBusinessSeconds(nowMs, deadlineMs, timezone, options.businessHours)
        : Math.floor((deadlineMs - nowMs) / MS_PER_SECOND);

    return {
      expired,
      display: formatDuration(secondsRemaining),
      secondsRemaining,
      localDisplay: formatLocalDeadline(deadline, timezone),
    };
  }

  /**
   * Register a callback that fires once after the deadline passes.
   *
   * The returned function unsubscribes the callback.
   */
  registerExpiryCallback(deadline: number, invoiceId: string, cb: ExpiryCallback): () => void {
    const id = Symbol(invoiceId);
    this.callbacks.set(id, { deadline, invoiceId, cb });
    this.ensureInterval();

    return () => {
      this.callbacks.delete(id);
      this.stopIntervalIfIdle();
    };
  }

  /**
   * Clear all callbacks and stop the shared polling interval.
   */
  destroy(): void {
    this.callbacks.clear();
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private countBusinessSeconds(
    nowMs: number,
    deadlineMs: number,
    timezone: string,
    businessHours: BusinessHours
  ): number {
    assertBusinessHours(businessHours);

    const businessDays = new Set(businessHours.days);
    const deadlineParts = getZonedParts(new Date(deadlineMs), timezone);
    let cursor = getZonedParts(new Date(nowMs), timezone);
    const endDateKey = localDateKey(deadlineParts);
    let totalMs = 0;
    let guard = 0;

    while (localDateKey(cursor) <= endDateKey && guard < 3660) {
      if (businessDays.has(cursor.weekday)) {
        const startMs = zonedWallTimeToUtcMs(
          timezone,
          cursor.year,
          cursor.month,
          cursor.day,
          businessHours.start
        );
        const endMs = zonedWallTimeToUtcMs(
          timezone,
          cursor.year,
          cursor.month,
          cursor.day,
          businessHours.end
        );
        const effectiveStart = Math.max(startMs, nowMs);
        const effectiveEnd = Math.min(endMs, deadlineMs);

        if (effectiveEnd > effectiveStart) {
          totalMs += effectiveEnd - effectiveStart;
        }
      }

      const nextDate = addLocalDays(cursor, 1);
      cursor = {
        ...nextDate,
        hour: 0,
        minute: 0,
        second: 0,
        weekday: getZonedParts(
          new Date(zonedWallTimeToUtcMs(timezone, nextDate.year, nextDate.month, nextDate.day, 12)),
          timezone
        ).weekday,
      };
      guard += 1;
    }

    return Math.floor(totalMs / MS_PER_SECOND);
  }

  private ensureInterval(): void {
    if (this.interval !== undefined) {
      return;
    }

    this.interval = setInterval(() => {
      const nowSeconds = Math.floor(this.now() / MS_PER_SECOND);

      for (const [id, registration] of Array.from(this.callbacks.entries())) {
        if (nowSeconds >= registration.deadline) {
          this.callbacks.delete(id);
          registration.cb(registration.invoiceId);
        }
      }

      this.stopIntervalIfIdle();
    }, this.pollIntervalMs);
  }

  private stopIntervalIfIdle(): void {
    if (this.callbacks.size === 0 && this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }
}
