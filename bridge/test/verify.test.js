"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verify, extractRouteFacts } = require("../lib/verify.js");

const FIXTURES = path.join(__dirname, "fixtures");
const rawAvoidHighways = JSON.parse(fs.readFileSync(path.join(FIXTURES, "route-bremen-avoid-highways.raw.json"), "utf8"));
const pickedRoute = rawAvoidHighways.routes[0]; // distance 23678.3, duration 2275.3

test("verify: PASSES the good fixture against the real captured raw route", () => {
  const answer = fs.readFileSync(path.join(FIXTURES, "llm-answer-good.txt"), "utf8");
  const result = verify(answer, pickedRoute);
  assert.equal(result.pass, true, `expected pass, got hardFails=${JSON.stringify(result.hardFails)}`);
  assert.equal(result.hardFails.length, 0);
});

// This is the load-bearing negative control: without it, a verify() that always returns "pass"
// would sail through the test above too. This fixture states distance_m=19500 while the real
// route is 23678.3m -- verify() MUST catch that, or the whole acceptance check has no teeth.
test("verify: FAILS the hallucinated fixture (wrong distance_m in the facts block)", () => {
  const answer = fs.readFileSync(path.join(FIXTURES, "llm-answer-hallucinated.txt"), "utf8");
  const result = verify(answer, pickedRoute);
  assert.equal(result.pass, false);
  assert.ok(result.hardFails.length > 0);
  assert.ok(result.hardFails.some((f) => f.includes("distance_m")));
});

test("verify: FAILS when the ROUTE_FACTS block is entirely missing", () => {
  const result = verify("Die Route ist 23,7 km lang und dauert 38 Minuten, ganz ohne Fakten-Block.", pickedRoute);
  assert.equal(result.pass, false);
  assert.match(result.hardFails[0], /no <ROUTE_FACTS>/);
});

test("verify: FAILS when the ROUTE_FACTS block is malformed JSON", () => {
  const result = verify('<ROUTE_FACTS>{"distance_m":23678,"duration_s":}</ROUTE_FACTS> Text.', pickedRoute);
  assert.equal(result.pass, false);
  assert.match(result.hardFails[0], /not valid JSON/);
});

test("verify: exact-after-rounding is required, not merely 'close'", () => {
  // real distance rounds to 23678; 23679 is off by ONE and must still fail (exact, not fuzzy)
  const answer = '<ROUTE_FACTS>{"distance_m":23679,"duration_s":2275}</ROUTE_FACTS> Text.';
  const result = verify(answer, pickedRoute);
  assert.equal(result.pass, false);
});

test("verify: prose km restatement within 50m tolerance of raw distance passes", () => {
  const answer = '<ROUTE_FACTS>{"distance_m":23678,"duration_s":2275}</ROUTE_FACTS> Das sind etwa 23,7 km.';
  const result = verify(answer, pickedRoute);
  assert.equal(result.pass, true);
});

test("verify: prose km restatement that CONTRADICTS the facts block is a hard fail", () => {
  const answer = '<ROUTE_FACTS>{"distance_m":23678,"duration_s":2275}</ROUTE_FACTS> Das sind ungefaehr 30 km.';
  const result = verify(answer, pickedRoute);
  assert.equal(result.pass, false);
  assert.ok(result.hardFails.some((f) => f.includes("30 km")));
});

test("verify: prose minute restatement within 30s tolerance of raw duration passes", () => {
  const answer = '<ROUTE_FACTS>{"distance_m":23678,"duration_s":2275}</ROUTE_FACTS> Das dauert rund 38 Minuten.';
  const result = verify(answer, pickedRoute);
  assert.equal(result.pass, true);
});

test("verify: an unrelated bare number in prose is a warning, not a hard fail", () => {
  const answer = '<ROUTE_FACTS>{"distance_m":23678,"duration_s":2275}</ROUTE_FACTS> Diese Route hat 3 Ampeln unterwegs.';
  const result = verify(answer, pickedRoute);
  assert.equal(result.pass, true);
});

test("extractRouteFacts: finds the block and its byte range for prose-exclusion", () => {
  const text = 'prefix <ROUTE_FACTS>{"distance_m":1,"duration_s":2}</ROUTE_FACTS> suffix';
  const facts = extractRouteFacts(text);
  assert.equal(facts.found, true);
  assert.equal(facts.valid, true);
  assert.equal(text.slice(facts.index, facts.end), facts.raw);
});
