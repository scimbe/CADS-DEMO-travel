"use strict";

/**
 * Pure(ish) orchestration functions, unit-testable without a live server (see server.js for the
 * HTTP wiring around these). Every function here takes its collaborators (geocode, routeQuery,
 * chatCompletion) as explicit dependencies so tests can substitute mocks/fixtures instead of
 * hitting Nominatim/OSRM/LiteLLM for real.
 */

const { resolvePreference, pickRoute } = require("./lib/preferences.js");
const {
  buildIntentRequest,
  parseIntentResponse,
  buildFormatRequest,
  parseFormatResponse,
} = require("./lib/llmFormat.js");
const { verify } = require("./lib/verify.js");

const ENGINE_PROVENANCE = Object.freeze({
  engine: "osrm-backend v5.25.0 / MLD",
});

/**
 * Resolves origin/destination place names to coordinates and queries the self-hosted OSRM
 * service for a route matching `preference`. This is the ONLY place a route fact is computed —
 * the LLM never sees this step, it only sees this function's output.
 *
 * @param {{origin: string, destination: string, preference: string}} intent
 * @param {{geocode: Function, routeQuery: Function, datasetLabel?: string}} deps
 */
async function planRoute({ origin, destination, preference }, { geocode, routeQuery, datasetLabel }) {
  const prefDef = resolvePreference(preference);
  const [originCoord, destCoord] = await Promise.all([geocode(origin), geocode(destination)]);
  const { raw, requestUrl } = await routeQuery(originCoord, destCoord, prefDef.params);
  const pickedRoute = pickRoute(raw, prefDef.pick);

  const provenance = {
    ...ENGINE_PROVENANCE,
    dataset: datasetLabel || "bremen-latest",
    preference,
    preference_description: prefDef.description,
    request_url: requestUrl,
    queried_at: new Date().toISOString(),
  };

  return {
    originCoord,
    destCoord,
    raw,
    pickedRoute,
    routeFacts: { distance_m: pickedRoute.distance, duration_s: pickedRoute.duration },
    provenance,
  };
}

/**
 * Full pipeline: free-text user request -> LLM intent parse (tool call, no facts) -> bridge
 * executes the tool (planRoute, real OSRM query) -> LLM formats the final answer from that
 * result only -> the answer is mechanically re-verified against the same raw route.
 *
 * @param {{userText: string}} input
 * @param {{geocode, routeQuery, chatCompletion, model, llmBaseUrl, llmApiKey, datasetLabel?}} deps
 */
async function planAndFormat({ userText }, deps) {
  const { geocode, routeQuery, chatCompletion, model, llmBaseUrl, llmApiKey, datasetLabel } = deps;

  const intentReq = buildIntentRequest(userText, { model });
  const intentRes = await chatCompletion(intentReq, { baseUrl: llmBaseUrl, apiKey: llmApiKey });
  const intent = parseIntentResponse(intentRes);

  const routeResult = await planRoute(
    { origin: intent.origin, destination: intent.destination, preference: intent.preference },
    { geocode, routeQuery, datasetLabel },
  );

  const formatReq = buildFormatRequest({
    model,
    userText,
    toolCallId: intent.toolCallId,
    preference: intent.preference,
    routeFacts: routeResult.routeFacts,
    provenance: routeResult.provenance,
  });
  const formatRes = await chatCompletion(formatReq, { baseUrl: llmBaseUrl, apiKey: llmApiKey });
  const answerText = parseFormatResponse(formatRes);

  const verifyResult = verify(answerText, routeResult.pickedRoute);

  return { intent, routeResult, answerText, verifyResult };
}

module.exports = { planRoute, planAndFormat, ENGINE_PROVENANCE };
