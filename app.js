/* FlowLoad — logique front-end */
"use strict";

const $ = (s) => document.querySelector(s);

const QUALITIES = {
  video: [
    ["best", "Auto — meilleure qualité"],
    ["2160", "2160p — 4K UHD"],
    ["1440", "1440p — 2K"],
    ["1080", "1080p — Full HD"],
    ["720", "720p — HD"],
    ["480", "480p — SD"],
    ["360", "360p — basse"],
  ],
  audio: [
    ["320", "320 kbps — maximale"],
    ["256", "256 kbps — haute"],
    ["192", "192 kbps — standard"],
    ["128", "128 kbps — léger"],
  ],
};

let analyzed = null;   // métadonnées de la dernière analyse
let mode = "video";    // "video" | "audio"
const seenStatus = {}; // id -> dernier statut connu (pour les toasts)

// ---------------------------------------------------------------- utilitaires
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fmtBytes(n) {
  if (!n || n < 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtSpeed(s) {
  return s && s > 0 ? `${fmtBytes(s)}/s` : null;
}

function fmtEta(sec) {
  if (sec == null || sec < 0) return null;
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m} min${s ? ` ${s} s` : ""}`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function fmtViews(n) {
  if (n == null) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(".", ",")} Md de vues`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(".", ",")} M de vues`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} k de vues`;
  return `${n} vues`;
}

function fmtDuration(sec) {
  if (sec == null) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

let toastTimer = null;
function toast(message, type = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (!res.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === "string" ? detail : `Erreur ${res.status}`);
  }
  return data;
}

const postJson = (path, body) => api(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------- analyse
function fillQualitySelect() {
  const sel = $("#quality-select");
  sel.innerHTML = QUALITIES[mode]
    .map(([v, label]) => `<option value="${v}">${label}</option>`)
    .join("");
}

function renderResult() {
  const card = $("#result-card");
  if (!analyzed) { card.classList.add("hidden"); return; }

  const img = $("#r-thumb");
  if (analyzed.thumbnail) {
    img.src = analyzed.thumbnail;
    img.alt = "";
    img.style.display = "";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
  }

  $("#r-duration").textContent = analyzed.duration_string || fmtDuration(analyzed.duration) || "";
  $("#r-live").classList.toggle("hidden", !analyzed.is_live);
  $("#r-platform").textContent = analyzed.platform || "Web";
  $("#r-title").textContent = analyzed.title || "Sans titre";

  const parts = [];
  if (analyzed.uploader) parts.push(escapeHtml(analyzed.uploader));
  const views = fmtViews(analyzed.view_count);
  if (views) parts.push(views);
  $("#r-sub").innerHTML = parts.length ? parts.join(' <span class="sep">•</span> ') : "&nbsp;";

  card.classList.remove("hidden");
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#analyze-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#url-input").value.trim();
  if (!url) return;
  const btn = $("#analyze-btn");
  btn.disabled = true;
  btn.textContent = "Analyse…";
  try {
    const data = await postJson("/api/info", { url });
    analyzed = { ...data, url };
    renderResult();
    toast("Lien analysé avec succès", "ok");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyser";
  }
});

// ---------------------------------------------------------------- téléchargement
document.querySelectorAll(".seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    fillQualitySelect();
  });
});

async function startDownload(payload) {
  const data = await postJson("/api/download", payload);
  toast("Téléchargement démarré ⚡", "ok");
  await refreshJobs();
  return data;
}

