# ec-weather-alerts

[![MCPize](https://mcpize.com/badge/@mcpize/mcpize?type=hosted)](https://mcpize.com)

Live **Environment Canada** weather for any Canadian location: current conditions,
5-day forecast, and active weather alerts — straight from ECCC's official data,
not a language model's best guess. Keyless, free-tier friendly.

## What it does

Accepts a Canadian city name (e.g. `Toronto`), raw coordinates (`43.65,-79.38`),
or a province code (`ON`, alerts only). City names are geocoded with the NRC
Geogratis service, then the nearest Environment Canada city-page reporting
location is located via the ECCC GeoMet API, and live conditions/forecast/alerts
are pulled for that location.

## Tools

| Tool | Input | Returns |
|------|-------|---------|
| `current_conditions` | `location` (city name or `lat,lon`) | `temp_c`, `feels_like_c`, `humidity_pct`, `wind_kph`, `wind_direction`, `condition`, `observed_at`, `station_name`, `location_resolved` |
| `forecast` | `location` (city name or `lat,lon`) | 5 daily periods: `date`, `high_c`, `low_c`, `condition`, `pop_pct` (chance of precipitation), plus `issued_at` |
| `active_alerts` | `location` (city name, `lat,lon`, or province code like `ON`) | `alerts` (`event`, `severity`, `headline`, `areas`, `effective`, `expires`, `description`) and `count` |

All tools return structured JSON (`content` + `structuredContent`) and a
`cached` flag showing whether the answer came from the in-process cache.

## Data sources

- **ECCC GeoMet OGC API** — `https://api.weather.gc.ca`, free, no API key.
  Collections actually used (verified 2026-10-04 against the live API):
  - `citypageweather-realtime` ("City Page Weather [experimental]") —
    `GET /collections/citypageweather-realtime/items?f=json&bbox=…` returns the
    844 ECCC city-page points; each feature carries
    `properties.currentConditions` (temperature, humidity, wind, condition,
    station) and `properties.forecastGroup.forecasts` (12-hour forecast periods
    with high/low temps, condition text, and PoP phrases).
  - `weather-alerts` ("Weather Alerts") —
    `GET /collections/weather-alerts/items?f=json&province=ON` for province-wide
    queries, or `&bbox=…` for point intersection of active alert polygons.
    Fields used: `alert_name_en`, `alert_short_name_en`, `risk_colour_en`
    (mapped to severity), `feature_name_en`, `publication_datetime`,
    `expiration_datetime`, `alert_text_en`.
  - Docs: https://eccc-msc.github.io/open-data/msc-data/citypage-weather/readme_citypageweather_en/
- **NRC Geogratis geocoder** — `https://geogratis.gc.ca/services/geoname/en/geonames.json?q=<city>&concise=CITY`
  (falls back to a query without `concise=CITY`); takes the top result's
  `latitude`/`longitude`. Skipped entirely when the input is `lat,lon`.

Caches: conditions 30 min, forecast 2 h, alerts 15 min (`cached:true` on hits).

Feels-like: uses ECCC's reported wind chill when temp ≤ 10 °C; otherwise
computes wind chill (ECCC formula) when cold and windy, humidex
(temp + dewpoint formula) when ≥ 20 °C, else the air temperature.

## Pricing

- **Free** — $0/month, 100 queries/day (enforced in code; `FREE_DAILY_LIMIT` env override, default 100)
- **Pro** — $9/month, unlimited
- x402 per-call pricing is disabled.

## Limitations

- **ECCC data only** — coverage is Canada-wide but station/city-page density
  varies; remote areas resolve to the nearest reporting location, which can be
  tens of kilometres away (the resolved location is always named in
  `location_resolved`).
- Alerts are **ECCC-issued public alerts**; severity is derived from ECCC's
  risk colour (red → Severe, orange → High, yellow → Moderate).
- Not for life-safety or aviation decisions — always check
  https://weather.gc.ca directly for critical situations.
- Geocoding covers Canadian place names via Geogratis; ambiguous names take
  the top-ranked result — prefer `lat,lon` when precision matters.
- `citypageweather-realtime` is labelled experimental by ECCC; field names have
  been stable, but the server parses defensively (missing fields → `null`, never
  a crash).

## Development

```bash
npm install
npm run dev      # start with hot reload
npm test         # unit + live integration tests
npm run build    # compile to dist/
```

Run `bash test-mcp.sh` (after starting the server) for the MCP protocol smoke test.
