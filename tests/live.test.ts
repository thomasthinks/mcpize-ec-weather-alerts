/**
 * LIVE integration tests — hit the real ECCC + Geogratis APIs (no mocks).
 * These verify the server works against production data, per the build brief:
 *  - "Toronto" returns real conditions/forecast
 *  - "43.65,-79.38" works
 *  - active_alerts("ON") returns the real alert list shape (count may be 0)
 *  - garbage location -> graceful isError, never a crash
 */
import { describe, it, expect, beforeEach } from "vitest";
import { currentConditions, forecast, activeAlerts } from "../src/tools.js";
import { clearCache } from "../src/lib/cache.js";
import { resetQuota } from "../src/lib/quota.js";

const T = 30000; // upstream calls can take a few seconds

beforeEach(() => {
  clearCache();
  resetQuota();
  process.env.FREE_DAILY_LIMIT = "10000";
});

describe("live: currentConditions", () => {
  it("Toronto returns real conditions", async () => {
    const out = await currentConditions("Toronto");
    expect(out.isError).toBeFalsy();
    const sc = (out as { structuredContent: Record<string, unknown> }).structuredContent;
    console.log("LIVE conditions:", JSON.stringify(sc));
    expect(String(sc.location_resolved)).toContain("Toronto");
    expect(typeof sc.temp_c).toBe("number");
    expect(sc.temp_c as number).toBeGreaterThan(-60);
    expect(sc.temp_c as number).toBeLessThan(60);
    expect(typeof sc.condition).toBe("string");
    expect(sc.station_name).toBeTruthy();
  }, T);

  it("43.65,-79.38 works without geocoding", async () => {
    const out = await currentConditions("43.65,-79.38");
    expect(out.isError).toBeFalsy();
    const sc = (out as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(typeof sc.temp_c).toBe("number");
  }, T);
});

describe("live: forecast", () => {
  it("Toronto returns a real multi-day forecast", async () => {
    const out = await forecast("Toronto");
    expect(out.isError).toBeFalsy();
    const sc = (out as { structuredContent: Record<string, unknown> }).structuredContent;
    const periods = sc.periods as Array<Record<string, unknown>>;
    console.log("LIVE forecast periods:", JSON.stringify(periods));
    expect(periods.length).toBeGreaterThanOrEqual(2);
    expect(periods[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, T);

  it("43.65,-79.38 returns a forecast", async () => {
    const out = await forecast("43.65,-79.38");
    expect(out.isError).toBeFalsy();
  }, T);
});

describe("live: activeAlerts", () => {
  it("ON returns the real alert list shape", async () => {
    const out = await activeAlerts("ON");
    expect(out.isError).toBeFalsy();
    const sc = (out as { structuredContent: Record<string, unknown> }).structuredContent;
    const alerts = sc.alerts as Array<Record<string, unknown>>;
    expect(Array.isArray(alerts)).toBe(true);
    expect(sc.count).toBe(alerts.length);
    console.log(`LIVE alerts: ${alerts.length} active in ON`);
    for (const a of alerts.slice(0, 3)) {
      expect(a).toHaveProperty("event");
      expect(a).toHaveProperty("severity");
      expect(a).toHaveProperty("headline");
      expect(a).toHaveProperty("areas");
      expect(a).toHaveProperty("effective");
      expect(a).toHaveProperty("expires");
      expect(a).toHaveProperty("description");
      console.log("  -", a.severity, "|", a.event, "|", (a.areas as string[])[0]);
    }
  }, T);

  it("Toronto returns alerts intersecting that point", async () => {
    const out = await activeAlerts("Toronto");
    expect(out.isError).toBeFalsy();
  }, T);
});

describe("live: garbage input", () => {
  it("zzz-not-a-place returns isError, not a crash", async () => {
    const out = await currentConditions("zzz-not-a-place");
    expect(out.isError).toBe(true);
    console.log("LIVE garbage-location error:", out.content[0].text);
  }, T);
});
