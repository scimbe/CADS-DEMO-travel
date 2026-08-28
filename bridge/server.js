#!/usr/bin/env node
"use strict";

/**
 * Travel-demo bridge — HTTP wiring around server.lib.js's planAndFormat pipeline.
 *
 * Anti-hallucination contract (the whole point of this demo, see README.md): this bridge, not
 * the LLM, executes the OSRM route query and the Nominatim geocode. The LLM only ever (a) picks
 * origin/destination/preference out of free text via a tool call, and (b) formats the bridge's
 * already-computed route facts into prose. GET /api/plan-raw exists specifically so a caller can
 * cross-check the raw OSRM output against the LLM-formatted one from the SAME request path (see
 * site/app.js, which renders both panels side by side).
 *
 * Env:
 *   TRAVEL_BRIDGE_LISTEN  - default 0.0.0.0:8789
 *   OSRM_BASE_URL         - default http://127.0.0.1:5000 (compose: http://osrm-car:5000)
 *   LITELLM_BASE_URL      - required for /api/plan (e.g. https://llm-34a13a96.bunsenbrenner.org/v1)
 *   LITELLM_API_KEY       - required for /api/plan
 *   LITELLM_DEFAULT_MODEL - default local-devstral-small2
 *   TRAVEL_DATASET_LABEL  - default "bremen-latest (md5 0061299ee69f4bce070ea86e416ddc93)"
 */

const http = require("node:http");
const { planRoute, planAndFormat } = require("./server.lib.js");
const { createGeocoder } = require("./lib/geocode.js");
const { routeQuery } = require("./lib/osrmClient.js");
const { chatCompletion } = require("./lib/llmFormat.js");
const { PREFERENCE_NAMES } = require("./lib/preferences.js");

const LISTEN = process.env.TRAVEL_BRIDGE_LISTEN || "0.0.0.0:8789";
const MODEL = process.env.LITELLM_DEFAULT_MODEL || "local-devstral-small2";
const DATASET_LABEL = process.env.TRAVEL_DATASET_LABEL || "bremen-latest (md5 0061299ee69f4bce070ea86e416ddc93)";

const geocoder = createGeocoder();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function handlePlan(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!body.text || typeof body.text !== "string") {
    return sendJson(res, 400, { error: "expected {\"text\": \"...\"}" });
  }
  const llmBaseUrl = process.env.LITELLM_BASE_URL;
  const llmApiKey = process.env.LITELLM_API_KEY;
  if (!llmBaseUrl || !llmApiKey) {
    return sendJson(res, 503, { error: "LITELLM_BASE_URL/LITELLM_API_KEY not configured on this deployment" });
  }
  try {
    const result = await planAndFormat(
      { userText: body.text },
      {
        geocode: geocoder.geocode,
        routeQuery,
        chatCompletion,
        model: MODEL,
        llmBaseUrl,
        llmApiKey,
        datasetLabel: DATASET_LABEL,
      },
    );
    sendJson(res, 200, {
      intent: result.intent,
      raw_osrm: result.routeResult.raw,
      picked_route: result.routeResult.pickedRoute,
      provenance: result.routeResult.provenance,
      llm_answer: result.answerText,
      verify: result.verifyResult,
    });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

/** Bypasses the LLM entirely — direct origin/destination/preference -> raw OSRM JSON. Used by
 *  the acceptance check as the independent cross-check path (scripts/acceptance-check.sh queries
 *  osrm-car directly too, but this lets the SAME bridge process be queried both ways). */
async function handlePlanRaw(req, res, query) {
  const origin = query.get("origin");
  const destination = query.get("destination");
  const preference = query.get("preference") || "fastest";
  if (!origin || !destination) {
    return sendJson(res, 400, { error: "expected ?origin=lon,lat&destination=lon,lat&preference=..." });
  }
  const [oLon, oLat] = origin.split(",").map(Number);
  const [dLon, dLat] = destination.split(",").map(Number);
  if ([oLon, oLat, dLon, dLat].some(Number.isNaN)) {
    return sendJson(res, 400, { error: "origin/destination must be lon,lat" });
  }
  try {
    const result = await planRoute(
      { origin: { lon: oLon, lat: oLat }, destination: { lon: dLon, lat: dLat }, preference },
      {
        geocode: async (c) => c, // already coordinates, not place names, on this route
        routeQuery,
        datasetLabel: DATASET_LABEL,
      },
    );
    sendJson(res, 200, { raw_osrm: result.raw, picked_route: result.pickedRoute, provenance: result.provenance });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { status: "ok", preferences: PREFERENCE_NAMES });
    }
    if (req.method === "POST" && url.pathname === "/api/plan") {
      return await handlePlan(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/plan-raw") {
      return await handlePlanRaw(req, res, url.searchParams);
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  const [host, port] = LISTEN.split(":");
  server.listen(Number(port), host, () => {
    console.log(`travel-demo bridge listening on ${LISTEN} (OSRM_BASE_URL=${process.env.OSRM_BASE_URL || "http://127.0.0.1:5000"})`);
  });
}

module.exports = { server };
