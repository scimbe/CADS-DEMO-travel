"use strict";

/**
 * Integration test — runs against a REAL self-hosted osrm-routed instance (the acceptance bar's
 * whole point is that nothing here is mocked). Requires `osrm-car` reachable at OSRM_BASE_URL
 * (default http://127.0.0.1:5000). In CI: `docker compose -f compose.travel-demo.yml up -d
 * osrm-car` first. Locally: see README.md's "Run the OSRM engine locally" section.
 *
 * Asserts the numbers still equal the pinned fixture in osrm/REGIONS.md — catches "someone
 * silently changed the dataset, the profile, or the algorithm".
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { routeQuery } = require("../lib/osrmClient.js");

const ORIGIN = { lon: 8.7867, lat: 53.0475 };
const DESTINATION = { lon: 8.6167, lat: 53.1667 };

test("osrmClient: fastest — pinned Bremen fixture (live engine)", async () => {
  const { raw } = await routeQuery(ORIGIN, DESTINATION, {});
  assert.equal(raw.code, "Ok");
  const route = raw.routes[0];
  assert.equal(route.distance, 29606.9);
  assert.equal(route.duration, 2041.3);
});

test("osrmClient: avoid_highways (exclude=motorway) — pinned Bremen fixture (live engine)", async () => {
  const { raw } = await routeQuery(ORIGIN, DESTINATION, { exclude: "motorway" });
  assert.equal(raw.code, "Ok");
  const route = raw.routes[0];
  assert.equal(route.distance, 23678.3);
  assert.equal(route.duration, 2275.3);
  // The real trade-off the routing engine (not an LLM) surfaces: shorter distance, longer time.
  const fastest = (await routeQuery(ORIGIN, DESTINATION, {})).raw.routes[0];
  assert.ok(route.distance < fastest.distance);
  assert.ok(route.duration > fastest.duration);
});

test("osrmClient: raw JSON is passed through untouched (same fields OSRM itself returns)", async () => {
  const { raw } = await routeQuery(ORIGIN, DESTINATION, {});
  const route = raw.routes[0];
  assert.ok("distance" in route && "duration" in route && "geometry" in route && "legs" in route);
  assert.ok(Array.isArray(raw.waypoints));
});
