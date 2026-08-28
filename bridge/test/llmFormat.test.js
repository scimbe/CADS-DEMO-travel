"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildIntentRequest,
  parseIntentResponse,
  buildFormatRequest,
  parseFormatResponse,
  PLAN_ROUTE_TOOL,
} = require("../lib/llmFormat.js");
const { PREFERENCE_NAMES } = require("../lib/preferences.js");

test("buildIntentRequest: forces the plan_route tool call, temperature 0, and never asks the model to invent a fact", () => {
  const req = buildIntentRequest("von Bremen Hauptbahnhof nach Vegesack, Autobahnen vermeiden", { model: "local-devstral-small2" });
  assert.equal(req.model, "local-devstral-small2");
  assert.equal(req.tool_choice.function.name, "plan_route");
  assert.equal(req.temperature, 0);
  assert.equal(req.tools.length, 1);
  assert.deepEqual(req.tools[0], PLAN_ROUTE_TOOL);
  assert.match(req.messages[0].content, /NIEMALS/); // system prompt forbids inventing a route fact
});

test("PLAN_ROUTE_TOOL's preference enum matches the fixed preference vocabulary exactly", () => {
  assert.deepEqual([...PLAN_ROUTE_TOOL.function.parameters.properties.preference.enum].sort(), [...PREFERENCE_NAMES].sort());
});

test("parseIntentResponse: extracts origin/destination/preference from a real-shaped tool call", () => {
  const response = {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "call_abc123",
              function: { name: "plan_route", arguments: JSON.stringify({ origin: "Bremen Hauptbahnhof", destination: "Vegesack", preference: "avoid_highways" }) },
            },
          ],
        },
      },
    ],
  };
  const intent = parseIntentResponse(response);
  assert.equal(intent.origin, "Bremen Hauptbahnhof");
  assert.equal(intent.destination, "Vegesack");
  assert.equal(intent.preference, "avoid_highways");
  assert.equal(intent.toolCallId, "call_abc123");
});

test("parseIntentResponse: throws if the model answered in prose instead of calling the tool", () => {
  const response = { choices: [{ message: { content: "Klar, das mache ich!" } }] };
  assert.throws(() => parseIntentResponse(response), /did not call plan_route/);
});

test("parseIntentResponse: throws on malformed tool-call arguments JSON", () => {
  const response = { choices: [{ message: { tool_calls: [{ id: "x", function: { name: "plan_route", arguments: "{not json" } }] } }] };
  assert.throws(() => parseIntentResponse(response), /not valid JSON/);
});

test("buildFormatRequest: hands the model the bridge's route facts as a tool result, and instructs the strict ROUTE_FACTS contract", () => {
  const req = buildFormatRequest({
    model: "local-devstral-small2",
    userText: "von Bremen Hauptbahnhof nach Vegesack, Autobahnen vermeiden",
    toolCallId: "call_abc123",
    preference: "avoid_highways",
    routeFacts: { distance_m: 23678.3, duration_s: 2275.3 },
    provenance: { engine: "osrm-backend v5.25.0 / MLD", dataset: "bremen-latest" },
  });
  const toolMsg = req.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "expected a tool-result message");
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload.route.distance_m, 23678.3);
  assert.equal(payload.provenance.engine, "osrm-backend v5.25.0 / MLD");
  const finalSystemMsg = req.messages[req.messages.length - 1];
  assert.match(finalSystemMsg.content, /ROUTE_FACTS/);
  assert.match(finalSystemMsg.content, /niemals berechnet/);
});

test("parseFormatResponse: extracts the model's answer text", () => {
  const response = { choices: [{ message: { content: '<ROUTE_FACTS>{"distance_m":23678,"duration_s":2275}</ROUTE_FACTS> Text.' } }] };
  assert.match(parseFormatResponse(response), /ROUTE_FACTS/);
});

test("parseFormatResponse: throws on empty content", () => {
  const response = { choices: [{ message: { content: "" } }] };
  assert.throws(() => parseFormatResponse(response), /no formatted answer/);
});
