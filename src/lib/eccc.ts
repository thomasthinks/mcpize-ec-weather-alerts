/**
 * Data access for Environment Canada's GeoMet OGC API (api.weather.gc.ca)
 * plus NRC Geogratis geocoding. All keyless.
 *
 * Verified 2026-10-04 against the live API:
 *  - Collection `citypageweather-realtime` (id exactly as shown) carries BOTH
 *    current conditions (`properties.currentConditions`) and the text forecast
 *    (`properties.forecastGroup.forecasts`) for 844 ECCC city-page locations.
 *  - Collection `weather-alerts` carries active public weather alerts with
 *    queryable `province` and spatial (bbox) filtering.
 */

import { fetchJson, LocationNotFoundError, UpstreamError } from "./http.js";

const ECCC_BASE = "https://api.weather.gc.ca";
const GEOGRATIS_BASE = "https://geogratis.gc.ca/services/geoname/en/geonames.json";

// ---------------------------------------------------------------------------
// Types (loose GeoJSON — upstream schema is wide, we read defensively)
// ---------------------------------------------------------------------------

export interface ResolvedLocation {
  label: string; // human-readable, e.g. "Toronto" or "43.65, -79.38"
  lat: number;
  lon: number;
}

interface EnField {
  en?: unknown;
  fr?: unknown;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * ECCC nests most scalars one level deep: `temperature.value.en`.
 * A few (condition, timestamp, class) carry `.en` directly.
 * Read `.value.en` first, fall back to a direct `.en`.
 */
function pickEn(node: unknown): { text?: string; num?: number } {
  if (!node || typeof node !== "object") return {};
  const rec = node as Record<string, unknown>;
  const inner =
    rec.value !== undefined && typeof rec.value === "object"
      ? (rec.value as Record<string, unknown>)
      : rec;
  const v = (inner as EnField).en;
  if (typeof v === "number" && Number.isFinite(v)) return { num: v, text: String(v) };
  if (typeof v === "string") return { text: v };
  return {};
}

function enOf(node: unknown): string | undefined {
  return pickEn(node).text;
}

function numOf(node: unknown): number | undefined {
  return pickEn(node).num;
}

/** Haversine distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function parseCoordinates(input: string): { lat: number; lon: number } | undefined {
  const m = COORD_RE.exec(input);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  return { lat, lon };
}

// ---------------------------------------------------------------------------
// Geocoding (NRC Geogratis)
// ---------------------------------------------------------------------------

interface GeonameItem {
  name?: string;
  latitude?: number | string;
  longitude?: number | string;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export async function geocodeCity(name: string): Promise<ResolvedLocation> {
  const q = encodeURIComponent(name);
  const attempts = [
    `${GEOGRATIS_BASE}?q=${q}&concise=CITY`,
    `${GEOGRATIS_BASE}?q=${q}`,
  ];
  for (const url of attempts) {
    const data = (await fetchJson(url)) as { items?: GeonameItem[] };
    const items = Array.isArray(data?.items) ? data.items : [];
    const best = items[0];
    const lat = best ? toNumber(best.latitude) : undefined;
    const lon = best ? toNumber(best.longitude) : undefined;
    if (best && lat !== undefined && lon !== undefined) {
      return {
        label: typeof best.name === "string" && best.name ? best.name : name,
        lat,
        lon,
      };
    }
  }
  throw new LocationNotFoundError(name);
}

/**
 * Resolve the tool's free-form `location` into coordinates.
 * Accepts "lat,lon" directly; otherwise geocodes the place name.
 */
export async function resolveLocation(input: string): Promise<ResolvedLocation> {
  const trimmed = input.trim();
  const coords = parseCoordinates(trimmed);
  if (coords) {
    return {
      label: `${coords.lat}, ${coords.lon}`,
      lat: coords.lat,
      lon: coords.lon,
    };
  }
  return geocodeCity(trimmed);
}

// ---------------------------------------------------------------------------
// City page weather (current conditions + forecast)
// ---------------------------------------------------------------------------

interface EcccFeature {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
}

interface EcccItems {
  features?: EcccFeature[];
}

function featurePoint(f: EcccFeature): { lat: number; lon: number } | undefined {
  const c = f.geometry?.coordinates;
  if (Array.isArray(c) && c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number") {
    return { lon: c[0], lat: c[1] };
  }
  return undefined;
}

/**
 * Fetch the nearest ECCC city-page feature for a coordinate via a bbox query.
 * ECCC publishes 844 city-page points across Canada; the nearest one to the
 * resolved coordinate is that area's official ECCC location.
 */
export async function nearestCityPage(lat: number, lon: number): Promise<EcccFeature> {
  const bbox = `${lon - 1.5},${lat - 1.5},${lon + 1.5},${lat + 1.5}`;
  const url =
    `${ECCC_BASE}/collections/citypageweather-realtime/items` +
    `?f=json&bbox=${bbox}&limit=100`;
  const data = (await fetchJson(url)) as EcccItems;
  const features = Array.isArray(data?.features) ? data.features : [];
  let best: EcccFeature | undefined;
  let bestDist = Infinity;
  for (const f of features) {
    const pt = featurePoint(f);
    if (!pt) continue;
    const d = distanceKm(lat, lon, pt.lat, pt.lon);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  if (!best) {
    throw new UpstreamError(
      `No Environment Canada reporting location found near ${lat}, ${lon}.`,
      "Try a larger nearby city, or coordinates closer to a populated area.",
    );
  }
  return best;
}

export function cityPageName(f: EcccFeature): string {
  const p = f.properties ?? {};
  return enOf(p.name) ?? "Unknown location";
}

// ---------------------------------------------------------------------------
// Current conditions parsing
// ---------------------------------------------------------------------------

export interface Conditions {
  temp_c: number | null;
  feels_like_c: number | null;
  humidity_pct: number | null;
  wind_kph: number | null;
  wind_direction: string | null;
  condition: string;
  observed_at: string | null;
  station_name: string | null;
}

/**
 * Humidex from temperature/dewpoint (°C) — the same index ECCC publishes.
 * e = 6.11 * exp(5417.7530 * (1/273.16 - 1/(273.15 + Tdew)))
 * humidex = Tair + 0.5555 * (e - 10)
 */
export function humidex(tempC: number, dewpointC: number): number {
  const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / (273.15 + dewpointC)));
  return tempC + 0.5555 * (e - 10);
}

