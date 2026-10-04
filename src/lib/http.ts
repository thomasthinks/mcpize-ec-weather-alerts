/**
 * Low-level HTTP helpers for calling ECCC + Geogratis (both keyless).
 * Never throws raw network errors to tool handlers — wraps them in UpstreamError.
 */

export const FETCH_TIMEOUT_MS = 10_000;

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export class LocationNotFoundError extends Error {
  constructor(public readonly input: string) {
    super(`Could not find a place named "${input}" in Canada.`);
    this.name = "LocationNotFoundError";
  }
}

/**
 * Fetch JSON with a hard 10s timeout. Throws UpstreamError on any failure.
 */
export async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "Accept": "application/json", "User-Agent": "ec-weather-alerts/1.0 (MCPize server)" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(
      `Could not reach the weather data service (${msg}).`,
      "The service may be temporarily unavailable. Try again in a minute.",
    );
  }
  if (!res.ok) {
    throw new UpstreamError(
      `The weather data service returned HTTP ${res.status}.`,
      res.status >= 500
        ? "The service is having problems. Try again in a few minutes."
        : "The request was rejected by the service. Try a different location.",
    );
  }
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(
      "The weather data service returned an unreadable response.",
      "Try again in a moment — the service may be updating its data.",
    );
  }
}
