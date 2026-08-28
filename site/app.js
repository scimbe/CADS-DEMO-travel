"use strict";

/**
 * Calls /api/plan and renders the raw OSRM output and the LLM-formatted answer SIDE BY SIDE —
 * that comparison is the entire point of this demo, not an afterthought. Nothing here computes a
 * route fact; this file only displays what the bridge (server.js) already computed/verified.
 */

const form = document.getElementById("plan-form");
const textInput = document.getElementById("text");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const rawPanel = document.getElementById("raw-panel");
const llmPanel = document.getElementById("llm-panel");

document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    textInput.value = btn.dataset.text;
  });
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  const badge = verify.pass
    ? '<span class="verify-pass">✓ verifiziert: Zahlen stimmen mit der Engine überein</span>'
    : '<span class="verify-fail">✗ Verifikation fehlgeschlagen — siehe Details</span>';
  llmPanel.innerHTML = `
    <p>${badge}</p>
    <pre>${escapeHtml(answerText)}</pre>
    ${verify.warnings.length ? `<p class="muted">Hinweise: ${verify.warnings.map(escapeHtml).join("; ")}</p>` : ""}
  `;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  statusEl.textContent = "Anfrage läuft — Geokodierung, Routing-Engine, dann Sprachmodell …";
  rawPanel.innerHTML = '<span class="muted">…</span>';
  llmPanel.innerHTML = '<span class="muted">…</span>';
  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: textInput.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderRaw(data.picked_route, data.provenance);
    renderLlm(data.llm_answer, data.verify);
    statusEl.textContent = `Fertig — Absicht erkannt: ${data.intent.origin} → ${data.intent.destination} (${data.intent.preference})`;
  } catch (err) {
    statusEl.innerHTML = `<span class="error">Fehler: ${escapeHtml(err.message)}</span>`;
    rawPanel.innerHTML = '<span class="muted">—</span>';
    llmPanel.innerHTML = '<span class="muted">—</span>';
  } finally {
    submitBtn.disabled = false;
  }
});
