"use strict";

/**
 * Fixed preference vocabulary -> OSRM query params. Pure lookup table, no LLM involvement in
 * this mapping — the model only ever picks a NAME from PREFERENCE_NAMES (via its tool call);
 * this file, not the model, decides what that name means to the routing engine.
 *
 * `alternatives: true` preferences ask osrmClient for OSRM's own alternative-routes list and
 * pick a real, engine-provided route by a stated rule (min distance / min duration) — never a
 * value the bridge or the model invents.
 */

const PREFERENCES = Object.freeze({
  fastest: Object.freeze({
    params: Object.freeze({}),
    pick: "first",
    description: "no exclusions — OSRM's normal fastest-route ranking",
  }),
  avoid_highways: Object.freeze({
    params: Object.freeze({ exclude: "motorway" }),
    pick: "first",
    description: "exclude=motorway (requires the MLD algorithm — see osrm/REGIONS.md)",
  }),
  avoid_tolls: Object.freeze({
    params: Object.freeze({ exclude: "toll" }),
    pick: "first",
    description:
      "exclude=toll — same mechanism as avoid_highways; the car.lua profile's excludable " +
      "list includes 'toll' identically to 'motorway'. Not separately live-verified against a " +
      "toll road: the Bremen extract has none to exercise it (see osrm/REGIONS.md).",
  }),
  shortest_distance: Object.freeze({
    params: Object.freeze({ alternatives: "true" }),
    pick: "min_distance",
    description: "alternatives=true, bridge picks the route with the smallest raw distance",
  }),
  fastest_alternative: Object.freeze({
    params: Object.freeze({ alternatives: "true" }),
    pick: "min_duration",
    description: "alternatives=true, bridge picks the route with the smallest raw duration",
  }),
});

const PREFERENCE_NAMES = Object.freeze(Object.keys(PREFERENCES));

function resolvePreference(name) {
  const pref = PREFERENCES[name];
  if (!pref) {
    throw new Error(`unknown preference "${name}" — must be one of: ${PREFERENCE_NAMES.join(", ")}`);
  }
  return pref;
}

/** Given a full OSRM /route response body (already parsed JSON) and a `pick` rule, returns the
 *  ONE route object the bridge will use — always a route OSRM itself returned, never synthesized. */
function pickRoute(osrmResponse, pick) {
  if (!osrmResponse || !Array.isArray(osrmResponse.routes) || osrmResponse.routes.length === 0) {
    throw new Error("OSRM response has no routes");
  }
  const routes = osrmResponse.routes;
  switch (pick) {
    case "first":
      return routes[0];
    case "min_distance":
      return routes.reduce((best, r) => (r.distance < best.distance ? r : best), routes[0]);
    case "min_duration":
      return routes.reduce((best, r) => (r.duration < best.duration ? r : best), routes[0]);
    default:
      throw new Error(`unknown pick rule "${pick}"`);
  }
}

module.exports = { PREFERENCES, PREFERENCE_NAMES, resolvePreference, pickRoute };
