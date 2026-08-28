"use strict";

/**
 * The acceptance check itself: proves an LLM-formatted answer's numbers trace back to the raw
 * OSRM JSON it was handed, not to the model's own arithmetic or imagination.
 *
 * Two layers, deliberately asymmetric (see the technical plan §8/§5):
 *   1. HARD GATE — the mandatory `<ROUTE_FACTS>{"distance_m":N,"duration_s":N}</ROUTE_FACTS>`
 *      line must be present and, after rounding, EXACTLY equal the raw route's distance/duration.
 *      Any mismatch or missing block is a hard FAIL.
 *   2. SOFT SCAN — the surrounding German prose is best-effort scanned for other numeric tokens
 *      that look like a km/m/min/s restatement of the route. A recognized-unit number that
 *      DISAGREES with the (already-verified) facts block beyond tolerance is ALSO a hard fail
 *      (the model contradicted its own stated facts); anything else unrecognized is a warning,
 *      never a build-breaker — free-form German number formatting is not reliably regex-parseable
 *      in general, and this scan does not try to pretend otherwise.
 *
 * Tolerances (exact wording from the technical plan):
 *   - meters/seconds: round(raw) == stated (exact after rounding)
 *   - km, 1 decimal: |stated_km*1000 - raw_distance_m| <= 50
 *   - minutes, nearest whole: |stated_min*60 - raw_duration_s| <= 30
 */

const ROUTE_FACTS_RE = /<ROUTE_FACTS>(\{.*?\})<\/ROUTE_FACTS>/s;

function parseGermanNumber(str) {
  // "23,7" (German decimal comma) or "23.7" (plain) -> 23.7. Assumes no thousands separators
  // in these short route-fact restatements (a 3-4 digit km/min figure never needs one).
  return Number(str.replace(",", "."));
}

function extractRouteFacts(text) {
  const m = ROUTE_FACTS_RE.exec(text);
  if (!m) return { found: false };
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch (e) {
    return { found: true, valid: false, error: `ROUTE_FACTS block is not valid JSON: ${e.message}`, raw: m[0] };
  }
  if (typeof parsed.distance_m !== "number" || typeof parsed.duration_s !== "number") {
    return { found: true, valid: false, error: `ROUTE_FACTS block missing distance_m/duration_s: ${m[1]}`, raw: m[0] };
  }
  return { found: true, valid: true, distance_m: parsed.distance_m, duration_s: parsed.duration_s, raw: m[0], index: m.index, end: m.index + m[0].length };
}

function scanProseNumbers(text, excludeRange) {
  let prose = excludeRange ? text.slice(0, excludeRange.index) + text.slice(excludeRange.end) : text;
  const found = [];

  // Compound "N Minuten und M Sekunden" must be recognized as ONE combined duration BEFORE the
  // individual min/sec scans below run — otherwise "N" gets checked alone against the WHOLE
  // route duration (as if N minutes were the entire trip), which false-hard-fails even when
  // N:M together is exactly correct (e.g. "8 Minuten und 30 Sekunden" for a 510s route: "8 min"
  // alone implies 480s, off by 30s+ from the real duration, even though 8*60+30=510 is exact).
  // Masked to spaces (same length, so later match indices in `prose` stay valid) once captured,
  // so the bare min/sec regexes below can't re-match and double-count the same digits.
  const compoundRe = /(\d+)\s*(?:min|Minuten)\s*(?:und\s*)?(\d+)\s*(?:sek|Sekunden)\b/gi;
  prose = prose.replace(compoundRe, (whole, minPart, secPart) => {
    found.push({ kind: "compound-min-sec", statedMin: Number(minPart), statedSec: Number(secPart), match: whole });
    return " ".repeat(whole.length);
  });

  for (const m of prose.matchAll(/(\d+(?:[.,]\d+)?)\s*km\b/gi)) {
    found.push({ kind: "km", statedValue: parseGermanNumber(m[1]), match: m[0] });
  }
  for (const m of prose.matchAll(/(\d+(?:[.,]\d+)?)\s*m\b/g)) {
    found.push({ kind: "m", statedValue: parseGermanNumber(m[1]), match: m[0] });
  }
  for (const m of prose.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:min|Minuten)\b/gi)) {
    found.push({ kind: "min", statedValue: parseGermanNumber(m[1]), match: m[0] });
  }
  for (const m of prose.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:sek|Sekunden)\b/gi)) {
    found.push({ kind: "s", statedValue: parseGermanNumber(m[1]), match: m[0] });
  }
  return found;
}

