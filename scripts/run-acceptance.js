#!/usr/bin/env node
"use strict";

/**
 * Runs INSIDE the bridge container (see acceptance-check.sh, which docker-compose-cp's this
 * file in and execs it there) so it can reach osrm-car:5000 directly, on the compose network,
 * with no host port ever published for it — consistent with the platform's "no origin exposes a
 * host port" rule. Two genuinely separate request paths query the same engine:
 *
 *   (a) a raw fetch() straight to osrm-car:5000, bypassing server.js's HTTP handlers entirely
 *   (b) the bridge's own POST /api/plan, over loopback to the ALREADY-RUNNING server.js process
 *       in this same container (PID 1) — full path: LLM intent parse -> bridge's own OSRM call
 *       -> LLM format -> verify()
 *
 * Prints ONE JSON blob to stdout (only) so the caller can build the acceptance report from it;
 * all narration goes to stderr.
 */

const ORIGIN = { lon: 8.7867, lat: 53.0475 };
const DESTINATION = { lon: 8.6167, lat: 53.1667 };
const EXPECTED_DISTANCE = 23678.3;
const EXPECTED_DURATION = 2275.3;
const FREE_TEXT = "von Bremen Flughafen nach Vegesack, Autobahnen vermeiden";

function log(...args) {
  console.error(...args);
}

async function main() {
  const out = { generated_at: new Date().toISOString() };

  log("Step 2: querying osrm-car DIRECTLY (bypasses server.js entirely)");
  const directUrl = `http://osrm-car:5000/route/v1/driving/${ORIGIN.lon},${ORIGIN.lat};${DESTINATION.lon},${DESTINATION.lat}?overview=full&geometries=geojson&steps=false&exclude=motorway`;
  const directRes = await fetch(directUrl);
  const directJson = await directRes.json();
  out.direct_query = { url: directUrl, raw: directJson };
  const directRoute = directJson.routes && directJson.routes[0];
  const directOk = !!directRoute && directRoute.distance === EXPECTED_DISTANCE && directRoute.duration === EXPECTED_DURATION;
  out.direct_pin_check = {
    expected: { distance: EXPECTED_DISTANCE, duration: EXPECTED_DURATION },
    actual: directRoute ? { distance: directRoute.distance, duration: directRoute.duration } : null,
    pass: directOk,
  };
  log(`  -> distance=${directRoute?.distance} duration=${directRoute?.duration} pinMatch=${directOk}`);

  log(`Step 3: POST /api/plan (loopback, same container, real running server) — "${FREE_TEXT}"`);
  const planRes = await fetch("http://127.0.0.1:8789/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: FREE_TEXT }),
  });
  const planStatus = planRes.status;
  const planJson = await planRes.json();
  out.bridge_plan = { status: planStatus, response: planJson };
  log(`  -> HTTP ${planStatus}, intent=${JSON.stringify(planJson.intent)}`);
  if (planJson.verify) {
    log(`  -> verify.pass=${planJson.verify.pass} hardFails=${planJson.verify.hardFails.length} warnings=${planJson.verify.warnings.length}`);
  }

  const overallPass = directOk && planStatus === 200 && planJson.verify && planJson.verify.pass;
  out.overall_pass = !!overallPass;

  process.stdout.write(JSON.stringify(out));
  process.exitCode = overallPass ? 0 : 1;
}

main().catch((e) => {
  log("FATAL:", e.stack || e.message);
  process.stdout.write(JSON.stringify({ error: e.message, overall_pass: false }));
  process.exitCode = 1;
});
