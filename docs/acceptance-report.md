# Acceptance report — Reiseplaner ohne Halluzination

Generated: 2026-08-28T18:57:22.321Z
Dataset: bremen-latest.osm.pbf (md5 0061299ee69f4bce070ea86e416ddc93)
Overall: **PASS**

This is the output of `scripts/acceptance-check.sh` — a live, one-shot proof run against
real infrastructure (a real self-hosted OSRM engine, a real LiteLLM-backed model), not a
mock. See `README.md` and `osrm/REGIONS.md` for the full technical context.

## Step 2 — direct engine query (bypasses the bridge entirely)

Query `osrm-car:5000` directly (no bridge, no LLM) with the exact pinned acceptance-check
request (origin near Bremen Flughafen, destination near Vegesack, `exclude=motorway`),
and assert it reproduces the numbers pinned in `osrm/REGIONS.md` exactly.

- Expected: distance=23678.3 m, duration=2275.3 s
- Actual: distance=23678.3 m, duration=2275.3 s
- **PASS** — exact match required, no tolerance

<details><summary>Raw OSRM JSON (direct query, geometry coordinates omitted for brevity — full byte-for-byte response saved as `docs/acceptance-raw-direct.json`)</summary>

```json
{
  "code": "Ok",
  "routes": [
    {
      "geometry": {
        "type": "LineString",
        "coordinates": "[920 points omitted for report brevity -- full raw JSON saved alongside]"
      },
      "legs": [
        {
          "steps": [],
          "distance": 23678.3,
          "duration": 2275.3,
          "summary": "",
          "weight": 5553.9
        }
      ],
      "distance": 23678.3,
      "duration": 2275.3,
      "weight_name": "routability",
      "weight": 5553.9
    }
  ],
  "waypoints": [
    {
      "hint": "MgEAgIWLAIAAAAAAaQAAAAAAAAAAAAAAAAAAADfML0IAAAAAAAAAAAAAAABpAAAAAAAAAAAAAABrAAAA5hyGAE95KQMME4YAzHApAwAADwONX8__",
      "distance": 295.706428,
      "name": "",
      "location": [
        8.789222,
        53.049679
      ]
    },
    {
      "hint": "SmoBgFpqAYAcAAAAAAAAAPwBAAAAAAAA3rY9QQAAAADhBFRDAAAAABwAAAAAAAAA_AEAAAAAAABrAAAA_4eDAKZMKwP8eoMAbEIrAwgALxONX8__",
      "distance": 366.744137,
      "name": "",
      "location": [
        8.620031,
        53.169318
      ]
    }
  ]
}
```

</details>

## Step 3 — full pipeline through the bridge (free text -> LLM intent -> OSRM -> LLM format)

Request: `POST /api/plan {"text": "von Bremen Flughafen nach Vegesack, Autobahnen vermeiden"}`
HTTP status: 200

LLM-parsed intent:

```json
{
  "origin": "Bremen Flughafen",
  "destination": "Vegesack",
  "preference": "avoid_highways",
  "toolCallId": "call_yym5tdsj"
}
```

Note the free-text geocode resolves origin/destination to real Nominatim results near
(but not byte-identical to) the pinned coordinate pair above — a real geocoder result, not
the fixed pin. `verify()` below therefore checks the LLM's answer against the raw route
this SPECIFIC request actually received, not against the Step 2 fixture — that is the
correct check ("did the model's numbers match what it was handed"), and Step 2 above is
what already independently confirms the raw engine itself is unchanged.

### Raw OSRM output the bridge received and handed to the LLM

(geometry coordinates omitted for brevity — full byte-for-byte response saved as `docs/acceptance-raw-bridge.json`)

```json
{
  "geometry": {
    "type": "LineString",
    "coordinates": "[846 points omitted for report brevity -- full raw JSON saved alongside]"
  },
  "legs": [
    {
      "steps": [],
      "distance": 22593.7,
      "duration": 2126.4,
      "summary": "",
      "weight": 2128.4
    }
  ],
  "distance": 22593.7,
  "duration": 2126.4,
  "weight_name": "routability",
  "weight": 2128.4
}
```

Provenance stamp:

```json
{
  "engine": "osrm-backend v5.25.0 / MLD",
  "dataset": "bremen-latest (md5 0061299ee69f4bce070ea86e416ddc93)",
  "preference": "avoid_highways",
  "preference_description": "exclude=motorway (requires the MLD algorithm — see osrm/REGIONS.md)",
  "request_url": "http://osrm-car:5000/route/v1/driving/8.785471,53.0541542;8.6238803,53.1705249?overview=full&geometries=geojson&steps=false&exclude=motorway",
  "queried_at": "2026-08-28T18:57:23.801Z"
}
```

### LLM-formatted answer (side by side with the raw facts above — this is the demo's whole point)

```text
<ROUTE_FACTS>{"distance_m":22594,"duration_s":2126}</ROUTE_FACTS>
Die Route von Bremen Flughafen nach Vegesack vermeidet Autobahnen, wie gewünscht. Die Distanz beträgt 22.594 Meter und die Dauer 2.126 Sekunden. Diese Route wurde mit der Präferenz "avoid_highways" berechnet, was bedeutet, dass keine Autobahnen (motorways) genutzt werden.
```

## Step 4 — mechanical verification (`verify.js`)

Overall: **PASS**

| check | expected | actual | pass |
|---|---|---|---|
| facts.distance_m == round(raw.distance) | 22594 | 22594 | ✓ |
| facts.duration_s == round(raw.duration) | 2126 | 2126 | ✓ |

**Warnings (soft, do not fail the run):**
- prose contains "2.126 Sekunden" — not within an exact-seconds match of the route duration (2126 s); likely an unrelated number, flagged not failed

## Conclusion

The LLM's formatted answer's numbers trace back exactly (after rounding) to the real OSRM engine's own output for this request. The LLM never computed, estimated, or invented a distance or duration — it only formatted numbers the routing engine produced.

