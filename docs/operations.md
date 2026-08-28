# Operations — Reiseplaner ohne Halluzination

## Rebuilding the OSRM graph

The graph (`osrm/data/bremen-latest.osrm*`) is generated, not committed (see `.gitignore`) —
~50 MB of derived files from a 21 MB source extract. To rebuild from scratch:

```bash
FORCE=1 bash osrm/build-graph.sh
```

`build-graph.sh` is otherwise idempotent — it skips a step whose output file already exists.
**Caveat discovered live during this repo's own build**: `osrm-partition` (OSRM v5.25.0) writes
an *interim* `bremen-latest.osrm.cells` file as part of computing the bisection — do not use that
file's presence to decide whether `osrm-customize` has already run (a real bug this repo's own
build hit: that check skipped `osrm-customize` entirely, leaving no `.osrm.mldgr`, which
`osrm-routed --algorithm mld` needs to actually serve routes). Check for `.osrm.mldgr` instead —
`build-graph.sh` already does this correctly now, but if you're writing your own variant, don't
repeat the mistake.

## Rotating the region/dataset

1. Update the URL + MD5 in `osrm/fetch-extract.sh` and `osrm/REGIONS.md`.
2. `FORCE=1 bash osrm/fetch-extract.sh && FORCE=1 bash osrm/build-graph.sh`.
3. Re-run `scripts/acceptance-check.sh` — the pinned distance/duration numbers in
   `osrm/REGIONS.md` and `bridge/test/osrmClient.test.js` will need updating to match the new
   dataset's actual output (they are NOT expected to survive a dataset change unchanged — a
   different OSM snapshot can shift a route by meters even over the same roads).
4. Update `TRAVEL_DATASET_LABEL` (compose env) and the checksum embedded in
   `scripts/acceptance-check.sh` / `run-demo.sh` selftest messaging.

Note: Geofabrik's `*-latest.osm.pbf` URLs 302-redirect to a dated filename (e.g.
`bremen-260827.osm.pbf`) — `fetch-extract.sh` already follows redirects (`curl -fSL`). Confirmed
live that the underlying bytes/checksum stayed identical to the original plan-time pin despite
the filename rotating — Geofabrik renames the "latest" pointer without necessarily republishing
new data every time.

## Rotating the LiteLLM key

1. Mint a new key (whoever holds the litellm-proxy maintainer role for this workspace can do
   this — see the workspace root `CLAUDE.md`/`docs/MAINTAINERS.md`).
2. Update `.env` (`LITELLM_API_KEY`) — never commit this file.
3. `./run-demo.sh down && ./run-demo.sh up` (env is read at container start).

## Health checks

```bash
docker compose -f compose.travel-demo.yml ps
docker exec $(docker compose -f compose.travel-demo.yml ps -q bridge) \
  node -e "require('http').get('http://127.0.0.1:8789/healthz',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(r.statusCode,d))})"
```

`osrm-car` has no host-published port by design (no origin exposes a host port — see the
workspace root `docs/ARCHITECTURE.md`), so it can only be reached from inside the compose
network (e.g. via `docker exec` into the `bridge` container, which is exactly what
`scripts/run-acceptance.js` does for its "bypass the bridge" cross-check).

## Deploying publicly (not yet done — needs operator confirmation)

When `travel.bunsenbrenner.org` is confirmed/provisioned:

1. Copy `CADS-DEMO-sort/Agent.Dockerfile` into this repo verbatim (it's already fully generic,
   not sort-specific — builds `ct-agent` from source, tracks the latest release tag).
2. Add a `travel-demo-agent` service to `compose.travel-demo.yml`, same shape as
   `CADS-DEMO-sort/compose.sort-demo.yml`'s own `sort-demo-agent` service
   (`CT_AGENT_HOSTNAME=travel.bunsenbrenner.org`, `CT_AGENT_ORIGIN=travel-demo-origin:443`).
3. Set `TRAVEL_CERT_DIR` (fullchain.pem+privkey.pem, issued CORE-side via deSEC DNS-01 — see
   `deploy/caddy/Caddyfile`'s own header comment for the Gelb-vs-Grün TLS-termination note).
3. `./run-demo.sh up` will then also bring up `travel-demo-origin` (Caddy).

## Nominatim usage policy — do not violate this

Real, enforced policy (operations.osmfoundation.org/policies/nominatim): max 1 req/s, identifying
User-Agent, no bulk geocoding, cache results. `bridge/lib/geocode.js` self-throttles and caches
in-memory by construction — do not remove that throttle to "speed things up", and do not point
load-testing traffic at the public Nominatim instance. If demo traffic grows enough that this
becomes a real constraint, self-host `mediagis/nominatim` instead (see `osrm/REGIONS.md`'s
Phase 2 note) rather than relaxing the throttle.