/**
 * ECCC wind chill (°C), valid for T <= 10°C and wind >= 4.8 km/h.
 * WC = 13.12 + 0.6215*T - 11.37*V^0.16 + 0.3965*T*V^0.16
 */
export function windChill(tempC: number, windKph: number): number {
  const v = Math.pow(windKph, 0.16);
  return 13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function parseConditions(f: EcccFeature): Conditions {
  const cc = (f.properties?.currentConditions ?? {}) as Record<string, unknown>;
  const temp = numOf(cc.temperature);
  const dew = numOf(cc.dewpoint);
  const humidity = numOf(cc.relativeHumidity);
  const wind = (cc.wind ?? {}) as Record<string, unknown>;
  const windKph = numOf(wind.speed);
  const windDir = enOf(wind.direction) ?? null;
  const stationNode = (cc.station ?? {}) as Record<string, unknown>;
  const station = enOf(stationNode.value);

  let feels: number | null = null;
  const reportedChill = numOf(cc.windChill);
  if (temp !== undefined) {
    if (temp <= 10 && reportedChill !== undefined) {
      // ECCC-observed wind chill; only valid at/below 10°C, where ECCC intends it.
      feels = reportedChill;
    } else if (temp <= 10 && windKph !== undefined && windKph >= 4.8) {
      feels = round1(windChill(temp, windKph));
    } else if (temp >= 20 && dew !== undefined) {
      feels = round1(humidex(temp, dew));
    } else {
      feels = temp;
    }
  }

  return {
    temp_c: temp ?? null,
    feels_like_c: feels,
    humidity_pct: humidity !== undefined ? Math.round(humidity) : null,
    wind_kph: windKph ?? null,
    wind_direction: windDir,
    condition: enOf(cc.condition) ?? "Not reported by ECCC",
    observed_at: enOf(cc.timestamp) ?? null,
    station_name: station ?? null,
  };
}

// ---------------------------------------------------------------------------
// Forecast parsing
// ---------------------------------------------------------------------------

export interface ForecastPeriod {
  date: string;
  high_c: number | null;
  low_c: number | null;
  condition: string;
  pop_pct: number | null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function addDaysUtc(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve a forecast day-name (e.g. "Sunday", "Tonight") to a calendar date. */
export function resolveForecastDate(
  periodValue: string,
  textForecastName: string,
  issuedAt: Date,
): string {
  if (/tonight|today/i.test(textForecastName)) return isoDate(issuedAt);
  const dayName = periodValue.replace(/\s+(night|evening|afternoon)$/i, "").trim().toLowerCase();
  const target = WEEKDAYS.indexOf(dayName);
  if (target < 0) return isoDate(issuedAt); // unknown label — anchor to issue date
  for (let i = 0; i < 8; i++) {
    const cand = addDaysUtc(issuedAt, i);
    if (cand.getUTCDay() === target) return isoDate(cand);
  }
  return isoDate(issuedAt);
}

function extractPop(...texts: (string | undefined)[]): number | null {
  let best: number | null = null;
  for (const t of texts) {
    if (!t) continue;
    const m = /(\d{1,3})\s*percent/i.exec(t);
    if (m) {
      const v = Math.min(100, Math.max(0, Number(m[1])));
      if (best === null || v > best) best = v;
    }
  }
  return best;
}

interface ForecastBucket {
  highs: number[];
  lows: number[];
  conditions: string[];
  pops: number[];
  isDayFirst: boolean;
}

export function parseForecast(f: EcccFeature): { periods: ForecastPeriod[]; issued_at: string | null } {
  const fg = (f.properties?.forecastGroup ?? {}) as Record<string, unknown>;
  const issuedAtRaw = enOf(fg.timestamp);
  const issuedAt = issuedAtRaw ? new Date(issuedAtRaw) : new Date();
  const raw = fg.forecasts;
  const entries = Array.isArray(raw) ? raw : [];

  const buckets = new Map<string, ForecastBucket & { firstIndex: number }>();
  let order = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const period = (e.period ?? {}) as Record<string, unknown>;
    const periodValue = enOf(period.value) ?? "";
    const textForecastName = enOf(period.textForecastName) ?? "";
    const date = resolveForecastDate(periodValue, textForecastName, issuedAt);
    let bucket = buckets.get(date);
    if (!bucket) {
      bucket = { highs: [], lows: [], conditions: [], pops: [], isDayFirst: !/night/i.test(periodValue), firstIndex: order++ };
      buckets.set(date, bucket);
    }
    const temps = (e.temperatures ?? {}) as Record<string, unknown>;
    const tempList = Array.isArray(temps.temperature) ? temps.temperature : [];
    for (const t of tempList) {
      const cls = enOf((t as Record<string, unknown>).class)?.toLowerCase();
      const val = numOf(t);
      if (val === undefined) continue;
      if (cls === "high") bucket.highs.push(val);
      else if (cls === "low") bucket.lows.push(val);
    }
    const abbrev = (e.abbreviatedForecast ?? {}) as Record<string, unknown>;
    const cloudPrecip = enOf((e.cloudPrecip ?? {}) as Record<string, unknown>) ?? enOf(e.cloudPrecip);
    const abbrevText = enOf(abbrev.textSummary);
    const summary = enOf(e.textSummary);
    if (abbrevText) bucket.conditions.push(abbrevText);
    else if (cloudPrecip) bucket.conditions.push(cloudPrecip);
    else if (summary) bucket.conditions.push(summary.split(".")[0]);
    const pop = extractPop(cloudPrecip, summary);
    if (pop !== null) bucket.pops.push(pop);
  }

  const periods: ForecastPeriod[] = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([date, b]) => ({
      date,
      high_c: b.highs.length ? Math.max(...b.highs) : null,
      low_c: b.lows.length ? Math.min(...b.lows) : null,
      condition: b.conditions[0] ?? "Not reported by ECCC",
      pop_pct: b.pops.length ? Math.max(...b.pops) : null,
    }));

  return {
    periods,
    issued_at: issuedAtRaw ?? null,
  };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface WeatherAlert {
  event: string;
  severity: string;
  headline: string;
  areas: string[];
  effective: string | null;
  expires: string | null;
  description: string;
}

function severityFromColour(colour: string | undefined): string {
  switch ((colour ?? "").toLowerCase()) {
    case "red":
      return "Severe";
    case "orange":
      return "High";
    case "yellow":
      return "Moderate";
    default:
      return "Advisory";
  }
}

export function parseAlertFeature(f: EcccFeature): WeatherAlert {
  const p = (f.properties ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = p[k];
    return typeof v === "string" ? v : undefined;
  };
  const name = str("alert_name_en") ?? "Weather alert";
  return {
    event: name,
    severity: severityFromColour(str("risk_colour_en")),
    headline: str("alert_short_name_en") ?? name,
    areas: str("feature_name_en") ? [str("feature_name_en") as string] : [],
    effective: str("publication_datetime") ?? null,
    expires: str("expiration_datetime") ?? null,
    description: str("alert_text_en") ?? "",
  };
}

export async function alertsForProvince(provinceCode: string): Promise<WeatherAlert[]> {
  const url =
    `${ECCC_BASE}/collections/weather-alerts/items` +
    `?f=json&province=${encodeURIComponent(provinceCode.toUpperCase())}&limit=100`;
  const data = (await fetchJson(url)) as EcccItems;
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.map(parseAlertFeature);
}

export async function alertsForPoint(lat: number, lon: number): Promise<WeatherAlert[]> {
  const bbox = `${lon - 0.5},${lat - 0.5},${lon + 0.5},${lat + 0.5}`;
  const url =
    `${ECCC_BASE}/collections/weather-alerts/items` + `?f=json&bbox=${bbox}&limit=100`;
  const data = (await fetchJson(url)) as EcccItems;
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.map(parseAlertFeature);
}

export const PROVINCES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);

export function isProvinceCode(input: string): boolean {
  return PROVINCES.has(input.trim().toUpperCase());
}
