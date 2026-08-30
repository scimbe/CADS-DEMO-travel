"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sampleRoutePoints,
  pickPlaceName,
  wikipediaTitleCandidates,
  fetchWikipediaSummary,
  collectTouristInfo,
  stripPronunciation,
} = require("../lib/tourism.js");

// --- stripPronunciation ------------------------------------------------------

test("stripPronunciation: removes a bracketed IPA span right after the name", () => {
  assert.equal(stripPronunciation("Hannover [haˈnoːfɐ] ist eine Stadt."), "Hannover ist eine Stadt.");
});

test("stripPronunciation: removes an explicit 'IPA: …' span", () => {
  assert.equal(stripPronunciation("Kiel (IPA: [kiːl]) liegt an der Ostsee."), "Kiel liegt an der Ostsee.");
});

test("stripPronunciation: strips IPA but keeps a following ordinary parenthesis", () => {
  assert.equal(stripPronunciation("München [ˈmʏnçn̩] (bairisch) ist groß."), "München (bairisch) ist groß.");
});

test("stripPronunciation: leaves real parentheses and numbers untouched (no IPA marker)", () => {
  assert.equal(stripPronunciation("Bremen (Hansestadt) hatte 2023 viele Gäste."), "Bremen (Hansestadt) hatte 2023 viele Gäste.");
});

test("stripPronunciation: the real Vegesack extract loses only its IPA", () => {
  assert.equal(
    stripPronunciation("Vegesack [ˈfeːgəˌzak] ist ein Stadtteil von Bremen innerhalb des Stadtbezirks Nord."),
    "Vegesack ist ein Stadtteil von Bremen innerhalb des Stadtbezirks Nord.",
  );
});

test("stripPronunciation: handles empty/nullish input without throwing", () => {
  assert.equal(stripPronunciation(""), "");
  assert.equal(stripPronunciation(null), "");
  assert.equal(stripPronunciation(undefined), "");
});

// --- sampleRoutePoints -------------------------------------------------------

test("sampleRoutePoints: always includes the exact start and end vertex", () => {
  const coords = [[8.80, 53.05], [8.75, 53.10], [8.70, 53.14], [8.62, 53.17]];
  const pts = sampleRoutePoints(coords, 4);
  assert.deepEqual({ lon: pts[0].lon, lat: pts[0].lat }, { lon: 8.80, lat: 53.05 });
  const last = pts[pts.length - 1];
  assert.deepEqual({ lon: last.lon, lat: last.lat }, { lon: 8.62, lat: 53.17 });
  assert.equal(pts[0].fraction, 0);
  assert.equal(last.fraction, 1);
});

test("sampleRoutePoints: spaces intermediate points by travelled distance, not by index", () => {
  // 1000m of dense vertices at the start, then one long 100km jump — a naive index-based sampler
  // would cluster picks in the dense head; a distance-based one must put the midpoint out on the
  // long leg.
  const coords = [];
  for (let i = 0; i <= 10; i++) coords.push([8.80 + i * 0.0001, 53.00]); // tiny steps (~67m total)
  coords.push([9.30, 53.00]); // ~33km east — a real vertex out on the long leg
  coords.push([9.80, 53.00]); // another ~33km east
  const pts = sampleRoutePoints(coords, 3);
  assert.equal(pts.length, 3);
  // The middle sample (fraction ~0.5) must land out on the long leg, not back in the dense cluster.
  assert.ok(pts[1].lon > 9.0, `expected midpoint out on the long leg, got lon=${pts[1].lon}`);
});

test("sampleRoutePoints: de-duplicates identical coordinates (short route)", () => {
  const pts = sampleRoutePoints([[8.80, 53.05], [8.80, 53.05]], 4);
  assert.equal(pts.length, 1);
});

test("sampleRoutePoints: empty geometry yields no points", () => {
  assert.deepEqual(sampleRoutePoints([], 4), []);
});

// --- pickPlaceName -----------------------------------------------------------

