/**
 * Unit tests for ec-weather-alerts. All upstream HTTP is mocked — no network.
 * Live (real-API) tests live separately in tests/live.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  currentConditions,
  forecast,
  activeAlerts,
  type ToolSuccess,
} from "../src/tools.js";
import {
  parseConditions,
  parseForecast,
  parseAlertFeature,
  resolveForecastDate,
  humidex,
  windChill,
  distanceKm,
} from "../src/lib/eccc.js";
import { clearCache } from "../src/lib/cache.js";
import { resetQuota } from "../src/lib/quota.js";

// ---------------------------------------------------------------------------
// Mock fixtures (shaped like the real ECCC/Geogratis payloads seen 2026-10-04)
// ---------------------------------------------------------------------------

function mockCityPageFeature(opts: { sparse?: boolean } = {}) {
  const cc: Record<string, unknown> = opts.sparse
    ? {
        timestamp: { en: "2026-10-04T03:00:00Z" },
        temperature: { units: { en: "C" }, value: { en: 5 } },
        // no condition, no wind, no humidity, no station, no windChill
      }
    : {
        timestamp: { en: "2026-10-04T03:00:00Z", fr: "2026-10-04T03:00:00Z" },
        condition: { en: "Clear", fr: "Dégagé" },
        temperature: {
          unitType: { en: "metric" },
          units: { en: "C" },
          qaValue: { en: 100 },
          value: { en: 13.5, fr: 13.5 },
        },
        dewpoint: { units: { en: "C" }, value: { en: 9.1 } },
        relativeHumidity: { units: { en: "%" }, value: { en: 74 } },
        wind: {
          speed: { units: { en: "km/h" }, value: { en: 12, fr: 12 } },
          direction: { value: { en: "ESE", fr: "ESE" } },
          gust: { units: { en: "km/h" }, value: { en: 27 } },
        },
        station: {
          code: { en: "vas" },
          value: { en: "Toronto Pearson Int'l Airport", fr: "Aéroport int. Pearson" },
        },
        windChill: { value: { en: -1 } },
      };
  return {
    properties: {
      identifier: "on-143",
      name: { en: "Toronto", fr: "Toronto" },
      currentConditions: cc,
      forecastGroup: {
        timestamp: { en: "2026-10-03T23:00:00Z", fr: "2026-10-03T23:00:00Z" },
        forecasts: [
          {
            period: {
              value: { en: "Saturday night", fr: "samedi soir" },
              textForecastName: { en: "Tonight", fr: "Ce soir et cette nuit" },
            },
            temperatures: {
              temperature: [
                { units: { en: "C" }, class: { en: "low" }, value: { en: 8, fr: 8 } },
              ],
            },
            cloudPrecip: { en: "Clear." },
            abbreviatedForecast: { textSummary: { en: "Clear", fr: "Dégagé" } },
            textSummary: { en: "Clear. Fog patches developing overnight. Low 8." },
          },
          {
            period: {
              value: { en: "Sunday", fr: "dimanche" },
              textForecastName: { en: "Sunday", fr: "dimanche" },
            },
            temperatures: {
              temperature: [
                { units: { en: "C" }, class: { en: "high" }, value: { en: 21, fr: 21 } },
              ],
            },
            cloudPrecip: {
              en: "Sunny early in the morning then a mix of sun and cloud with 40 percent chance of showers early in the afternoon.",
            },
            abbreviatedForecast: { textSummary: { en: "Chance of showers" } },
            textSummary: { en: "Mix of sun and cloud with 40 percent chance of showers. High 21." },
          },
          {
            period: {
              value: { en: "Sunday night", fr: "dimanche soir" },
              textForecastName: { en: "Sunday night", fr: "dimanche soir" },
            },
            temperatures: {
              temperature: [
                { units: { en: "C" }, class: { en: "low" }, value: { en: 8, fr: 8 } },
              ],
            },
            cloudPrecip: { en: "Partly cloudy. 40 percent chance of showers in the evening." },
            abbreviatedForecast: { textSummary: { en: "Chance of showers" } },
            textSummary: { en: "Partly cloudy with 40 percent chance of showers. Low 8." },
          },
        ],
      },
    },
    geometry: { type: "Point", coordinates: [-79.38, 43.65] },
  };
}

function mockAlertFeature() {
  return {
    properties: {
      alert_code: "FROST",
      alert_type: "advisory",
      alert_name_en: "frost advisory",
      alert_short_name_en: "Frost (advisory)",
      publication_datetime: "2026-10-04T00:53:52.270Z",
      expiration_datetime: "2026-10-04T13:59:52.270Z",
      validity_datetime: "2026-10-04T00:53:52.270Z",
      event_end_datetime: "2026-10-04T13:00:00.000Z",
      alert_text_en: "Temperatures are expected to fall to near the freezing mark tonight.",
      risk_colour_en: "yellow",
      confidence_en: "High",
      feature_name_en: "Apsley - Woodview - Northern Peterborough County",
      province: "ON",
      status_en: "continued",
    },
    geometry: { type: "MultiPolygon", coordinates: [] },
  };
}

/** Build a fetch mock that routes by URL pattern. */
function mockFetchRouter() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes("geonames.json")) {
      if (u.includes("zzz-not-a-place")) return json({ items: [] });
      return json({ items: [{ name: "Toronto", latitude: 43.65, longitude: -79.38 }] });
    }
    if (u.includes("citypageweather-realtime")) {
      return json({ features: [mockCityPageFeature()] });
    }
    if (u.includes("weather-alerts")) {
      return json({ features: [mockAlertFeature()] });
    }
    throw new Error(`Unexpected URL in test: ${u}`);
  });
}