$("#download-btn").addEventListener("click", async () => {
  if (!analyzed) return;
  const btn = $("#download-btn");
  btn.disabled = true;
  try {
    await startDownload({
      url: analyzed.url,
      mode,
      quality: $("#quality-select").value,
      title: analyzed.title,
      thumbnail: analyzed.thumbnail,
    });
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- liste des jobs
const STATUS_LABEL = {
  queued: "En file d'attente…",
  preparing: "Préparation de la requête…",
  downloading: "Téléchargement…",
  processing: "Conversion / assemblage…",
  done: "Terminé",
  error: "Échec",
};

function activeJobHtml(job) {
  const pct = job.progress ?? 0;
  const indeterminate = job.status === "queued" || job.status === "preparing";
  const details = [];
  if (job.status === "downloading") {
    const sp = fmtSpeed(job.speed);
    if (sp) details.push(sp);
    const eta = fmtEta(job.eta);
    if (eta) details.push(`reste ~${eta}`);
    details.push(`${Math.round(pct)} %`);
  } else if (job.status === "processing") {
    details.push("ffmpeg travaille…");
  }
  const statusLine = [STATUS_LABEL[job.status] || job.status, ...details].join(" · ");

  return `
    <div class="job" data-id="${job.id}">
      ${job.thumbnail
        ? `<img class="job-thumb" src="${escapeHtml(job.thumbnail)}" alt="">`
        : `<div class="job-thumb placeholder">⏳</div>`}
      <div class="job-main">
        <div class="job-title">${escapeHtml(job.title || "…")}</div>
        <div class="job-meta">
          <span class="pill ${job.mode}">${job.mode === "audio" ? "MP3" : "MP4"}</span>
          <span>${escapeHtml(job.quality === "best" ? "auto" : job.mode === "audio" ? job.quality + " kbps" : job.quality + "p")}</span>
        </div>
        <div class="bar ${indeterminate ? "indeterminate" : ""}"><i style="width:${indeterminate ? 100 : pct}%"></i></div>
        <div class="job-status">${escapeHtml(statusLine)}</div>
      </div>
    </div>`;
}

function finishedJobHtml(job) {
  const isError = job.status === "error";
  const meta = [];
  meta.push(`<span class="pill ${job.mode}">${job.mode === "audio" ? "MP3" : "MP4"}</span>`);
  if (job.mode === "audio") meta.push(`${escapeHtml(job.quality)} kbps`);
  else if (job.quality !== "best") meta.push(`${escapeHtml(job.quality)}p`);
  if (job.filesize) meta.push(fmtBytes(job.filesize));
  if (job.filename) meta.push(escapeHtml(job.filename));

  const actions = isError
    ? `<button class="btn retry" data-id="${job.id}">↻ Réessayer</button>
       <button class="btn danger del" data-id="${job.id}">🗑 Supprimer</button>`
    : `<a class="btn save" href="/api/file/${job.id}">⬇ Enregistrer</a>
       <button class="btn danger del" data-id="${job.id}">🗑</button>`;

  return `
    <div class="job ${isError ? "err" : ""}" data-id="${job.id}">
      ${job.thumbnail
        ? `<img class="job-thumb" src="${escapeHtml(job.thumbnail)}" alt="">`
        : `<div class="job-thumb placeholder">${isError ? "⚠️" : "✅"}</div>`}
      <div class="job-main">
        <div class="job-title">${escapeHtml(job.title || job.url)}</div>
        <div class="job-meta">${meta.join(' <span class="sep">•</span> ')}</div>
        ${isError ? `<div class="job-status error">${escapeHtml(job.error || "Erreur inconnue")}</div>` : ""}
      </div>
      <div class="job-actions">${actions}</div>
    </div>`;
}

async function refreshJobs() {
  let jobs = [];
  try {
    const data = await api("/api/jobs");
    jobs = data.jobs || [];
  } catch {
    return; // erreur réseau transitoire : on réessaiera au prochain tick
  }

  const list = $("#jobs-list");
  const count = $("#jobs-count");
  count.textContent = jobs.length ? String(jobs.length) : "";

  if (!jobs.length) {
    list.innerHTML = `<p class="empty">Aucun téléchargement pour l'instant. Analysez un lien ci-dessus pour commencer.</p>`;
    return;
  }

  const active = jobs.filter((j) => !["done", "error"].includes(j.status));
  const finished = jobs.filter((j) => ["done", "error"].includes(j.status));
  list.innerHTML = [...active.map(activeJobHtml), ...finished.map(finishedJobHtml)].join("");

  // Toast au changement de statut
  for (const job of jobs) {
    const prev = seenStatus[job.id];
    if (prev && prev !== job.status) {
      if (job.status === "done") toast(`« ${job.title || "Fichier"} » est prêt — cliquez sur Enregistrer ⬇`, "ok");
      if (job.status === "error") toast(job.error || "Le téléchargement a échoué", "error");
    }
    seenStatus[job.id] = job.status;
  }
  // Oublier les jobs supprimés
  for (const id of Object.keys(seenStatus)) {
    if (!jobs.some((j) => j.id === id)) delete seenStatus[id];
  }
}

// Actions sur les jobs (délégation d'événements)
$("#jobs-list").addEventListener("click", async (e) => {
  const del = e.target.closest(".del");
  const retry = e.target.closest(".retry");
  try {
    if (del) {
      await api(`/api/jobs/${del.dataset.id}`, { method: "DELETE" });
      toast("Élément supprimé", "ok");
      await refreshJobs();
    } else if (retry) {
      const jobsData = await api("/api/jobs");
      const job = (jobsData.jobs || []).find((j) => j.id === retry.dataset.id);
      if (!job) return;
      await startDownload({
        url: job.url,
        mode: job.mode,
        quality: job.quality,
        title: job.title,
        thumbnail: job.thumbnail,
      });
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

// ---------------------------------------------------------------- init
fillQualitySelect();
refreshJobs();
setInterval(refreshJobs, 1500);

// Pont vers l'application Android (APK FlowLoad) : bouton ⚙ de réglage du serveur
if (window.FlowLoadAndroid) {
  const gear = document.getElementById("gear-server");
  if (gear) {
    gear.classList.remove("hidden");
    gear.addEventListener("click", () => window.FlowLoadAndroid.showSettings());
  }
}

// PWA : enregistrement du service worker (ignore silencieusement hors HTTPS)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