/**
 * @param {string} answerText  the LLM's full formatted answer
 * @param {{distance: number, duration: number}} rawRoute  the OSRM route object actually handed to the LLM (meters, seconds)
 */
function verify(answerText, rawRoute) {
  const hardFails = [];
  const warnings = [];
  const checks = [];

  const facts = extractRouteFacts(answerText);
  if (!facts.found) {
    hardFails.push("no <ROUTE_FACTS>...</ROUTE_FACTS> block found in the answer");
    return { pass: false, hardFails, warnings, checks, facts };
  }
  if (!facts.valid) {
    hardFails.push(facts.error);
    return { pass: false, hardFails, warnings, checks, facts };
  }

  const expectedDistance = Math.round(rawRoute.distance);
  const expectedDuration = Math.round(rawRoute.duration);
  const distOk = facts.distance_m === expectedDistance;
  const durOk = facts.duration_s === expectedDuration;
  checks.push({ name: "facts.distance_m == round(raw.distance)", expected: expectedDistance, actual: facts.distance_m, pass: distOk });
  checks.push({ name: "facts.duration_s == round(raw.duration)", expected: expectedDuration, actual: facts.duration_s, pass: durOk });
  if (!distOk) hardFails.push(`ROUTE_FACTS distance_m=${facts.distance_m} != round(raw.distance)=${expectedDistance}`);
  if (!durOk) hardFails.push(`ROUTE_FACTS duration_s=${facts.duration_s} != round(raw.duration)=${expectedDuration}`);

  const proseNumbers = scanProseNumbers(answerText, { index: facts.index, end: facts.end });
  for (const n of proseNumbers) {
    if (n.kind === "km") {
      const impliedM = n.statedValue * 1000;
      const diff = Math.abs(impliedM - rawRoute.distance);
      const ok = diff <= 50;
      checks.push({ name: `prose "${n.match}" as distance`, expected: rawRoute.distance, impliedM, diff, pass: ok });
      if (!ok) hardFails.push(`prose states "${n.match}" (${impliedM} m implied) which disagrees with the route's actual distance ${rawRoute.distance} m by ${diff.toFixed(1)} m (tolerance 50 m)`);
    } else if (n.kind === "min") {
      const impliedS = n.statedValue * 60;
      const diff = Math.abs(impliedS - rawRoute.duration);
      const ok = diff <= 30;
      checks.push({ name: `prose "${n.match}" as duration`, expected: rawRoute.duration, impliedS, diff, pass: ok });
      if (!ok) hardFails.push(`prose states "${n.match}" (${impliedS} s implied) which disagrees with the route's actual duration ${rawRoute.duration} s by ${diff.toFixed(1)} s (tolerance 30 s)`);
    } else if (n.kind === "m") {
      const ok = Math.round(n.statedValue) === expectedDistance;
      if (!ok) warnings.push(`prose contains "${n.match}" — not within an exact-meters match of the route distance (${expectedDistance} m); likely an unrelated number, flagged not failed`);
    } else if (n.kind === "s") {
      const ok = Math.round(n.statedValue) === expectedDuration;
      if (!ok) warnings.push(`prose contains "${n.match}" — not within an exact-seconds match of the route duration (${expectedDuration} s); likely an unrelated number, flagged not failed`);
    } else if (n.kind === "compound-min-sec") {
      const impliedS = n.statedMin * 60 + n.statedSec;
      const ok = Math.round(impliedS) === expectedDuration;
      checks.push({ name: `prose "${n.match}" as compound minutes+seconds duration`, expected: expectedDuration, impliedS, pass: ok });
      if (!ok) hardFails.push(`prose states "${n.match}" (${impliedS} s implied) which disagrees with the route's actual duration ${expectedDuration} s`);
    }
  }

  return { pass: hardFails.length === 0, hardFails, warnings, checks, facts };
}

module.exports = { verify, extractRouteFacts, scanProseNumbers, parseGermanNumber };
