"use strict";

/**
 * Thin fetch wrapper around a self-hosted OSRM `osrm-routed` service.
 * Returns OSRM's raw JSON UNTOUCHED — no field renamed, no number recomputed. That is the whole
 * point of this file: the bridge relays facts, it does not compute them.
 *
 * Env:
 *   OSRM_BASE_URL — e.g. http://osrm-car:5000 (compose) or http://127.0.0.1:5000 (local)
 */

const DEFAULT_BASE_URL = process.env.OSRM_BASE_URL || "http://127.0.0.1:5000";

/**
 * @param {{lon:number, lat:number}} origin
 * @param {{lon:number, lat:number}} destination
 * @param {Object} extraParams  e.g. {exclude: "motorway"} or {alternatives: "true"}
 * @param {{baseUrl?: string, profile?: string, fetchImpl?: Function}} [opts]
 * @returns {Promise<Object>} the raw parsed OSRM JSON response body
 */
async function routeQuery(origin, destination, extraParams = {}, opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const profile = opts.profile || "driving";
  const fetchImpl = opts.fetchImpl || fetch;

  const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
  const params = new URLSearchParams({ overview: "full", geometries: "geojson", steps: "false", ...extraParams });
  const url = `${baseUrl.replace(/\/+$/, "")}/route/v1/${profile}/${coords}?${params.toString()}`;

  const res = await fetchImpl(url);
  const bodyText = await res.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`OSRM response was not valid JSON (status ${res.status}): ${bodyText.slice(0, 300)}`);
  }
  if (!res.ok || body.code !== "Ok") {
    const err = new Error(`OSRM query failed: ${body.code || res.status} ${body.message || ""}`.trim());
    err.osrmResponse = body;
    err.requestUrl = url;
    throw err;
  }
  return { raw: body, requestUrl: url };
}

module.exports = { routeQuery, DEFAULT_BASE_URL };
