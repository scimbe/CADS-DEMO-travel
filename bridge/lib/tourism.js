"use strict";

/**
 * "Sehenswertes entlang der Route" — grounded tourist info for the places the computed route
 * actually passes through. Same anti-hallucination discipline as the rest of this demo (see
 * README.md): NOTHING here is invented.
 *
 *   1. Points are sampled from the OSRM route geometry itself (the real LineString the engine
 *      returned), never from anything the LLM said.
 *   2. Each sample point is reverse-geocoded (Nominatim) to the real OSM place it sits in — so a
 *      place can only appear if the route physically runs through it.
 *   3. The description text is the German Wikipedia REST summary `extract`, shown VERBATIM with a
 *      visible source link. The LLM does not touch it — there is deliberately no rephrasing step,
 *      so there is no number to guard and no sentence to hallucinate. If Wikipedia has no plain
 *      article for a place (missing, or a disambiguation page), that place is simply skipped.
 *
 * Every network collaborator (reverseGeocode, fetchWikipedia) is injected so the orchestration is
 * unit-testable without touching Nominatim or Wikipedia (see test/tourism.test.js).
 */

const WIKIPEDIA_SUMMARY_BASE =
  process.env.WIKIPEDIA_SUMMARY_BASE || "https://de.wikipedia.org/api/rest_v1/page/summary";
const WIKIPEDIA_USER_AGENT = process.env.WIKIPEDIA_USER_AGENT || "CADS-Demo-Travel/1.0";

/**
 * Pure text tidy-up for the verbatim Wikipedia extract: drops the pronunciation IPA span that
 * German Wikipedia often puts right after a place name ("Hannover [haˈnoːfɐ] …", "Kiel (IPA:
 * [kiːl]) …"). It reads as noise in the card and would be gibberish for any later speech output.
 *
 * This is NOT a rewrite and touches no fact: it only removes bracketed spans that either contain
 * an IPA stress/length/tone mark (ˈ ˌ ː ˑ ‿ ˥˦˧˨˩) or an explicit "IPA:" label. Ordinary
 * parentheses with real content — "(Hansestadt)", "(2023)", "(bairisch)" — carry no such marker
 * and are left untouched. Keeping it a plain, marker-gated string operation (no LLM, no number
 * handling) preserves the demo's grounding guarantee. Consistent with the shared sanitizer used
 * centrally in the atlas.
 */
function stripPronunciation(t) {
  return String(t || "")
    // Bracketed span containing an IPA stress/length/tone mark: "[haˈnoːfɐ]", "(kiːl)".
    .replace(/[\[(（][^\[\]()（）]*[ˈˌːˑ‿˥˦˧˨˩][^\[\]()（）]*[\])）]/gu, "")
    // Explicit "IPA: …" span: "(IPA: [kiːl])" leaves "(IPA: )" after the line above, dropped here.
    .replace(/[\[(（][^\[\]()（）]*\bIPA\b[^\[\]()（）]*[\])）]/gi, "")
    // Tidy the gaps the removals leave behind (doubled spaces, a space before punctuation).
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

/** Haversine distance in meters between two [lon,lat] points. Used only to space sample points
 *  evenly BY DISTANCE along the polyline (OSRM's vertices are unevenly dense), never to state a
 *  route fact — the route's distance/duration always come from OSRM, not from this. */
function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Picks `count` points spread evenly by travelled distance along the route's [lon,lat] vertices,
 * always including the exact first (start) and last (destination) vertex. Returns an array of
 * `{ lon, lat, fraction }` (fraction = 0..1 of the route length), de-duplicated by identical
 * coordinate. Pure function — no I/O.
 *
 * @param {Array<[number,number]>} coordinates  OSRM geometry.coordinates (GeoJSON [lon,lat])
 * @param {number} count  total sample points wanted (>= 2); clamped to what the polyline supports
 */
function sampleRoutePoints(coordinates, count = 4) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return [];
  if (coordinates.length === 1) {
    const [lon, lat] = coordinates[0];
    return [{ lon, lat, fraction: 0 }];
  }
  const n = Math.max(2, Math.floor(count));

  // Cumulative distance at each vertex.
  const cum = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(coordinates[i - 1], coordinates[i]));
  }
  const total = cum[cum.length - 1];

  const out = [];
  const seen = new Set();
  for (let k = 0; k < n; k++) {
    const fraction = k / (n - 1);
    const target = fraction * total;
    // Vertex whose cumulative distance is NEAREST the target (not merely the first past it):
    // with sparse vertices, "first past" overshoots and makes adjacent samples collapse onto the
    // same far vertex; nearest keeps distinct samples distinct. Linear scan — these polylines are
    // ~hundreds of points, so a binary search would be premature.
    let idx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < cum.length; i++) {
      const diff = Math.abs(cum[i] - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        idx = i;
      }
    }
    const [lon, lat] = coordinates[idx];
    const dedupeKey = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ lon, lat, fraction });
  }
  return out;
}

// Nominatim `address` fields, best-first, that name a place a tourist would recognise as a stop
// along the way. `suburb` is the Bremen "Stadtteil" level (Vegesack, Gröpelingen, …); `city`
// catches the endpoints when they resolve to the municipality itself.
const PLACE_ADDRESS_FIELDS = ["suburb", "quarter", "city_district", "borough", "town", "village", "city", "municipality"];

/** From a Nominatim reverse `address` object, returns the best single place name to look up, or
 *  null if none of the recognised fields are present. Pure. */
