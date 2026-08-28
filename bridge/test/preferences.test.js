"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePreference, pickRoute, PREFERENCE_NAMES } = require("../lib/preferences.js");

test("resolvePreference: fastest has no extra params", () => {
  const pref = resolvePreference("fastest");
  assert.deepEqual(pref.params, {});
  assert.equal(pref.pick, "first");
});

test("resolvePreference: avoid_highways maps to exclude=motorway", () => {
  const pref = resolvePreference("avoid_highways");
  assert.deepEqual(pref.params, { exclude: "motorway" });
});

test("resolvePreference: avoid_tolls maps to exclude=toll", () => {
  const pref = resolvePreference("avoid_tolls");
  assert.deepEqual(pref.params, { exclude: "toll" });
});

test("resolvePreference: shortest_distance requests alternatives and picks min distance", () => {
  const pref = resolvePreference("shortest_distance");
  assert.deepEqual(pref.params, { alternatives: "true" });
  assert.equal(pref.pick, "min_distance");
});

test("resolvePreference: unknown preference throws with the valid list", () => {
  assert.throws(() => resolvePreference("teleport"), /unknown preference "teleport"/);
});

test("PREFERENCE_NAMES matches the fixed vocabulary", () => {
  assert.deepEqual([...PREFERENCE_NAMES].sort(), [
    "avoid_highways",
    "avoid_tolls",
    "fastest",
    "fastest_alternative",
    "shortest_distance",
  ].sort());
});

test("pickRoute: 'first' returns routes[0] even if not smallest", () => {
  const osrmResponse = { routes: [{ distance: 100, duration: 50 }, { distance: 10, duration: 5 }] };
  assert.equal(pickRoute(osrmResponse, "first").distance, 100);
});

test("pickRoute: 'min_distance' picks the real alternative with smallest distance", () => {
  const osrmResponse = {
    routes: [
      { distance: 21685.7, duration: 1689.7 },
      { distance: 18406.4, duration: 1816.1 },
    ],
  };
  const picked = pickRoute(osrmResponse, "min_distance");
  assert.equal(picked.distance, 18406.4);
});

test("pickRoute: 'min_duration' picks the real alternative with smallest duration", () => {
  const osrmResponse = {
    routes: [
      { distance: 21685.7, duration: 1689.7 },
      { distance: 18406.4, duration: 1816.1 },
    ],
  };
  const picked = pickRoute(osrmResponse, "min_duration");
  assert.equal(picked.duration, 1689.7);
});

test("pickRoute: throws on empty routes array", () => {
  assert.throws(() => pickRoute({ routes: [] }, "first"), /no routes/);
});
