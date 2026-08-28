# Onboarding — Reiseplaner ohne Halluzination

New to this repo? Read `README.md` first — it has the full picture, including what's real vs.
what's a known limitation. This file is the practical "get it running on your machine" walkthrough.

## Prerequisites

- Docker (with `docker compose`)
- `curl`, `node` (v20+; developed/tested on v24.10.0)
- A LiteLLM-compatible endpoint + API key for `/api/plan` (a shared, budget-capped key for the
  demo-portfolio build round; ask the operator/whoever holds the ops role for a real deployment key)

## First run, step by step

```bash
git clone https://github.com/scimbe/CADS-DEMO-travel.git
cd CADS-DEMO-travel

# 1. Build the routing graph (downloads ~21 MB, verifies checksum, then extract/partition/customize)
bash osrm/fetch-extract.sh
bash osrm/build-graph.sh
# expect: osrm/data/bremen-latest.osrm.mldgr to exist when done — that's the file
# osrm-routed --algorithm mld actually needs; its absence is what a real bug during this repo's
# own build looked like (see osrm/build-graph.sh's own comment for the story).

# 2. LLM credentials
cp /path/to/litellm.env .env
chmod 600 .env
# .env needs: LITELLM_BASE_URL, LITELLM_API_KEY, LITELLM_DEFAULT_MODEL

# 3. Start it
./run-demo.sh up
./run-demo.sh status

# 4. Prove it works
./scripts/acceptance-check.sh
```

## Where things live

- `osrm/` — the routing engine. `REGIONS.md` is the exact data pin (region, checksum, the fixed
  acceptance-check request and its expected numbers). Nobody should have to re-derive these.
- `bridge/` — the whole API surface. `server.js` is HTTP wiring only; the actual logic
  (`server.lib.js` + `lib/*.js`) is unit-testable without a live server. Read `lib/verify.js`
  first if you want to understand the anti-hallucination mechanism specifically.
- `bridge/test/` — 38 tests. `verify.test.js` is the load-bearing one: it proves the mechanical
  check actually catches a hallucinated answer, not just passes a good one.
- `site/` — the static page. Renders the raw-engine panel and the LLM-answer panel side by side.
- `scripts/acceptance-check.sh` — the one-shot proof run. Not a unit test; a live, human-readable
  deliverable (`docs/acceptance-report.md`).

## Common tasks

**Rebuild the graph after a data pin change** — see `docs/operations.md`.

**Rotate the LiteLLM key** — update `.env`, then `./run-demo.sh down && ./run-demo.sh up` (the
bridge reads it at container start, not per-request).

**Add a new preference** (e.g. `avoid_ferries`) — add one entry to `bridge/lib/preferences.js`'s
`PREFERENCES` table (no other file needs to change; `PLAN_ROUTE_TOOL`'s enum in `llmFormat.js`
derives from `PREFERENCE_NAMES` automatically), then add a `preferences.test.js` case.

**Add bike/foot profiles (Phase 2)** — see `osrm/REGIONS.md`'s Phase 2 note: each profile needs
its own `osrm-extract` run and its own `osrm-routed` service; not a runtime flag on the existing
graph.
