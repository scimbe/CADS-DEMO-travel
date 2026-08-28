#!/usr/bin/env node
"use strict";

/** Turns run-acceptance.js's JSON output into docs/acceptance-report.md — the handover
 *  deliverable for CADS-agent-marketplace#28's "Pre-Testing by the maintainer" step. Runs on the
 *  HOST (not in a container) since it only does file I/O. Usage:
 *    node scripts/render-report.js <result.json> <checksum> > docs/acceptance-report.md
 */
const fs = require("node:fs");

const [, , resultPath, datasetMd5] = process.argv;
if (!resultPath) {
  console.error("usage: render-report.js <result.json> [dataset-md5]");
  process.exit(2);
}
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));

function json(obj) {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

/** The full route geometry is a 1000+-point polyline -- real data, but noise for a report whose
 *  job is proving the DISTANCE/DURATION numbers weren't invented. Strips geometry.coordinates
 *  (replacing with a length note) from a shallow-cloned route/response before embedding; the
 *  untouched raw response is still saved alongside (see acceptance-check.sh). */
function withoutGeometry(value) {
  const clone = JSON.parse(JSON.stringify(value));
  const stripRoute = (route) => {
    if (route?.geometry?.coordinates) {
      route.geometry = { type: route.geometry.type, coordinates: `[${route.geometry.coordinates.length} points omitted for report brevity -- full raw JSON saved alongside]` };
    }
  };
  if (clone?.routes) clone.routes.forEach(stripRoute);
  else stripRoute(clone);
  return clone;
}

const direct = result.direct_query?.raw;
const directRoute = direct?.routes?.[0];
const plan = result.bridge_plan?.response;
const verify = plan?.verify;

const docsDir = require("node:path").join(__dirname, "..", "docs");
fs.writeFileSync(require("node:path").join(docsDir, "acceptance-raw-direct.json"), JSON.stringify(direct, null, 2));
fs.writeFileSync(require("node:path").join(docsDir, "acceptance-raw-bridge.json"), JSON.stringify(plan?.picked_route, null, 2));

const lines = [];
lines.push("# Acceptance report — Reiseplaner ohne Halluzination");
lines.push("");
lines.push(`Generated: ${result.generated_at}`);
lines.push(`Dataset: bremen-latest.osm.pbf${datasetMd5 ? ` (md5 ${datasetMd5})` : ""}`);
lines.push(`Overall: **${result.overall_pass ? "PASS" : "FAIL"}**`);
lines.push("");
lines.push("This is the output of `scripts/acceptance-check.sh` — a live, one-shot proof run against");
lines.push("real infrastructure (a real self-hosted OSRM engine, a real LiteLLM-backed model), not a");
lines.push("mock. See `README.md` and `osrm/REGIONS.md` for the full technical context.");
lines.push("");

lines.push("## Step 2 — direct engine query (bypasses the bridge entirely)");
lines.push("");
lines.push("Query `osrm-car:5000` directly (no bridge, no LLM) with the exact pinned acceptance-check");
lines.push("request (origin near Bremen Flughafen, destination near Vegesack, `exclude=motorway`),");
lines.push("and assert it reproduces the numbers pinned in `osrm/REGIONS.md` exactly.");
lines.push("");
lines.push(`- Expected: distance=${result.direct_pin_check?.expected?.distance} m, duration=${result.direct_pin_check?.expected?.duration} s`);
lines.push(`- Actual: distance=${result.direct_pin_check?.actual?.distance} m, duration=${result.direct_pin_check?.actual?.duration} s`);
lines.push(`- **${result.direct_pin_check?.pass ? "PASS" : "FAIL"}** — exact match required, no tolerance`);
lines.push("");
lines.push("<details><summary>Raw OSRM JSON (direct query, geometry coordinates omitted for brevity — full byte-for-byte response saved as `docs/acceptance-raw-direct.json`)</summary>\n");
lines.push(json(withoutGeometry(direct)));
lines.push("\n</details>");
lines.push("");

lines.push("## Step 3 — full pipeline through the bridge (free text -> LLM intent -> OSRM -> LLM format)");
lines.push("");
lines.push(`Request: \`POST /api/plan {"text": "von Bremen Flughafen nach Vegesack, Autobahnen vermeiden"}\``);
lines.push(`HTTP status: ${result.bridge_plan?.status}`);
lines.push("");
lines.push("LLM-parsed intent:");
lines.push("");
lines.push(json(plan?.intent));
lines.push("");
lines.push("Note the free-text geocode resolves origin/destination to real Nominatim results near");
lines.push("(but not byte-identical to) the pinned coordinate pair above — a real geocoder result, not");
lines.push("the fixed pin. `verify()` below therefore checks the LLM's answer against the raw route");
lines.push("this SPECIFIC request actually received, not against the Step 2 fixture — that is the");
lines.push("correct check (\"did the model's numbers match what it was handed\"), and Step 2 above is");
lines.push("what already independently confirms the raw engine itself is unchanged.");
lines.push("");

lines.push("### Raw OSRM output the bridge received and handed to the LLM");
lines.push("");
lines.push("(geometry coordinates omitted for brevity — full byte-for-byte response saved as `docs/acceptance-raw-bridge.json`)");
lines.push("");
lines.push(json(withoutGeometry(plan?.picked_route)));
lines.push("");
lines.push("Provenance stamp:");
lines.push("");
lines.push(json(plan?.provenance));
lines.push("");

lines.push("### LLM-formatted answer (side by side with the raw facts above — this is the demo's whole point)");
lines.push("");
lines.push("```text");
lines.push(plan?.llm_answer || "(no answer)");
lines.push("```");
lines.push("");

lines.push("## Step 4 — mechanical verification (`verify.js`)");
lines.push("");
lines.push(`Overall: **${verify?.pass ? "PASS" : "FAIL"}**`);
lines.push("");
lines.push("| check | expected | actual | pass |");
lines.push("|---|---|---|---|");
for (const c of verify?.checks || []) {
  lines.push(`| ${c.name} | ${c.expected} | ${c.actual ?? c.impliedM ?? c.impliedS ?? ""} | ${c.pass ? "✓" : "✗"} |`);
}
lines.push("");
if (verify?.hardFails?.length) {
  lines.push("**Hard fails:**");
  for (const f of verify.hardFails) lines.push(`- ${f}`);
  lines.push("");
}
if (verify?.warnings?.length) {
  lines.push("**Warnings (soft, do not fail the run):**");
  for (const w of verify.warnings) lines.push(`- ${w}`);
  lines.push("");
}

lines.push("## Conclusion");
lines.push("");
lines.push(
  result.overall_pass
    ? "The LLM's formatted answer's numbers trace back exactly (after rounding) to the real OSRM " +
      "engine's own output for this request. The LLM never computed, estimated, or invented a " +
      "distance or duration — it only formatted numbers the routing engine produced."
    : "FAILED — see hard fails above. Do not treat this build as meeting the anti-hallucination " +
      "acceptance bar until this is fixed and this script is re-run.",
);
lines.push("");

process.stdout.write(lines.join("\n") + "\n");
