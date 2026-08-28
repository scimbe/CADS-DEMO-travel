# Reiseplaner ohne Halluzination

Part of the bunsenbrenner.org demo portfolio ([tracking issue](https://github.com/scimbe/CADS-agent-marketplace/issues/28)).

A travel-routing demo whose entire point is proving the LLM does **not** invent routes or travel
times. A real, self-hosted [OSRM](https://project-osrm.org/) routing engine, running on real
OpenStreetMap data for the Bremen region, computes the actual route and its distance/duration.
The LLM only ever sees that engine's already-computed output — it formats it into German prose
and picks the wording that matches the user's stated preference ("avoid highways", "shortest
route", …). It never computes, estimates, or invents a number.

Two structural guardrails make this true by construction, not by hoping the model behaves:

1. **The bridge, not the model, executes the route query.** The LLM's first turn only extracts
   intent (origin, destination, preference) via a tool call; the bridge (`bridge/server.js`)
   executes that tool itself and hands the model the OSRM result as data, never lets the model
   touch coordinates or distances directly.
2. **The model's answer is contractually required to open with a strict, machine-checkable
   `<ROUTE_FACTS>{"distance_m":N,"duration_s":N}</ROUTE_FACTS>` line**, whose two numbers are
   mechanically verified (`bridge/lib/verify.js`) against the same JSON the model was handed.

See `docs/acceptance-report.md` for a full, real run: the raw OSRM JSON and the LLM-formatted
answer, side by side, with every number checked.

## What's real vs. what's a known limitation

**Real, built, and tested:**
- A self-hosted OSRM `osrm-routed` service (v5.25.0, MLD algorithm) on a real extracted,
  partitioned, customized graph of the Bremen region (real OpenStreetMap data via Geofabrik).
- A real 2-turn LiteLLM tool-calling pipeline against the shared budget-capped
  `local-devstral-small2` key.
- Real Nominatim geocoding (rate-limited to 1 req/s, bounded to the Bremen bbox, cached).
- The full request path (free text → LLM intent → real OSRM query → LLM format → mechanical
  verify) has been run live end to end — see `docs/acceptance-report.md`.
- 38 automated tests (`bridge/test/`), including a live integration test against the real OSRM
  engine and a negative-control fixture that proves `verify.js` actually has teeth (it must FAIL
  a deliberately-hallucinated answer, not just pass a good one).

**Known limitations, disclosed rather than hidden:**
- **Car profile only, Bremen only (v1 scope).** Bike/foot profiles and a larger region are a
  mechanically identical Phase 2 (new `osrm-extract` run, new `osrm-routed` service per profile)
  — see `osrm/REGIONS.md`.
- **`avoid_tolls` is not separately live-verified**: it uses the identical `exclude=` mechanism as
  `avoid_highways` (confirmed in `car.lua`'s source), but the Bremen extract has no toll roads to
  exercise it against.
- **Not yet publicly deployed.** `travel.bunsenbrenner.org` needs operator confirmation before
  provisioning (per the workspace's own operating rules) — see "Deployment status" below.
  `compose.travel-demo.yml` deliberately has NO `ct-agent` service yet for that reason (copy
  `CADS-DEMO-sort/Agent.Dockerfile`'s pattern verbatim when that lands — it's already generic).
- **The prose-number scan in `verify.js` is a best-effort heuristic**, not a full German
  number-format parser — it's designed to be a *soft warning*, not a hard gate (the hard gate is
  the `<ROUTE_FACTS>` block). A real, live example of exactly this limitation is captured in
  `docs/acceptance-report.md`: the LLM wrote "22.594 Meter" (German thousands-separator dot), the
  scanner isn't spelled-out-unit-aware for "Meter", and separately misread "2.126 Sekunden" as
  the number 2.126 rather than 2126 — both correctly demoted to non-blocking warnings rather than
  false failures, exactly as designed.
- **`site/` has not been tested through Caddy/a real browser** — only the bridge's HTTP API has
  been exercised live (`docs/acceptance-report.md`). The static page + `app.js` are written but
  unverified beyond a read-through; verify visually before treating the UI itself as proven.

## Repo layout

```
osrm/            OSRM engine: Dockerfile, fetch/build scripts, the data pin (REGIONS.md)
bridge/          The whole API surface — Node, zero external dependencies (node:http, node:test)
  lib/           preferences.js, osrmClient.js, geocode.js, llmFormat.js, verify.js
  test/          38 tests, incl. fixtures (a good AND a deliberately-hallucinated LLM answer)
site/            Static page — raw-engine panel and LLM-answer panel side by side
scripts/         acceptance-check.sh (the deliverable proof run) + its two Node helpers
deploy/caddy/    Caddyfile (not yet deployed, see above)
docs/            onboarding.md, operations.md, acceptance-report.md (generated)
```

## Preference vocabulary

| preference | OSRM params | status |
|---|---|---|
| `fastest` | none | live-verified: 29606.9 m / 2041.3 s on the pinned Bremen fixture |
| `avoid_highways` | `exclude=motorway` | live-verified: 23678.3 m / 2275.3 s — shorter distance, longer time, a real trade-off |
| `avoid_tolls` | `exclude=toll` | same mechanism, not separately live-testable (no toll roads in Bremen) |
| `shortest_distance` | `alternatives=true`, picks `min(distance)` | mechanism verified against real OSRM alternates |
| `fastest_alternative` | `alternatives=true`, picks `min(duration)` | same mechanism |

Why self-host rather than call the public `router.project-osrm.org` demo instance: it runs the CH
algorithm and rejects `exclude=motorway` outright (`InvalidValue: Exclude flag combination is not
supported`), confirmed live during planning. `exclude=` only works with MLD — see
`osrm/REGIONS.md` for the full story.

## Setup

1. **Build the OSRM graph** (one-time, ~1-2 minutes on this dataset size):
   ```bash
   bash osrm/fetch-extract.sh   # downloads + checksum-verifies bremen-latest.osm.pbf (~21 MB)
   bash osrm/build-graph.sh     # osrm-extract -> osrm-partition -> osrm-customize (MLD)
   ```
2. **LLM credentials** — copy a LiteLLM key into `.env` (never commit this file):
   ```bash
   cp /path/to/your/litellm.env .env   # needs LITELLM_BASE_URL, LITELLM_API_KEY, LITELLM_DEFAULT_MODEL
   chmod 600 .env
   ```
3. **Run it:**
   ```bash
   ./run-demo.sh up       # builds + starts osrm-car + bridge (Caddy too if TRAVEL_CERT_DIR is set)
   ./run-demo.sh status
   ./run-demo.sh down
   ```
4. **Run the tests:**
   ```bash
   cd bridge && npm test                              # unit tests only (no live OSRM needed for most)
   OSRM_BASE_URL=http://127.0.0.1:5000 npm test        # incl. the live osrmClient integration test
   ```
5. **Run the acceptance check** (the proof deliverable):
   ```bash
   ./scripts/acceptance-check.sh
   ```
   Writes `docs/acceptance-report.md` (+ `docs/acceptance-raw-{direct,bridge}.json`, the untruncated
   raw OSRM responses). Exits non-zero on any hard fail.

## Deployment status

**Not yet publicly deployed.** Provisioning `travel.bunsenbrenner.org` (ct-agent tunnel + edge
route) needs operator confirmation before anything outward-facing goes live, per this workspace's
standing operating rules. This build round scoped to the acceptance bar — real routing, real
anti-hallucination proof — not public exposure. `compose.travel-demo.yml` includes a
`travel-demo-origin` (Caddy) service for when that's ready, but no `ct-agent` service yet (see
"Known limitations" above for exactly what to copy in when it's time).

## Anti-hallucination contract, precisely

- `POST /api/plan {"text": "..."}` → bridge sends the LLM one tool, `plan_route(origin,
  destination, preference)`, with `tool_choice` forced and `temperature: 0`. The model's first
  turn ONLY extracts intent; it is explicitly instructed never to compute a route fact at this
  step.
- The bridge (not the model) executes `plan_route`: `geocode.js` resolves place names via
  Nominatim (bounded to the Bremen bbox), `preferences.js` maps the preference to fixed OSRM
  params, `osrmClient.js` calls the self-hosted engine and returns its JSON **untouched**.
- The model's second turn receives that JSON as a tool result, plus a provenance stamp (engine
  version, dataset checksum, exact request URL, timestamp), and is instructed: *every number in
  your answer must come from this JSON, verbatim after unit conversion — never computed,
  estimated, or invented — and must open with an exact `<ROUTE_FACTS>{...}</ROUTE_FACTS>` line.*
- `verify.js` mechanically checks that line against the real route object, exact after rounding.
  A best-effort scan of the surrounding prose flags (but doesn't hard-fail) other numbers unless
  they actively *contradict* the facts block.
- `bridge/test/verify.test.js` proves this check has teeth: it MUST pass a good fixture and MUST
  FAIL a deliberately-hallucinated one — both fixtures are checked in.
