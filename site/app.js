"use strict";

/**
 * Calls /api/plan and renders the raw OSRM output and the LLM-formatted answer SIDE BY SIDE —
 * that comparison is the entire point of this demo, not an afterthought. Nothing here computes a
 * route fact; this file only displays what the bridge (server.js) already computed/verified.
 *
 * After the plan renders, it separately calls /api/tourist-info to fill the "Sehenswertes entlang
 * der Route" section — grounded Wikipedia info for the real places the route passes through. That
 * call is deliberately non-blocking: the two plan panels never wait on it, and if it fails the
 * plan is still fully usable.
 */

const form = document.getElementById("plan-form");
const textInput = document.getElementById("text");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const rawPanel = document.getElementById("raw-panel");
const llmPanel = document.getElementById("llm-panel");
const tourismSection = document.getElementById("tourism");
const tourismBody = document.getElementById("tourism-body");

document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    textInput.value = btn.dataset.text;
  });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderRaw(route, provenance) {
  const km = (route.distance / 1000).toFixed(1);
  const min = Math.round(route.duration / 60);
  rawPanel.innerHTML = `
    <p><strong>${km} km</strong> · <strong>${min} min</strong> (exakte Werte: ${route.distance} m / ${route.duration} s)</p>
    <p class="muted">${escapeHtml(provenance.engine)} — Datensatz ${escapeHtml(provenance.dataset)}</p>
    <p class="muted">Präferenz: ${escapeHtml(provenance.preference)} (${escapeHtml(provenance.preference_description)})</p>
    <details><summary>Rohes JSON</summary><pre>${escapeHtml(JSON.stringify({ distance: route.distance, duration: route.duration, weight: route.weight }, null, 2))}</pre></details>
  `;
}

function renderLlm(answerText, verify) {
  // Defensive: an older/edge bridge response could omit `verify` or `verify.warnings`. Never let
  // that throw and leave this panel blank while the raw panel next to it renders — the whole point
  // is the side-by-side, so a degraded LLM panel must still SAY something.
  const v = verify || {};
  const warnings = Array.isArray(v.warnings) ? v.warnings : [];
  let badge;
  if (v.pass === true) {
    badge = '<span class="verify-pass">✓ verifiziert: Zahlen stimmen mit der Engine überein</span>';
  } else if (v.pass === false) {
    badge = '<span class="verify-fail">✗ Verifikation fehlgeschlagen — siehe Details</span>';
  } else {
    badge = '<span class="muted">Verifikationsstatus nicht verfügbar</span>';
  }
  llmPanel.innerHTML = `
    <p>${badge}</p>
    <pre>${escapeHtml(answerText || "(keine Antwort des Sprachmodells erhalten)")}</pre>
    ${warnings.length ? `<p class="muted">Hinweise: ${warnings.map(escapeHtml).join("; ")}</p>` : ""}
  `;
}

function renderTourismCard(p) {
  const w = p.wikipedia;
  const thumb = w.thumbnail
    ? `<img class="tourism-thumb" src="${escapeHtml(w.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : "";
  const link = w.url
    ? `<a href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer">Quelle: Wikipedia</a>`
    : "Quelle: Wikipedia";
  return `
    <article class="tourism-card">
      ${thumb}
      <div class="tourism-card-text">
        <h3>${escapeHtml(w.title)} <span class="muted">· liegt an der Route (${escapeHtml(p.place)})</span></h3>
        <p>${escapeHtml(w.extract)}</p>
        <p class="muted tourism-src">${link}</p>
      </div>
    </article>
  `;
}

function renderTourism(result) {
  const places = (result && Array.isArray(result.places)) ? result.places : [];
  if (places.length === 0) {
    tourismBody.innerHTML =
      '<p class="muted">Für die Orte entlang dieser Route liegt kein passender Wikipedia-Artikel vor.</p>';
    return;
  }
  tourismBody.innerHTML = places.map(renderTourismCard).join("");
}

async function fetchTouristInfo(pickedRoute) {
  const geometry = pickedRoute && pickedRoute.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    tourismSection.hidden = true;
    return;
  }
  tourismSection.hidden = false;
  tourismBody.innerHTML =
    '<p class="muted">Orte entlang der Route werden ermittelt (Reverse-Geocoding + Wikipedia) …</p>';
  try {
    const res = await fetch("/api/tourist-info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ geometry }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderTourism(data);
  } catch (err) {
    tourismBody.innerHTML = `<p class="muted">Sehenswertes konnte nicht geladen werden: ${escapeHtml(err.message)}</p>`;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  statusEl.textContent = "Anfrage läuft — Geokodierung, Routing-Engine, dann Sprachmodell …";
  rawPanel.innerHTML = '<span class="muted">…</span>';
  llmPanel.innerHTML = '<span class="muted">…</span>';
  tourismSection.hidden = true;
  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: textInput.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // Render each panel independently so a hiccup in one never blanks the other.
    try { renderRaw(data.picked_route, data.provenance); } catch (e2) { rawPanel.innerHTML = `<span class="error">Roh-Panel-Fehler: ${escapeHtml(e2.message)}</span>`; }
    try { renderLlm(data.llm_answer, data.verify); } catch (e2) { llmPanel.innerHTML = `<span class="error">KI-Panel-Fehler: ${escapeHtml(e2.message)}</span>`; }
    statusEl.textContent = `Fertig — Absicht erkannt: ${data.intent.origin} → ${data.intent.destination} (${data.intent.preference})`;
    // Non-blocking enrichment: does not gate the panels above.
    fetchTouristInfo(data.picked_route);
  } catch (err) {
    statusEl.innerHTML = `<span class="error">Fehler: ${escapeHtml(err.message)}</span>`;
    rawPanel.innerHTML = '<span class="muted">—</span>';
    llmPanel.innerHTML = '<span class="muted">—</span>';
    tourismSection.hidden = true;
  } finally {
    submitBtn.disabled = false;
  }
});