beforeEach(() => {
  clearCache();
  resetQuota();
  process.env.FREE_DAILY_LIMIT = "1000";
  vi.stubGlobal("fetch", mockFetchRouter());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FREE_DAILY_LIMIT;
});

function asSuccess(outcome: unknown): ToolSuccess {
  if ((outcome as { isError?: boolean }).isError) {
    throw new Error(`Expected success, got error: ${JSON.stringify(outcome)}`);
  }
  return outcome as ToolSuccess;
}

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

describe("feels-like math", () => {
  it("humidex(30, 20) ≈ 37.6 (ECCC formula)", () => {
    const h = humidex(30, 20);
    expect(h).toBeGreaterThan(37);
    expect(h).toBeLessThan(38.5);
  });

  it("windChill(0, 20) ≈ -5.2 (ECCC formula)", () => {
    const w = windChill(0, 20);
    expect(w).toBeGreaterThan(-6);
    expect(w).toBeLessThan(-4.5);
  });

  it("distanceKm is ~0 for identical points and sane for Toronto–Ottawa", () => {
    expect(distanceKm(43.65, -79.38, 43.65, -79.38)).toBeLessThan(0.001);
    const d = distanceKm(43.65, -79.38, 45.42, -75.7);
    expect(d).toBeGreaterThan(320);
    expect(d).toBeLessThan(380);
  });
});

describe("resolveForecastDate", () => {
  const issued = new Date("2026-10-03T23:00:00Z"); // a Saturday
  it("maps 'Tonight' to the issue date", () => {
    expect(resolveForecastDate("Saturday night", "Tonight", issued)).toBe("2026-10-03");
  });
  it("maps a weekday name to the next occurrence on/after issue date", () => {
    expect(resolveForecastDate("Sunday", "Sunday", issued)).toBe("2026-10-04");
    expect(resolveForecastDate("Monday night", "Monday night", issued)).toBe("2026-10-05");
  });
});

// ---------------------------------------------------------------------------
// Parsing with mocked payloads (incl. missing fields)
// ---------------------------------------------------------------------------

