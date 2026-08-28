# Data pin

v1 of this demo runs on exactly one region and one profile (car). See the top-level technical
plan (CADS-agent-marketplace#28) for the full rationale — this file just records the exact,
reproducible pin so nobody has to re-derive it.

## Region: Bremen

- Source: [Geofabrik](https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf)
- File: `bremen-latest.osm.pbf`
- MD5: `0061299ee69f4bce070ea86e416ddc93`
- Size: ~21 MB
- Includes real motorways (A1, A27, A281), enough to exercise `exclude=motorway`
  ("avoid highways") meaningfully.

Geofabrik ships a `.md5` sidecar per extract; `fetch-extract.sh` verifies against the value
above rather than trusting the download blindly.

## Profile: car only (v1)

Built with the stock `car.lua` profile shipped in `osrm/osrm-backend`. Each OSRM profile needs
its own separately-extracted `.osrm` graph — bike/foot are a **Phase 2** (mechanically identical:
new profile file, new `osrm-extract` run, new `osrm-routed` service), not a runtime flag on the
same graph. Not built in this slice.

## Algorithm: MLD (Multi-Level Dijkstra), not CH

`osrm-partition` + `osrm-customize` (MLD), **not** `osrm-contract` (CH). This is not a style
choice — `exclude=<class>` (used for `avoid_highways`/`avoid_tolls`) only works with MLD.
Verified live against the public `router.project-osrm.org` demo instance during planning: it
runs CH and rejects `exclude=motorway` outright:

```json
{"code":"InvalidValue","message":"Exclude flag combination is not supported."}
```

That is why this demo self-hosts rather than calling the public demo instance for those two
preferences (the public instance is still fine as an independent cross-check for `fastest` /
`shortest_distance`, which don't need `exclude`).

## Fixed acceptance-check request

Origin `8.7867,53.0475` (near Bremen Flughafen) → destination `8.6167,53.1667` (near
Bremen-Vegesack), `profile=driving`.

| preference | distance (m) | duration (s) | notes |
|---|---|---|---|
| `fastest` | 29606.9 | 2041.3 | no extra params |
| `avoid_highways` | 23678.3 | 2275.3 | `exclude=motorway` — shorter distance, longer time: surface roads, a real trade-off |

These two rows were captured live against a real self-hosted `osrm-routed --algorithm mld`
instance during planning and are re-verified by `bridge/test/osrmClient.test.js` (CI, runs
against the real container) and by `scripts/acceptance-check.sh` (the one-shot proof run).

## Geocode pin

"Bremen Hauptbahnhof" → Nominatim resolves to `lat 53.0831456, lon 8.8135421` (well inside the
loaded graph). Pinned as a fixture in `bridge/test/fixtures/geocode-bremen-hbf.json`; unit tests
mock Nominatim and never call the live service (see `docs/operations.md` for the usage-policy
reasoning: Nominatim's public instance is rate-limited to 1 req/s and must not be bulk-called).

## Phase 2 (not built, not verified past checksum)

`niedersachsen-latest.osm.pbf`, md5 `9ea0580046ace0ad27104a3b7fdac871` — a scale-up candidate
identified during planning. Large-file (~330 MB) downloads through this dev sandbox's outbound
proxy 502'd repeatedly while the small Bremen file worked fine; that looked like a sandbox-egress
limit rather than a Geofabrik problem, but this was never confirmed against the real deploy host.
Use `curl -C -` (resumable) either way if/when this is picked up.
