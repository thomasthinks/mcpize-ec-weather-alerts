/**
 * Pure tool logic — no MCP dependency, so it is easy to unit test.
 * Each tool: resolve location -> check cache -> fetch from ECCC -> parse -> cache.
 * Every handler catches everything and returns an LLM-friendly isError result.
 */

import {
  alertsForPoint,
  alertsForProvince,
  cityPageName,
  isProvinceCode,
  nearestCityPage,
  parseConditions,
  parseForecast,
  resolveLocation,
  type Conditions,
  type ForecastPeriod,
  type ResolvedLocation,
  type WeatherAlert,
} from "./lib/eccc.js";
import { getCached, setCached } from "./lib/cache.js";
import { consumeQuota, quotaExceededMessage } from "./lib/quota.js";

const CONDITIONS_TTL_MS = 30 * 60 * 1000; // 30 min
const FORECAST_TTL_MS = 2 * 60 * 60 * 1000; // 2 h
const ALERTS_TTL_MS = 15 * 60 * 1000; // 15 min

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export interface ToolSuccess {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: false;
  cached?: boolean;
}

export interface ToolFailure {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export type ToolOutcome = ToolSuccess | ToolFailure;

export function ok(output: Record<string, unknown>, cached: boolean): ToolSuccess {
  const withCache = { ...output, cached };
  return {
    content: [{ type: "text", text: JSON.stringify(withCache) }],
    structuredContent: withCache,
    cached,
  };
}

export function fail(message: string, suggestion: string): ToolFailure {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, suggestion }),
      },
    ],
    isError: true,
  };
}

/** Quota gate shared by all tools. Returns a failure outcome, or null to proceed. */
function checkQuota(): ToolFailure | null {
  const { allowed, limit } = consumeQuota();
  if (!allowed) {
    return fail(
      quotaExceededMessage(limit),
      "You have used today's free queries. Ask the user to subscribe to the Pro plan ($9/month, unlimited) to continue.",
    );
  }
  return null;
}

function failureFrom(err: unknown): ToolFailure {
  if (err instanceof Error && err.name === "LocationNotFoundError") {
    return fail(err.message, "Try a larger nearby city name, or coordinates as 'lat,lon' (e.g. '43.65,-79.38').");
  }
  const message = err instanceof Error ? err.message : String(err);
  const hint =
    err instanceof Error && "hint" in err && typeof (err as { hint?: unknown }).hint === "string"
      ? (err as { hint: string }).hint
      : "Try again in a moment, or use coordinates as 'lat,lon' to skip geocoding.";
  return fail(message, hint);
}

function cacheKey(kind: string, loc: ResolvedLocation): string {
  return `${kind}:${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// Result shapes (index signature required for structuredContent)
// ---------------------------------------------------------------------------

export interface CurrentConditionsResult {
  [key: string]: unknown;
  location_resolved: string;
  temp_c: number | null;
  feels_like_c: number | null;
  humidity_pct: number | null;
  wind_kph: number | null;
  wind_direction: string | null;
  condition: string;
  observed_at: string | null;
  station_name: string | null;
}

export interface ForecastResult {
  [key: string]: unknown;
  location_resolved: string;
  periods: ForecastPeriod[];
  issued_at: string | null;
}

export interface ActiveAlertsResult {
  [key: string]: unknown;
  alerts: WeatherAlert[];
  count: number;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** current_conditions(location) */
export async function currentConditions(location: string): Promise<ToolOutcome> {
  const quota = checkQuota();
  if (quota) return quota;
  try {
    const loc = await resolveLocation(location);
    const key = cacheKey("conditions", loc);
    const hit = getCached<CurrentConditionsResult>(key);
    if (hit.hit) return ok(hit.value, true);

    const feature = await nearestCityPage(loc.lat, loc.lon);
    const cond: Conditions = parseConditions(feature);
    const result: CurrentConditionsResult = {
      location_resolved: `${loc.label} (nearest ECCC location: ${cityPageName(feature)})`,
      ...cond,
    };
    setCached(key, result, CONDITIONS_TTL_MS);
    return ok(result, false);
  } catch (err) {
    return failureFrom(err);
  }
}

/** forecast(location) */
export async function forecast(location: string): Promise<ToolOutcome> {
  const quota = checkQuota();
  if (quota) return quota;
  try {
    const loc = await resolveLocation(location);
    const key = cacheKey("forecast", loc);
    const hit = getCached<ForecastResult>(key);
    if (hit.hit) return ok(hit.value, true);

    const feature = await nearestCityPage(loc.lat, loc.lon);
    const { periods, issued_at } = parseForecast(feature);
    const result: ForecastResult = {
      location_resolved: `${loc.label} (nearest ECCC location: ${cityPageName(feature)})`,
      periods,
      issued_at,
    };
    setCached(key, result, FORECAST_TTL_MS);
    return ok(result, false);
  } catch (err) {
    return failureFrom(err);
  }
}

/**
 * active_alerts(location) — accepts a place name, "lat,lon", or a province
 * code like "ON" (province-wide query).
 */
export async function activeAlerts(location: string): Promise<ToolOutcome> {
  const quota = checkQuota();
  if (quota) return quota;
  try {
    const trimmed = location.trim();
    let alerts: WeatherAlert[];
    let key: string;

    if (isProvinceCode(trimmed)) {
      const code = trimmed.toUpperCase();
      key = `alerts:prov:${code}`;
      const hit = getCached<ActiveAlertsResult>(key);
      if (hit.hit) return ok(hit.value, true);
      alerts = await alertsForProvince(code);
    } else {
      const loc = await resolveLocation(trimmed);
      key = `alerts:${cacheKey("pt", loc)}`;
      const hit = getCached<ActiveAlertsResult>(key);
      if (hit.hit) return ok(hit.value, true);
      alerts = await alertsForPoint(loc.lat, loc.lon);
    }

    const result: ActiveAlertsResult = { alerts, count: alerts.length };
    setCached(key, result, ALERTS_TTL_MS);
    return ok(result, false);
  } catch (err) {
    return failureFrom(err);
  }
}