describe("parseConditions", () => {
  it("parses a full payload", () => {
    const c = parseConditions(mockCityPageFeature());
    expect(c.temp_c).toBe(13.5);
    expect(c.humidity_pct).toBe(74);
    expect(c.wind_kph).toBe(12);
    expect(c.wind_direction).toBe("ESE");
    expect(c.condition).toBe("Clear");
    expect(c.observed_at).toBe("2026-10-04T03:00:00Z");
    expect(c.station_name).toContain("Pearson");
    // ECCC's reported wind chill (-1) is ignored above 10°C, where it is
    // meaningless — feels-like falls back to the air temperature.
    expect(c.feels_like_c).toBe(13.5);
  });

  it("uses ECCC's reported wind chill when it is genuinely cold (<=10°C)", () => {
    const f = mockCityPageFeature();
    const cc = f.properties.currentConditions as Record<string, unknown>;
    (cc.temperature as Record<string, unknown>).value = { en: 5 };
    (cc.windChill as Record<string, unknown>).value = { en: -3 };
    const c = parseConditions(f);
    expect(c.feels_like_c).toBe(-3);
  });

  it("falls back to wind-chill formula when ECCC omits it (cold)", () => {
    const f = mockCityPageFeature({ sparse: true });
    // temp 5, no wind -> feels = temp
    const c = parseConditions(f);
    expect(c.temp_c).toBe(5);
    expect(c.feels_like_c).toBe(5);
    // missing fields degrade gracefully
    expect(c.condition).toBe("Not reported by ECCC");
    expect(c.wind_kph).toBeNull();
    expect(c.humidity_pct).toBeNull();
    expect(c.station_name).toBeNull();
  });

  it("computes humidex for hot weather without reported chill", () => {
    const f = mockCityPageFeature();
    const cc = f.properties.currentConditions as Record<string, unknown>;
    (cc.temperature as Record<string, unknown>).value = { en: 30 };
    (cc.dewpoint as Record<string, unknown>).value = { en: 20 };
    delete cc.windChill;
    const c = parseConditions(f);
    expect(c.feels_like_c).toBeGreaterThan(37);
    expect(c.feels_like_c).toBeLessThan(38.5);
  });
});

describe("parseForecast", () => {
  it("buckets 12-hour periods into 2 daily periods with highs/lows and PoP", () => {
    const { periods, issued_at } = parseForecast(mockCityPageFeature());
    expect(issued_at).toBe("2026-10-03T23:00:00Z");
    expect(periods).toHaveLength(2);
    expect(periods[0].date).toBe("2026-10-03");
    expect(periods[0].low_c).toBe(8);
    expect(periods[1].date).toBe("2026-10-04");
    expect(periods[1].high_c).toBe(21);
    expect(periods[1].low_c).toBe(8);
    expect(periods[1].pop_pct).toBe(40);
    expect(periods[1].condition).toContain("showers");
  });

  it("returns an empty periods list instead of crashing on malformed input", () => {
    const { periods } = parseForecast({ properties: {} });
    expect(periods).toEqual([]);
  });
});

describe("parseAlertFeature", () => {
  it("maps ECCC alert fields to the alert shape", () => {
    const a = parseAlertFeature(mockAlertFeature());
    expect(a.event).toBe("frost advisory");
    expect(a.severity).toBe("Moderate"); // yellow
    expect(a.headline).toBe("Frost (advisory)");
    expect(a.areas).toEqual(["Apsley - Woodview - Northern Peterborough County"]);
    expect(a.effective).toBe("2026-10-04T00:53:52.270Z");
    expect(a.expires).toBe("2026-10-04T13:59:52.270Z");
    expect(a.description).toContain("freezing mark");
  });

  it("maps red/orange colours to Severe/High", () => {
    const red = { ...mockAlertFeature(), properties: { ...mockAlertFeature().properties, risk_colour_en: "red" } };
    const orange = { ...mockAlertFeature(), properties: { ...mockAlertFeature().properties, risk_colour_en: "orange" } };
    expect(parseAlertFeature(red).severity).toBe("Severe");
    expect(parseAlertFeature(orange).severity).toBe("High");
  });
});

// ---------------------------------------------------------------------------
// Tool-level tests (mocked network)
// ---------------------------------------------------------------------------