function pickPlaceName(address) {
  if (!address || typeof address !== "object") return null;
  for (const field of PLACE_ADDRESS_FIELDS) {
    if (address[field] && typeof address[field] === "string") {
      return { name: address[field], field, city: address.city || address.town || address.municipality || null };
    }
  }
  return null;
}

/** Ordered, de-duplicated Wikipedia title candidates for a place. The city-qualified form is
 *  tried FIRST because bare district names ("Neustadt", "Blumenthal") collide with famous
 *  places elsewhere — qualifying with the city is what keeps the article grounded to THIS route.
 *  Pure. */
function wikipediaTitleCandidates({ name, city }) {
  const candidates = [];
  const push = (t) => {
    if (t && !candidates.includes(t)) candidates.push(t);
  };
  if (city && city !== name) push(`${name} (${city})`);
  push(name);
  return candidates;
}

/**
 * Fetches ONE German-Wikipedia REST summary. Returns a grounded card `{ title, extract, url,
 * thumbnail }` only for a real, plain (`type === "standard"`) article whose extract additionally
 * mentions `mustMention` (the city) — that mention is the guard that the article is about the
 * place ON the route and not a same-named place elsewhere. Returns null for 404, disambiguation
 * pages, empty extracts, or a failed city-mention check. Never throws on a normal miss.
 *
 * @param {string} title
 * @param {{fetchImpl?: Function, mustMention?: string}} [opts]
 */
async function fetchWikipediaSummary(title, { fetchImpl = fetch, mustMention = null } = {}) {
  const url = `${WIKIPEDIA_SUMMARY_BASE}/${encodeURIComponent(title)}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": WIKIPEDIA_USER_AGENT } });
  } catch {
    return null; // network hiccup on an optional, non-blocking enrichment — skip, don't fail
  }
  if (!res.ok) return null; // 404 (no such article) and every other non-2xx: nothing to show
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || body.type === "disambiguation") return null; // ambiguous → skip, don't guess
  const extract = typeof body.extract === "string" ? body.extract.trim() : "";
  if (!extract) return null;
  // The city-mention guard runs on the RAW extract — the city name lives in prose, never inside
  // an IPA span, so pronunciation-stripping can't affect this grounding check either way.
  if (mustMention && !extract.toLowerCase().includes(mustMention.toLowerCase())) return null;
  return {
    title: body.title || title,
    // Verbatim from Wikipedia; only the pronunciation IPA span is dropped (see stripPronunciation)
    // — no rephrasing, no fact touched, no LLM.
    extract: stripPronunciation(extract),
    url: (body.content_urls && body.content_urls.desktop && body.content_urls.desktop.page) || null,
    thumbnail: (body.thumbnail && body.thumbnail.source) || null,
  };
}

/** Tries each candidate title until one yields a grounded card. */
async function resolveWikipediaCard({ name, city }, { fetchWikipedia }) {
  for (const title of wikipediaTitleCandidates({ name, city })) {
    const card = await fetchWikipedia(title, { mustMention: city || "Bremen" });
    if (card) return card;
  }
  return null;
}

/**
 * Full orchestration: route geometry -> sampled points -> reverse-geocoded place names ->
 * de-duplicated -> Wikipedia summaries -> grounded cards, in route order.
 *
 * @param {{coordinates: Array<[number,number]>, count?: number}} route
 * @param {{reverseGeocode: Function, fetchWikipedia: Function, maxPlaces?: number}} deps
 * @returns {Promise<{places: Array, sampled: number, skipped: Array}>}
 */
async function collectTouristInfo({ coordinates, count = 4 }, { reverseGeocode, fetchWikipedia, maxPlaces = 5 }) {
  const points = sampleRoutePoints(coordinates, count);
  const places = [];
  const skipped = [];
  const seenNames = new Set();

  for (const pt of points) {
    let rev;
    try {
      rev = await reverseGeocode(pt.lon, pt.lat);
    } catch {
      skipped.push({ reason: "reverse-geocode-failed", fraction: pt.fraction });
      continue;
    }
    const picked = pickPlaceName(rev && rev.address);
    if (!picked) {
      skipped.push({ reason: "no-place-name", fraction: pt.fraction });
      continue;
    }
    const nameKey = picked.name.toLowerCase();
    if (seenNames.has(nameKey)) continue; // same Stadtteil sampled twice — one card is enough
    seenNames.add(nameKey);

    const card = await resolveWikipediaCard(picked, { fetchWikipedia });
    if (!card) {
      skipped.push({ reason: "no-wikipedia-article", place: picked.name, fraction: pt.fraction });
      continue;
    }
    places.push({
      place: picked.name, // the real OSM place the route runs through
      fraction: pt.fraction,
      coord: { lon: pt.lon, lat: pt.lat },
      source: {
        place_from: "OpenStreetMap / Nominatim reverse-geocode of the OSRM route geometry",
        text_from: "de.wikipedia.org (REST summary, verbatim)",
      },
      wikipedia: card,
    });
    if (places.length >= maxPlaces) break;
  }

  return { places, sampled: points.length, skipped };
}

module.exports = {
  haversineMeters,
  stripPronunciation,
  sampleRoutePoints,
  pickPlaceName,
  wikipediaTitleCandidates,
  fetchWikipediaSummary,
  resolveWikipediaCard,
  collectTouristInfo,
  WIKIPEDIA_SUMMARY_BASE,
  WIKIPEDIA_USER_AGENT,
  PLACE_ADDRESS_FIELDS,
};