test("pickPlaceName: prefers suburb (Bremen Stadtteil level) over city", () => {
  const picked = pickPlaceName({ suburb: "Vegesack", city: "Bremen", state: "Bremen" });
  assert.equal(picked.name, "Vegesack");
  assert.equal(picked.field, "suburb");
  assert.equal(picked.city, "Bremen");
});

test("pickPlaceName: falls back to city when no finer field is present", () => {
  const picked = pickPlaceName({ city: "Bremen" });
  assert.equal(picked.name, "Bremen");
});

test("pickPlaceName: returns null when nothing recognisable is present", () => {
  assert.equal(pickPlaceName({ country: "Deutschland" }), null);
  assert.equal(pickPlaceName(null), null);
});

// --- wikipediaTitleCandidates ------------------------------------------------

test("wikipediaTitleCandidates: tries the city-qualified title FIRST to avoid same-name collisions", () => {
  const c = wikipediaTitleCandidates({ name: "Neustadt", city: "Bremen" });
  assert.deepEqual(c, ["Neustadt (Bremen)", "Neustadt"]);
});

test("wikipediaTitleCandidates: no redundant qualifier when place already equals the city", () => {
  assert.deepEqual(wikipediaTitleCandidates({ name: "Bremen", city: "Bremen" }), ["Bremen"]);
});

// --- fetchWikipediaSummary ---------------------------------------------------

function wikiFetch(byTitle) {
  // byTitle: map of decoded title -> { status, body }
  return async (url) => {
    const title = decodeURIComponent(url.split("/").pop());
    const entry = byTitle[title] || { status: 404, body: {} };
    return { ok: entry.status >= 200 && entry.status < 300, status: entry.status, json: async () => entry.body };
  };
}

const STANDARD = (extract, extra = {}) => ({
  status: 200,
  body: { type: "standard", title: extra.title || "T", extract, content_urls: { desktop: { page: "https://de.wikipedia.org/wiki/T" } }, ...extra },
});

test("fetchWikipediaSummary: returns a verbatim extract + source url for a standard article", async () => {
  const fetchImpl = wikiFetch({ Vegesack: STANDARD("Vegesack ist ein Stadtteil von Bremen.", { title: "Vegesack" }) });
  const card = await fetchWikipediaSummary("Vegesack", { fetchImpl, mustMention: "Bremen" });
  assert.equal(card.title, "Vegesack");
  assert.equal(card.extract, "Vegesack ist ein Stadtteil von Bremen.");
  assert.equal(card.url, "https://de.wikipedia.org/wiki/T");
});

test("fetchWikipediaSummary: strips the pronunciation IPA from the returned extract", async () => {
  const fetchImpl = wikiFetch({
    Vegesack: STANDARD("Vegesack [ˈfeːgəˌzak] ist ein Stadtteil von Bremen.", { title: "Vegesack" }),
  });
  const card = await fetchWikipediaSummary("Vegesack", { fetchImpl, mustMention: "Bremen" });
  assert.equal(card.extract, "Vegesack ist ein Stadtteil von Bremen.");
});

test("fetchWikipediaSummary: skips disambiguation pages (returns null, never guesses)", async () => {
  const fetchImpl = wikiFetch({ Neustadt: { status: 200, body: { type: "disambiguation", extract: "Neustadt steht für …" } } });
  assert.equal(await fetchWikipediaSummary("Neustadt", { fetchImpl }), null);
});

test("fetchWikipediaSummary: skips a 404 (no such article)", async () => {
  const fetchImpl = wikiFetch({});
  assert.equal(await fetchWikipediaSummary("Nirgendwo", { fetchImpl }), null);
});

test("fetchWikipediaSummary: the mustMention guard rejects a same-named place elsewhere", async () => {
  // A bare "Neustadt" article that is about a different Neustadt (no mention of Bremen) must be
  // rejected — that is the guard that keeps the card grounded to THIS route.
  const fetchImpl = wikiFetch({ Neustadt: STANDARD("Neustadt an der Weinstraße ist eine Stadt in Rheinland-Pfalz.") });
  assert.equal(await fetchWikipediaSummary("Neustadt", { fetchImpl, mustMention: "Bremen" }), null);
});