describe("currentConditions tool", () => {
  it("resolves 'Toronto' via geocoding and returns real-shaped data", async () => {
    const out = asSuccess(await currentConditions("Toronto"));
    const sc = out.structuredContent;
    expect(sc.location_resolved).toContain("Toronto");
    expect(sc.temp_c).toBe(13.5);
    expect(sc.wind_direction).toBe("ESE");
    expect(sc.cached).toBe(false);
  });

  it("accepts 'lat,lon' directly", async () => {
    const out = asSuccess(await currentConditions("43.65,-79.38"));
    expect(out.structuredContent.temp_c).toBe(13.5);
    expect(String(out.structuredContent.location_resolved)).toContain("43.65");
  });

  it("serves the second identical query from cache with cached:true", async () => {
    await currentConditions("Toronto");
    const out = asSuccess(await currentConditions("Toronto"));
    expect(out.structuredContent.cached).toBe(true);
    expect(out.cached).toBe(true);
  });

  it("returns isError (not a crash) for a garbage location", async () => {
    const out = await currentConditions("zzz-not-a-place");
    expect(out.isError).toBe(true);
    const text = out.content[0].text;
    expect(text).toContain("Could not find a place");
  });
});

describe("forecast tool", () => {
  it("returns daily periods for 'Toronto'", async () => {
    const out = asSuccess(await forecast("Toronto"));
    const periods = out.structuredContent.periods as Array<Record<string, unknown>>;
    expect(periods.length).toBeGreaterThan(0);
    expect(periods[0]).toHaveProperty("date");
    expect(periods[0]).toHaveProperty("high_c");
    expect(periods[0]).toHaveProperty("low_c");
    expect(periods[0]).toHaveProperty("condition");
    expect(periods[0]).toHaveProperty("pop_pct");
  });

  it("works with 'lat,lon' input", async () => {
    const out = asSuccess(await forecast("43.65,-79.38"));
    const periods = out.structuredContent.periods as Array<Record<string, unknown>>;
    expect(periods.length).toBeGreaterThan(0);
  });
});

describe("activeAlerts tool", () => {
  it("queries province-wide for 'ON'", async () => {
    const out = asSuccess(await activeAlerts("ON"));
    expect(out.structuredContent.count).toBe(1);
    const alerts = out.structuredContent.alerts as Array<Record<string, unknown>>;
    expect(alerts[0].event).toBe("frost advisory");
    expect(alerts[0]).toHaveProperty("severity");
    expect(alerts[0]).toHaveProperty("headline");
    expect(alerts[0]).toHaveProperty("areas");
    expect(alerts[0]).toHaveProperty("effective");
    expect(alerts[0]).toHaveProperty("expires");
    expect(alerts[0]).toHaveProperty("description");
  });

  it("accepts lowercase province codes", async () => {
    const out = asSuccess(await activeAlerts("on"));
    expect(out.structuredContent.count).toBe(1);
  });

  it("geocodes a city name and intersects alerts at that point", async () => {
    const out = asSuccess(await activeAlerts("Toronto"));
    expect(out.structuredContent.count).toBe(1);
  });

  it("returns an empty list shape (not an error) when no alerts are active", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("geonames.json")) {
          return { ok: true, json: async () => ({ items: [{ name: "Toronto", latitude: 43.65, longitude: -79.38 }] }) };
        }
        return { ok: true, json: async () => ({ features: [] }) };
      }),
    );
    const out = asSuccess(await activeAlerts("Toronto"));
    expect(out.structuredContent.count).toBe(0);
    expect(out.structuredContent.alerts).toEqual([]);
  });
});

describe("freemium quota", () => {
  it("blocks calls after FREE_DAILY_LIMIT with the exact quota message", async () => {
    process.env.FREE_DAILY_LIMIT = "2";
    resetQuota();
    const first = await currentConditions("Toronto");
    const second = await forecast("Toronto");
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    const third = await activeAlerts("ON");
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toContain("Free quota exceeded (2/day). Subscribe to Pro for unlimited access.");
  });
});
