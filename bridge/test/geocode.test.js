"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGeocoder, BREMEN_VIEWBOX } = require("../lib/geocode.js");

// Pinned live Nominatim result for "Bremen Hauptbahnhof", captured during build (see
// test/fixtures/geocode-bremen-hbf.json for the byte-for-byte raw response this is drawn from).
const FIXTURE_RESULT = [
  { lat: "53.0831456", lon: "8.8135421", display_name: "Bremen Hauptbahnhof, Bahnhofsplatz, Bremen, Deutschland" },
];

function fakeFetch(responseBody, { calls }) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => responseBody };
  };
}

test("geocode: never calls the live network — this test only ever talks to a mock", async () => {
  const calls = [];
  const geocoder = createGeocoder({ fetchImpl: fakeFetch(FIXTURE_RESULT, { calls }), now: () => 0, sleepImpl: async () => {} });
  const result = await geocoder.geocode("Bremen Hauptbahnhof");
  assert.equal(result.lon, 8.8135421);
  assert.equal(result.lat, 53.0831456);
  assert.equal(calls.length, 1);
});

test("geocode: sends the Bremen bounding box + bounded=1 so results can't resolve outside the loaded graph", async () => {
  const calls = [];
  const geocoder = createGeocoder({ fetchImpl: fakeFetch(FIXTURE_RESULT, { calls }), now: () => 0, sleepImpl: async () => {} });
  await geocoder.geocode("Bremen Hauptbahnhof");
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("viewbox"), BREMEN_VIEWBOX);
  assert.equal(url.searchParams.get("bounded"), "1");
  assert.equal(url.searchParams.get("q"), "Bremen Hauptbahnhof");
});

test("geocode: sends an identifying User-Agent (Nominatim usage policy requirement)", async () => {
  const calls = [];
  const geocoder = createGeocoder({ fetchImpl: fakeFetch(FIXTURE_RESULT, { calls }), now: () => 0, sleepImpl: async () => {} });
  await geocoder.geocode("Bremen Hauptbahnhof");
  assert.ok(calls[0].opts.headers["User-Agent"].includes("CADS-DEMO-travel"));
});

test("geocode: caches — a second call for the same place makes no second HTTP request", async () => {
  const calls = [];
  const geocoder = createGeocoder({ fetchImpl: fakeFetch(FIXTURE_RESULT, { calls }), now: () => 0, sleepImpl: async () => {} });
  await geocoder.geocode("Bremen Hauptbahnhof");
  await geocoder.geocode("bremen hauptbahnhof"); // case-insensitive cache key
  assert.equal(calls.length, 1);
});

test("geocode: self-throttles to Nominatim's 1 req/s policy between distinct queries", async () => {
  const calls = [];
  let clock = 0;
  const sleeps = [];
  const geocoder = createGeocoder({
    fetchImpl: fakeFetch(FIXTURE_RESULT, { calls }),
    now: () => clock,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      clock += ms; // simulate time passing during the sleep
    },
  });
  await geocoder.geocode("Bremen Hauptbahnhof");
  clock += 100; // only 100ms elapsed before the next distinct query
  await geocoder.geocode("Vegesack");
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 900); // needed to wait out the remaining 900ms of the 1000ms floor
});

test("geocode: throws a clear error when no result is found", async () => {
  const geocoder = createGeocoder({ fetchImpl: fakeFetch([], { calls: [] }), now: () => 0, sleepImpl: async () => {} });
  await assert.rejects(() => geocoder.geocode("Nirgendwo"), /no geocode result/);
});

test("geocode: throws on a non-OK HTTP response", async () => {
  const geocoder = createGeocoder({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    now: () => 0,
    sleepImpl: async () => {},
  });
  await assert.rejects(() => geocoder.geocode("x"), /HTTP 503/);
});