// --- collectTouristInfo (full orchestration, mocked collaborators) -----------

// A stand-in for the injected `fetchWikipedia(title, {mustMention})` that routes through the REAL
// fetchWikipediaSummary over a mocked HTTP layer — so the orchestration test also exercises the
// disambiguation/mustMention guards, not just a happy-path stub.
function wikiSummaryFrom(byTitle) {
  const fetchImpl = wikiFetch(byTitle);
  return (title, opts) => fetchWikipediaSummary(title, { fetchImpl, mustMention: opts && opts.mustMention });
}

test("collectTouristInfo: end-to-end over mocks — grounded, ordered, de-duplicated cards", async () => {
  const coords = [[8.80, 53.05], [8.74, 53.14], [8.62, 53.17]];
  const revByKey = {
    "8.8,53.05": { address: { suburb: "Neustadt", city: "Bremen" } },
    "8.74,53.14": { address: { suburb: "Gröpelingen", city: "Bremen" } },
    "8.62,53.17": { address: { suburb: "Vegesack", city: "Bremen" } },
  };
  const reverseGeocode = async (lon, lat) => revByKey[`${lon},${lat}`] || null;
  const fetchWikipedia = wikiSummaryFrom({
    "Neustadt (Bremen)": STANDARD("Die Neustadt ist ein Stadtteil von Bremen.", { title: "Neustadt (Bremen)" }),
    "Gröpelingen": STANDARD("Gröpelingen ist ein Stadtteil von Bremen.", { title: "Gröpelingen" }),
    Vegesack: STANDARD("Vegesack ist ein Stadtteil von Bremen.", { title: "Vegesack" }),
  });
  const res = await collectTouristInfo({ coordinates: coords, count: 3 }, { reverseGeocode, fetchWikipedia });
  assert.equal(res.places.length, 3);
  assert.deepEqual(res.places.map((p) => p.place), ["Neustadt", "Gröpelingen", "Vegesack"]);
  assert.equal(res.places[0].wikipedia.title, "Neustadt (Bremen)"); // city-qualified title won
  assert.ok(res.places[0].source.text_from.includes("wikipedia"));
});

test("collectTouristInfo: a place with no article is skipped, not fatal", async () => {
  const coords = [[8.80, 53.05], [8.62, 53.17]];
  const reverseGeocode = async (lon) => (lon === 8.80
    ? { address: { suburb: "Vegesack", city: "Bremen" } }
    : { address: { suburb: "Nirgendwo", city: "Bremen" } });
  const fetchWikipedia = wikiSummaryFrom({
    Vegesack: STANDARD("Vegesack ist ein Stadtteil von Bremen.", { title: "Vegesack" }),
  });
  const res = await collectTouristInfo({ coordinates: coords, count: 2 }, { reverseGeocode, fetchWikipedia });
  assert.equal(res.places.length, 1);
  assert.equal(res.places[0].place, "Vegesack");
  assert.ok(res.skipped.some((s) => s.reason === "no-wikipedia-article" && s.place === "Nirgendwo"));
});

test("collectTouristInfo: a reverse-geocode failure on one point doesn't sink the section", async () => {
  const coords = [[8.80, 53.05], [8.62, 53.17]];
  const reverseGeocode = async (lon) => {
    if (lon === 8.80) throw new Error("nominatim 500");
    return { address: { suburb: "Vegesack", city: "Bremen" } };
  };
  const fetchWikipedia = wikiSummaryFrom({
    Vegesack: STANDARD("Vegesack ist ein Stadtteil von Bremen.", { title: "Vegesack" }),
  });
  const res = await collectTouristInfo({ coordinates: coords, count: 2 }, { reverseGeocode, fetchWikipedia });
  assert.equal(res.places.length, 1);
  assert.ok(res.skipped.some((s) => s.reason === "reverse-geocode-failed"));
});
