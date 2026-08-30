"use strict";

/**
 * Nominatim client — resolves a free-text place name to {lon, lat}, bounded to the Bremen
 * extract's coverage (see osrm/REGIONS.md) so a query can't silently resolve somewhere the
 * routing graph doesn't cover.
 *
 * Nominatim's public usage policy (operations.osmfoundation.org/policies/nominatim) is real and
 * enforced: max 1 req/s, must send an identifying User-Agent, no bulk geocoding, results should
 * be cached. This module self-throttles to that and caches in-memory; unit tests mock the HTTP
 * call entirely and never hit the live service (see test/geocode.test.js).
 */

const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org";
const USER_AGENT = process.env.NOMINATIM_USER_AGENT || "CADS-DEMO-travel/0.1 (bunsenbrenner.org demo; contact: scimbe)";
// Bremen extract coverage with margin, left/top/right/bottom = minlon,maxlat,maxlon,minlat.
const BREMEN_VIEWBOX = "8.40,53.35,9.05,52.90";
const MIN_INTERVAL_MS = 1000; // Nominatim policy: max 1 req/s

function createGeocoder({ fetchImpl = fetch, cache = new Map(), now = Date.now, sleepImpl = defaultSleep } = {}) {
  let lastCallAt = 0;
  let hasCalledBefore = false; // NOT `lastCallAt > 0` -- a mocked clock (or, in principle, a
  // call that lands exactly on Date.now()===0) legitimately makes lastCallAt 0 after a real
  // first call, which would make that sentinel silently skip throttling on the very next query.
  const reverseCache = new Map();

  // Shared 1-req/s gate for EVERY Nominatim call this geocoder makes (forward `geocode` AND
  // `reverseGeocode`) -- the policy limit is per-service, not per-endpoint, so the tourist-info
  // reverse lookups must throttle against the same clock as the forward geocodes, not open a
  // second unthrottled stream to the same host.
  async function throttle() {
    if (hasCalledBefore) {
      const elapsed = now() - lastCallAt;
      if (elapsed < MIN_INTERVAL_MS) {
        await sleepImpl(MIN_INTERVAL_MS - elapsed);
      }
    }
    lastCallAt = now();
    hasCalledBefore = true;
  }

  async function geocode(placeName) {
    const key = placeName.trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);

    await throttle();

    const params = new URLSearchParams({
      q: placeName,
      format: "jsonv2",
      limit: "1",
      viewbox: BREMEN_VIEWBOX,
      bounded: "1",
    });
    const url = `${NOMINATIM_BASE_URL}/search?${params.toString()}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Nominatim request failed: HTTP ${res.status}`);
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error(`no geocode result for "${placeName}" within the Bremen bounding box`);
    }
    const top = results[0];
    const resolved = {
      lon: Number(top.lon),
      lat: Number(top.lat),
      displayName: top.display_name,
    };
    cache.set(key, resolved);
    return resolved;
  }

  // Resolves a coordinate ON the computed route back to the OSM place it sits in, so the
  // tourist-info section can only ever name places the route physically passes through -- the
  // {lon,lat} handed in comes straight from the OSRM geometry, never from the model. Returns the
  // raw Nominatim `address` object (suburb/city/... — tourism.js decides which field to use) plus
  // the display name; returns null (never throws) when the point resolves to nothing, so one dead
  // sample point can't sink the whole non-blocking section.
  async function reverseGeocode(lon, lat, { zoom = 14 } = {}) {
    const key = `${Number(lon).toFixed(5)},${Number(lat).toFixed(5)}@${zoom}`;
    if (reverseCache.has(key)) return reverseCache.get(key);

    await throttle();

    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(lat),
      lon: String(lon),
      zoom: String(zoom),
    });
    const url = `${NOMINATIM_BASE_URL}/reverse?${params.toString()}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Nominatim reverse request failed: HTTP ${res.status}`);
    const body = await res.json();
    const resolved = body && body.address
      ? { address: body.address, displayName: body.display_name, name: body.name, lon: Number(lon), lat: Number(lat) }
      : null;
    reverseCache.set(key, resolved);
    return resolved;
  }

  return { geocode, reverseGeocode, _cache: cache };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createGeocoder, NOMINATIM_BASE_URL, USER_AGENT, BREMEN_VIEWBOX, MIN_INTERVAL_MS };
