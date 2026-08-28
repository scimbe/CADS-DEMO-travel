"use strict";

/**
 * Two-turn LiteLLM (OpenAI-compatible) chat-completion contract. The model NEVER produces a
 * route fact itself — turn 1 only extracts intent into a fixed vocabulary via a tool call
 * (executed by the bridge, not the model — see server.lib.js's planRoute); turn 2 only formats
 * the bridge's already-computed OSRM JSON into German prose.
 *
 * Every function here that talks to the network takes its `fetchImpl`/config explicitly, so
 * unit tests can mock LiteLLM entirely and assert the CONTRACT (prompt shape, tool schema,
 * strict-block requirement) without ever needing a live model (see test/llmFormat.test.js).
 */

const { PREFERENCE_NAMES } = require("./preferences.js");

const PLAN_ROUTE_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "plan_route",
    description: "Resolve a travel request into a structured route-planning query. Does not compute the route itself.",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Free-text origin place name, e.g. 'Bremen Hauptbahnhof'" },
        destination: { type: "string", description: "Free-text destination place name, e.g. 'Vegesack'" },
        preference: { type: "string", enum: PREFERENCE_NAMES, description: "Routing preference, mapped to a fixed OSRM parameter set by the bridge" },
      },
      required: ["origin", "destination", "preference"],
    },
  },
});

const INTENT_SYSTEM_PROMPT =
  "Du bist ein Intent-Parser fuer einen Reiseplaner. Deine EINZIGE Aufgabe ist es, aus der " +
  "Nutzeranfrage Start, Ziel und Praeferenz zu extrahieren und den Werkzeugaufruf plan_route " +
  "auszufuehren. Du berechnest, schaetzt oder erfindest NIEMALS eine Route, Distanz oder Zeit " +
  "in diesem Schritt. Waehle preference ausschliesslich aus der vorgegebenen Liste " +
  `(${PREFERENCE_NAMES.join(", ")}); wenn nichts Passendes genannt wird, nimm "fastest".`;

const FACTS_TAG_INSTRUCTION =
  'Beginne deine Antwort mit exakt einer Zeile der Form ' +
  '<ROUTE_FACTS>{"distance_m":<int>,"duration_s":<int>}</ROUTE_FACTS>, wobei beide Zahlen ' +
  'wortwoertlich (nach Rundung) aus dem folgenden JSON stammen -- niemals berechnet, geschaetzt ' +
  'oder erfunden. Danach erklaere in deutscher Prosa, wieso diese Route zur gewuenschten ' +
  'Praeferenz passt. Jede Zahl in deiner Antwort (Distanz, Dauer) muss aus diesem JSON ' +
  'ableitbar sein.';

function buildIntentRequest(userText, { model }) {
  return {
    model,
    messages: [
      { role: "system", content: INTENT_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    tools: [PLAN_ROUTE_TOOL],
    tool_choice: { type: "function", function: { name: "plan_route" } },
    temperature: 0,
  };
}

/** Extracts {origin, destination, preference} from turn 1's response. Throws if the model
 *  didn't call the tool — the bridge must never guess at intent itself. */
function parseIntentResponse(response) {
  const choice = response?.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function?.name !== "plan_route") {
    throw new Error("model did not call plan_route — no route intent to act on");
  }
  let args;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    throw new Error(`plan_route tool call arguments were not valid JSON: ${e.message}`);
  }
  if (!args.origin || !args.destination || !args.preference) {
    throw new Error(`plan_route tool call missing required fields: ${JSON.stringify(args)}`);
  }
  return { origin: args.origin, destination: args.destination, preference: args.preference, toolCallId: toolCall.id };
}

/** Builds turn 2: hands the model the bridge-computed OSRM facts (raw, plus a provenance stamp)
 *  as a tool_result and instructs it to format-only. */
function buildFormatRequest({ model, userText, toolCallId, preference, routeFacts, provenance }) {
  const toolResultPayload = JSON.stringify({ route: routeFacts, provenance }, null, 2);
  return {
    model,
    messages: [
      { role: "system", content: INTENT_SYSTEM_PROMPT },
      { role: "user", content: userText },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: "plan_route", arguments: JSON.stringify({ preference }) },
          },
        ],
      },
      { role: "tool", tool_call_id: toolCallId, content: toolResultPayload },
      { role: "system", content: FACTS_TAG_INSTRUCTION },
    ],
    temperature: 0,
  };
}

function parseFormatResponse(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("model returned no formatted answer text");
  }
  return content;
}

/** Real network call to a LiteLLM-compatible /v1/chat/completions endpoint. */
async function chatCompletion(body, { baseUrl, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`LiteLLM response was not valid JSON (status ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`LiteLLM request failed: HTTP ${res.status} ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

module.exports = {
  PLAN_ROUTE_TOOL,
  INTENT_SYSTEM_PROMPT,
  FACTS_TAG_INSTRUCTION,
  buildIntentRequest,
  parseIntentResponse,
  buildFormatRequest,
  parseFormatResponse,
  chatCompletion,
};
