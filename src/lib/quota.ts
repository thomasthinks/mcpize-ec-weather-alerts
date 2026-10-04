/**
 * Free-tier quota enforcement. In-memory per-process daily counter.
 * FREE_DAILY_LIMIT env var overrides the default of 100.
 */

const DEFAULT_FREE_DAILY_LIMIT = 100;

export function freeDailyLimit(): number {
  const raw = process.env.FREE_DAILY_LIMIT;
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FREE_DAILY_LIMIT;
}

let dayKey = "";
let count = 0;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC day
}

/**
 * Records one billable tool call. Returns whether the call is allowed.
 * Exposed as a pure-ish function so tests can reset it.
 */
export function consumeQuota(): { allowed: boolean; limit: number } {
  const limit = freeDailyLimit();
  const today = todayKey();
  if (today !== dayKey) {
    dayKey = today;
    count = 0;
  }
  if (count >= limit) return { allowed: false, limit };
  count += 1;
  return { allowed: true, limit };
}

export function quotaExceededMessage(limit: number): string {
  return `Free quota exceeded (${limit}/day). Subscribe to Pro for unlimited access.`;
}

/** Test-only: reset the counter between tests. */
export function resetQuota(): void {
  dayKey = "";
  count = 0;
}
