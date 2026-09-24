/* ============ Mudkit — logique de l'interface ============ */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------------- pont vers Python (ou simulation navigateur) ------- */

let MOCK = false;
const apiReady = new Promise((resolve) => {
  if (window.pywebview) return resolve();
  window.addEventListener("pywebviewready", resolve, { once: true });
  setTimeout(() => {
    if (!window.pywebview) { MOCK = true; resolve(); }
  }, 600);
});

/* Un appel qui echoue (exception Python, methode absente) ne doit jamais
   laisser l'interface bloquee : on journalise, on previent, et on renvoie
   null que chaque appelant traite comme un echec. */
async function api(method, ...args) {
  await apiReady;
  try {
    if (MOCK) return await mockApi(method, ...args);
    return await window.pywebview.api[method](...args);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    reportJsError(`appel ${method} : ${msg}`);
    toast(`Erreur interne (${method}) : ${msg}`, "err", 9000);
    return null;
  }
}

function reportJsError(msg) {
  console.error(msg);
  if (!MOCK && window.pywebview && window.pywebview.api)
    window.pywebview.api.log_js(String(msg)).catch(() => {});
}
window.addEventListener("error", (e) =>
  reportJsError(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  reportJsError(`promesse rejetée : ${(r && (r.stack || r.message)) || r}`);
});

/* ---------------- etat ---------------- */

const S = {
  dl: { mode: "video", quality: "max", vformat: "mp4", aformat: "mp3",
        dest: "", queue: [], current: null, lastInfo: null,
        sec: { on: false, dur: 0, a: 0, b: 0 } },
  cp: { files: [], target: 25, running: false },
  bg: { files: [], model: "best", running: false, sel: null, results: {} },
  up: { files: [], model: null, scale: 4, format: "png", running: false,
        sel: null, results: {}, scaleUsed: 4 },
  cv: { files: [], target: null, running: false },
};
const previewCache = new Map();

/* ---------------- catalogue des modeles (libelles UI) ---------------- */

const MODEL_META = [
  ["standard",   "Upscayl Standard",  "le meilleur rendu général", true],
  ["ultrasharp", "UltraSharp",        "détails très nets — textes, UI, archi", true],
  ["remacri",    "Remacri",           "photos naturelles, sans sur-netteté", true],
  ["digital",    "Art numérique",     "dessins, illustrations, jeux", true],
  ["lite",       "Upscayl Lite",      "léger et rapide", true],
  ["photo",      "Real-ESRGAN Photo", "photos — modèle classique", false],
  ["anime",      "Real-ESRGAN Anime", "anime / manga — classique", false],
  ["fast",       "Rapide",            "polyvalent, x2–x4 natif", false],
];

/* ---------------- helpers ---------------- */

/* action : { label, run } — bouton dans le toast. Les erreurs proposent
   d'office de copier le rapport (journal + contexte) pour le signaler. */
function toast(msg, kind = "info", ms = 4200, action = null) {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  const txt = document.createElement("span");
  txt.textContent = msg;
  t.appendChild(txt);
  if (!action && kind === "err")
    action = { label: "Copier le rapport", run: () => copyReport(msg) };
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = action.label;
    b.addEventListener("click", () => action.run());
    t.appendChild(b);
    ms = Math.max(ms, 9000);
  }
  $("#toasts").appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 260);
  }, ms);
}

async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

async function copyReport(context) {
  const txt = await api("error_report", context || null);
  if (!txt) return;
  if (await copyText(txt))
    toast("Rapport copié — colle-le (Ctrl+V) dans ton message.", "ok");
  else
    toast("Copie impossible — Paramètres › Ouvrir le journal.", "info", 7000);
}

/* Notification Windows en fin de tache longue (Python ne l'affiche que si
   Mudkit est en arriere-plan). */
const LONG_TASK_MS = 20000;
function notifyIfLong(t0, title, text) {
  if (t0 && Date.now() - t0 >= LONG_TASK_MS) api("notify", title, text);
}

function stopRunning(st, btn, cancelBtn) {
  st.running = false;
  $(btn).disabled = false;
  $(cancelBtn).classList.add("hidden");
}

function fmtEta(sec) {
  if (sec == null) return "";
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m} min ${String(s).padStart(2, "0")} s` : `${s} s`;
}

function fmtTime(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60),
        s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
           : `${m}:${String(s).padStart(2, "0")}`;
}

function wirePills(sel, onPick) {
  $(sel).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $(sel).querySelectorAll("button").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    onPick(btn.dataset.v);
  });
}

function wireDrop(zone, kind, onPaths) {
  zone.addEventListener("click", async () => {
    const files = await api("pick_files", kind);
    if (files && files.length) onPaths(files);
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    // Les chemins des fichiers deposes arrivent cote Python (handler DOM
    // pywebview) puis reviennent via l'evenement "dropped" — pas ici.
    e.preventDefault();
    zone.classList.remove("drag");
  });
}

/* Routage des depots resolus cote Python : zone -> fonction d'ajout. */
const DROP_ROUTES = {
  "#up-drop": (p) => upAddPaths(p),
  "#cv-drop": (p) => cvAddPaths(p),
  "#cp-drop": (p) => cpAddPaths(p),
  "#bg-drop": (p) => bgAddPaths(p),
};

async function preview(path) {
  if (!previewCache.has(path))
    previewCache.set(path, await api("preview", path));
  return previewCache.get(path);
}

/* ---------------- navigation ---------------- */

function go(page) {
  $$(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) =>
    p.classList.toggle("active", p.id === `page-${page}`));
}
$$("[data-page]").forEach((b) =>
  b.addEventListener("click", () => {
    go(b.dataset.page);
    api("set_pref", "page", b.dataset.page); // rouvre sur le dernier outil
  }));

document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("input, textarea")) e.preventDefault();
});

/* Ctrl+V global : colle des fichiers copies dans l'Explorateur, une capture
   d'ecran du presse-papiers, ou un lien sur la page Telechargeur. */
document.addEventListener("keydown", async (e) => {
  if (!(e.ctrlKey && e.key.toLowerCase() === "v")) return;
  if (e.target && e.target.closest
      && e.target.closest("input, textarea")) return; // collage normal
  const page = document.querySelector(".page.active")?.id;

  if (page === "page-dl") {
    try {
      const txt = ((await navigator.clipboard.readText()) || "").trim();
      if (/^https?:\/\//i.test(txt)) {
        $("#dl-url").value = txt;
        toast("Lien collé — Entrée pour analyser, ou clique Télécharger.");
        return;
      }
    } catch { /* presse-papiers texte illisible : on tente les fichiers */ }
  }

  const res = await api("paste_files");
  const paths = (res && res.paths) || [];
  if (!paths.length) {
    toast("Rien à coller — copie d'abord des fichiers, une image ou un lien.");
    return;
  }
  if (res.captured)
    toast("Capture du presse-papiers enregistrée dans Images\\Mudkit.");
  if (page === "page-up") upAddPaths(paths);
  else if (page === "page-cv") cvAddPaths(paths);
  else if (page === "page-cp") cpAddPaths(paths);
  else if (page === "page-bg") bgAddPaths(paths);
  else toast("Va sur un outil (Upscaler, Convertisseur, Compresseur, Détourage) pour coller des fichiers.");
});

/* ---------------- thème clair / sombre (mémorisé côté Python) --------- */

function applyThemePref(theme) {  // clair (creme) par defaut
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

function wireTheme(st) {
  applyThemePref(st.theme);
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark"
      ? "light" : "dark";
    applyThemePref(next);
    api("set_pref", "theme", next);
  });
}

/* ---------------- accueil : moteurs ---------------- */

function engineState(id, html) { $(`#${id} .eng-state`).innerHTML = html; }

function renderEngines(st) {
  $("#net-dot").className =
    "dot " + (st.ffmpeg && st.realesrgan ? "ok" : "warn");

  const rows = [
    ["ffmpeg", st.ffmpeg, "ffmpeg"],
    ["realesrgan", st.realesrgan, "realesrgan"],
    ["upscayl", st.upscayl_models, "upscayl_models"],
  ];
  for (const [id, present, name] of rows) {
    engineState(`eng-${id}`, present
      ? `<span class="chip">installé</span>`
      : `<button class="btn sm" data-install="${name}">Installer</button>`);
  }
  engineState("eng-ytdlp",
    `<span class="chip dim">${st.ytdlp || "?"}</span>
     <button id="btn-ytdlp" class="btn sm">Mettre à jour</button>`);

  $$("[data-install]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "0 %";
      await api("install_tool", b.dataset.install);
    }));
  $("#btn-ytdlp").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "…";
    await api("update_ytdlp");
  });
}

/* ---------------- telechargeur : file d'attente ---------------- */

let qSeq = 0;
const qRows = new Map(); // id -> element de ligne

function qualityLabel(q) {
  return q === "max" ? "Max" : q === "2160" ? "4K" : q + "p";
}

function optsSummary(o) {
  const pl = o.playlist ? " · playlist" : "";
  const sec = o.section
    ? ` · ${fmtTime(o.section.start)}→${fmtTime(o.section.end)}` : "";
  return (o.mode === "video"
    ? `Vidéo · ${qualityLabel(o.quality)} · ${o.format.toUpperCase()}`
    : `Audio · ${o.format.toUpperCase()}`) + pl + sec;
}

function shortName(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname.slice(0, 30);
  } catch { return url.slice(0, 60); }
}

function siteInitials(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h.split(".")[0].slice(0, 2).toUpperCase();
  } catch { return "??"; }
}

function qRender() {
  const box = $("#dl-qitems");
  box.innerHTML = "";
  qRows.clear();
  $("#dl-queue").classList.toggle("hidden", !S.dl.queue.length);
  if (S.dl.queue.length) $("#dl-empty").classList.add("hidden");
  else if ($("#dl-media").classList.contains("hidden"))
    $("#dl-empty").classList.remove("hidden");

  S.dl.queue.forEach((it) => {
    const row = document.createElement("div");
    row.className = "frow";
    row.innerHTML = `
      ${it.thumb ? `<img class="qthumb" alt="">`
                 : `<div class="fico">${siteInitials(it.url)}</div>`}
      <div class="fmain">
        <div class="fname"></div>
        <div class="fsub">${optsSummary(it.opts)}<span class="qstats"></span></div>
        <div class="bar fbar hidden"><i></i></div>
      </div>
      <div class="fstate"></div>
      <button class="fdel" title="Retirer">✕</button>`;
    row.querySelector(".fname").textContent = it.title || shortName(it.url);
    if (it.thumb) row.querySelector(".qthumb").src = it.thumb;
    box.appendChild(row);
    qRows.set(it.id, row);

    const st = row.querySelector(".fstate");
    const del = row.querySelector(".fdel");
    if (it.status === "pending") {
      st.innerHTML = `<span class="st-wait">en attente</span>`;
    } else if (it.status === "running") {
      st.innerHTML = `<span class="spin"></span>`;
      row.querySelector(".fbar").classList.remove("hidden");
      del.classList.add("hidden");
    } else if (it.status === "done") {
      st.innerHTML = `<span class="st-ok">✓</span>`;
    } else if (it.status === "cancelled") {
      st.innerHTML = `<span class="st-wait">annulé</span>`;
    } else {
      st.innerHTML = `<span class="st-err" title="${it.error || ""}">✕</span>`;
    }
    del.addEventListener("click", () => {
      if (it.status === "running") return;
      S.dl.queue = S.dl.queue.filter((q) => q.id !== it.id);
      qRender();
    });
  });
  $("#btn-dl-cancel").classList.toggle("hidden", !S.dl.current);
}

function qPump() {
  if (S.dl.current) return;
  const it = S.dl.queue.find((q) => q.status === "pending");
  if (!it) return;
  it.status = "running";
  S.dl.current = it;
  if (!S.dl.batch) S.dl.batch = { t0: Date.now(), ok: 0, err: 0, title: "" };
  qRender();
  api("start_download", { url: it.url, ...it.opts }).then((ok) => {
    if (ok === true) return;
    if (ok === false) {  // moteur encore occupe : on remet en attente
      it.status = "pending";
      S.dl.current = null;
      qRender();
      setTimeout(qPump, 400);
      return;
    }
    // l'appel lui-meme a echoue (erreur deja signalee) : on passe au suivant
    it.status = "error";
    it.error = "le téléchargement n'a pas pu démarrer";
    S.dl.current = null;
    qRender();
    qPump();
  });
}

function wireDownloader(st) {
  S.dl.dest = st.download_dir;
  $("#dl-dest").textContent = st.download_dir;
  $("#dl-dest").title = st.download_dir;

  wirePills("#pills-quality", (v) => (S.dl.quality = v));
  wirePills("#pills-vformat", (v) => (S.dl.vformat = v));
  wirePills("#pills-aformat", (v) => (S.dl.aformat = v));
  wirePills("#seg-mode", (v) => {
    S.dl.mode = v;
    $("#dl-video-opts").classList.toggle("hidden", v !== "video");
    $("#dl-audio-opts").classList.toggle("hidden", v !== "audio");
  });

  $("#btn-paste").addEventListener("click", async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) $("#dl-url").value = txt.trim();
    } catch {
      toast("Impossible de lire le presse-papiers — colle avec Ctrl+V.", "err");
    }
  });

  $("#dl-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") analyze();
  });
  $("#btn-analyze").addEventListener("click", analyze);

  async function analyze() {
    const url = $("#dl-url").value.trim();
    if (!url) return toast("Colle d'abord un lien.", "err");
    const btn = $("#btn-analyze");
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>`;
    const res = await api("analyze_url", url);
    btn.disabled = false;
    btn.textContent = "Analyser le lien";
    if (!res) return;
    if (!res.ok) return toast("Analyse impossible : " + res.error, "err", 7000);
    const info = res.info;
    S.dl.lastInfo = { url, title: info.title, thumb: info.thumb };
    $("#dl-empty").classList.add("hidden");
    $("#dl-media").classList.remove("hidden");
    $("#dl-thumb").src = info.thumb || "";
    $("#dl-title").textContent = info.title;
    $("#dl-channel").textContent = info.channel;
    const badge = $("#dl-badge");
    if (info.kind === "playlist") {
      badge.textContent = `Playlist · ${info.count} vidéos`;
      badge.className = "tag orange";
      $("#dl-playlist-row").classList.remove("hidden");
      $("#dl-playlist").checked = true;
      $("#dl-section").classList.add("hidden");
      S.dl.sec.dur = 0;
    } else {
      badge.textContent = info.duration || "vidéo";
      badge.className = "tag";
      $("#dl-playlist-row").classList.add("hidden");
      $("#dl-playlist").checked = false;
      if (info.duration_s > 1) {
        secReset(info.duration_s);
        $("#dl-section").classList.remove("hidden");
      } else {
        $("#dl-section").classList.add("hidden");
        S.dl.sec.dur = 0;
      }
    }
  }

  $("#btn-dest").addEventListener("click", async () => {
    const d = await api("set_download_dir");
    if (d) {
      S.dl.dest = d;
      $("#dl-dest").textContent = d;
      $("#dl-dest").title = d;
    }
  });
  $("#btn-dest-open").addEventListener("click", () =>
    api("open_path", S.dl.dest));
  $("#btn-queue-open").addEventListener("click", () =>
    api("open_path", S.dl.dest));
  $("#btn-queue-clear").addEventListener("click", () => {
    S.dl.queue = S.dl.queue.filter(
      (q) => q.status === "pending" || q.status === "running");
    qRender();
  });

  $("#btn-dl").addEventListener("click", () => {
    const url = $("#dl-url").value.trim();
    if (!url) return toast("Colle d'abord un lien.", "err");
    const known = S.dl.lastInfo && S.dl.lastInfo.url === url
      ? S.dl.lastInfo : null;
    const sec = S.dl.sec;
    const useSec = known && sec.on && sec.dur > 0
      && !$("#dl-playlist").checked && (sec.a > 0 || sec.b < sec.dur);
    S.dl.queue.push({
      id: ++qSeq, url, status: "pending",
      title: known ? known.title : null,
      thumb: known ? known.thumb : null,
      opts: {
        mode: S.dl.mode,
        quality: S.dl.quality,
        format: S.dl.mode === "video" ? S.dl.vformat : S.dl.aformat,
        playlist: $("#dl-playlist").checked,
        section: useSec ? { start: sec.a, end: sec.b } : undefined,
      },
    });
    $("#dl-url").value = "";
    qRender();
    qPump();
  });
  $("#btn-dl-cancel").addEventListener("click", () => {
    api("cancel", "download");
    toast("Annulation du téléchargement en cours…");
  });
}

function onDlEvent(e) {
  const cur = S.dl.current;
  if (e.type === "dl_progress") {
    if (!cur) return;
    const row = qRows.get(cur.id);
    if (!row) return;
    const bar = row.querySelector(".fbar");
    bar.classList.remove("hidden");
    if (e.phase === "processing") {
      bar.classList.add("indet");
      row.querySelector(".qstats").textContent = " · fusion / conversion…";
      return;
    }
    bar.classList.remove("indet");
    if (e.pct != null)
      bar.querySelector("i").style.width = (e.pct * 100).toFixed(1) + "%";
    const bits = [];
    if (e.pct != null) bits.push((e.pct * 100).toFixed(0) + " %");
    if (e.speed) bits.push(e.speed);
    if (e.eta != null) bits.push("reste " + fmtEta(e.eta));
    if (e.item && e.item_count) bits.push(`vidéo ${e.item}/${e.item_count}`);
    row.querySelector(".qstats").textContent =
      bits.length ? " · " + bits.join(" · ") : "";
  } else if (e.type === "dl_done") {
    if (cur) {
      cur.status = e.ok ? "done" : e.cancelled ? "cancelled" : "error";
      if (e.ok && e.title) cur.title = e.title;
      cur.error = e.error;
    }
    S.dl.current = null;
    qRender();
    const b = S.dl.batch;
    if (b) {
      if (e.ok) { b.ok++; b.title = e.title || b.title; }
      else if (!e.cancelled) b.err++;
    }
    if (e.ok) toast("Téléchargement terminé", "ok");
    else if (e.cancelled) toast("Téléchargement annulé.");
    else toast("Erreur : " + e.error, "err", 8000);
    if (e.history) {
      H.items.unshift(e.history);
      histRender();
    }
    qPump();
    if (!S.dl.current && b) {  // file videe : bilan du lot
      S.dl.batch = null;
      if (b.ok || b.err)
        notifyIfLong(b.t0,
          b.err ? "Téléchargements terminés, avec des erreurs"
                : "Téléchargement terminé",
          b.ok === 1 && !b.err ? b.title
            : `${b.ok} réussi(s)${b.err ? `, ${b.err} en erreur` : ""}`);
    }
  }
}

/* ---------------- telechargeur : historique ---------------- */

const H = { items: [], shown: 20 };

function fmtDate(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `aujourd'hui ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `hier ${hm}`;
  return d.toLocaleDateString("fr-FR");
}

const ICO_AGAIN = `<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"
  fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
  stroke-linejoin="round"/></svg>`;

function histRender() {
  const box = $("#dl-hitems");
  box.innerHTML = "";
  $("#dl-history").classList.toggle("hidden", !H.items.length);
  $("#dl-empty").classList.toggle("compact", H.items.length > 0);

  H.items.slice(0, H.shown).forEach((it) => {
    const row = document.createElement("div");
    row.className = "frow hrow" + (it.exists ? "" : " gone");
    row.innerHTML = `
      <div class="fico">${siteInitials(it.url)}</div>
      <div class="fmain">
        <div class="fname"></div>
        <div class="fsub"></div>
      </div>
      <div class="fstate">
        <button class="btn sm" data-act="reveal">Voir</button>
        <button class="btn sm icon-sm" data-act="again"
                title="Recoller le lien pour le retélécharger">${ICO_AGAIN}</button>
      </div>
      <button class="fdel" title="Retirer de l'historique">✕</button>`;
    if (it.thumb) {  // miniature en ligne ; initiales du site si elle echoue
      const ico = row.querySelector(".fico");
      const img = document.createElement("img");
      img.className = "qthumb";
      img.alt = "";
      img.onerror = () => img.replaceWith(ico);
      ico.replaceWith(img);
      img.src = it.thumb;
    }
    row.querySelector(".fname").textContent = it.title || shortName(it.url);
    row.querySelector(".fsub").textContent =
      `${fmtDate(it.ts)} · ${optsSummary(it)}`
      + (it.exists ? "" : " · fichier déplacé ou supprimé");
    const reveal = row.querySelector('[data-act="reveal"]');
    reveal.disabled = !it.exists;
    reveal.addEventListener("click", () => api("reveal_file", it.files[0]));
    row.querySelector('[data-act="again"]').addEventListener("click", () => {
      $("#dl-url").value = it.url;
      $("#dl-url").focus();
      toast("Lien recollé — clique Télécharger (ou Entrée pour l'analyser).");
    });
    row.addEventListener("dblclick", (ev) => {
      if (!ev.target.closest("button") && it.exists)
        api("open_path", it.files[0]);
    });
    row.querySelector(".fdel").addEventListener("click", () => {
      api("history_remove", it.id);
      H.items = H.items.filter((x) => x.id !== it.id);
      histRender();
    });
    box.appendChild(row);
  });
  $("#btn-hist-more").classList.toggle("hidden", H.items.length <= H.shown);
}

function wireHistory() {
  $("#btn-hist-more").addEventListener("click", () => {
    H.shown += 30;
    histRender();
  });
  let armed = null;  // double clic de confirmation
  $("#btn-hist-clear").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (!armed) {
      b.textContent = "Confirmer ?";
      armed = setTimeout(() => { armed = null; b.textContent = "Tout effacer"; }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    b.textContent = "Tout effacer";
    api("history_clear");
    H.items = [];
    histRender();
  });
  api("history_list").then((items) => {
    H.items = items || [];
    histRender();
  });
}

/* ---------------- slider debut / fin (passage) ---------------- */

function secReset(dur) {
  const s = S.dl.sec;
  s.dur = dur;
  s.a = 0;
  s.b = dur;
  s.on = false;
  $("#dl-sec-on").checked = false;
  $("#dl-sec-ui").classList.add("hidden");
  secRender();
}

function secRender() {
  const s = S.dl.sec;
  if (!s.dur) return;
  const pa = (s.a / s.dur) * 100, pb = (s.b / s.dur) * 100;
  $("#rs-a").style.left = pa + "%";
  $("#rs-b").style.left = pb + "%";
  const fill = $("#rs-fill");
  fill.style.left = pa + "%";
  fill.style.width = (pb - pa) + "%";
  $("#rs-start").textContent = fmtTime(s.a);
  $("#rs-end").textContent = fmtTime(s.b);
  $("#rs-len").textContent = "passage : " + fmtTime(s.b - s.a);
}

function wireSection() {
  $("#dl-sec-on").addEventListener("change", (e) => {
    S.dl.sec.on = e.target.checked;
    $("#dl-sec-ui").classList.toggle("hidden", !e.target.checked);
    secRender();
  });

  const slider = $("#rs");
  let grab = null; // "a" | "b"

  function valueAt(clientX) {
    const r = slider.getBoundingClientRect();
    const p = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    return Math.round(p * S.dl.sec.dur);
  }

  function move(e) {
    if (!grab) return;
    const s = S.dl.sec;
    const v = valueAt(e.clientX);
    if (grab === "a") s.a = Math.max(0, Math.min(v, s.b - 1));
    else s.b = Math.min(s.dur, Math.max(v, s.a + 1));
    secRender();
  }

  slider.addEventListener("pointerdown", (e) => {
    const s = S.dl.sec;
    if (!s.dur) return;
    const v = valueAt(e.clientX);
    grab = Math.abs(v - s.a) <= Math.abs(v - s.b) ? "a" : "b";
    slider.setPointerCapture(e.pointerId);
    move(e);
  });
  slider.addEventListener("pointermove", move);
  slider.addEventListener("pointerup", () => { grab = null; });
  slider.addEventListener("pointercancel", () => { grab = null; });
}

/* ---------------- compresseur ---------------- */

function cpRows() {
  const box = $("#cp-files");
  box.innerHTML = "";
  $("#cp-empty").classList.toggle("hidden", S.cp.files.length > 0);
  S.cp.files.forEach((f, i) => {
    const ext = f.name.split(".").pop().toUpperCase().slice(0, 4);
    const row = document.createElement("div");
    row.className = "frow";
    row.innerHTML = `
      <div class="fico">${ext}</div>
      <div class="fmain">
        <div class="fname"></div>
        <div class="fsub">${f.size}<span class="qstats"></span></div>
        <div class="bar fbar hidden"><i></i></div>
      </div>
      <div class="fstate"></div>
      <button class="fdel" title="Retirer">✕</button>`;
    row.querySelector(".fname").textContent = f.name;
    box.appendChild(row);
    row.querySelector(".fdel").addEventListener("click", () => {
      if (S.cp.running) return;
      S.cp.files.splice(i, 1);
      cpRows();
    });
  });
}

function cpTarget() {
  const custom = parseFloat($("#cp-custom").value);
  return custom > 0 ? custom : S.cp.target;
}

async function cpAddPaths(paths) {
  if (S.cp.running) return;
  const infos = await api("file_infos", paths);
  if (!infos) return;
  const good = infos.filter(
    (f) => f.category === "video" || f.category === "image");
  if (good.length !== infos.length)
    toast("Vidéos et images seulement ici — le reste est ignoré.");
  const known = new Set(S.cp.files.map((f) => f.path));
  S.cp.files.push(...good.filter((f) => !known.has(f.path)));
  $("#cp-done").classList.add("hidden");
  cpRows();
}

function wireCompressor() {
  wireDrop($("#cp-drop"), "any", cpAddPaths);

  wirePills("#cp-targets", (v) => {
    S.cp.target = +v;
    $("#cp-custom").value = "";
  });
  $("#cp-custom").addEventListener("input", () => {
    if ($("#cp-custom").value)
      $$("#cp-targets button").forEach((b) => b.classList.remove("on"));
  });

  $("#btn-cp").addEventListener("click", async () => {
    if (!S.cp.files.length)
      return toast("Ajoute d'abord des vidéos.", "err");
    const target = cpTarget();
    if (!(target > 0))
      return toast("Choisis une taille cible valide.", "err");
    S.cp.running = true;
    S.cp.t0 = Date.now();
    $("#btn-cp").disabled = true;
    $("#btn-cp-cancel").classList.remove("hidden");
    $("#cp-done").classList.add("hidden");
    const ok = await api("start_compress", {
      files: S.cp.files.map((f) => f.path),
      target_mb: target,
    });
    if (!ok) stopRunning(S.cp, "#btn-cp", "#btn-cp-cancel");
  });
  $("#btn-cp-cancel").addEventListener("click", () => {
    api("cancel", "compress");
    toast("Annulation…");
  });
}

function onCpEvent(e) {
  const rows = $$("#cp-files .frow");
  if (e.type === "cp_progress" && rows[e.index]) {
    const row = rows[e.index];
    const bar = row.querySelector(".fbar");
    bar.classList.remove("hidden");
    bar.querySelector("i").style.width = (e.pct * 100).toFixed(0) + "%";
    row.querySelector(".qstats").textContent =
      e.img ? " · optimisation…"
            : (e.pct < 0.5 ? " · passe 1 — analyse"
                           : " · passe 2 — encodage");
    row.querySelector(".fstate").innerHTML =
      `${(e.pct * 100).toFixed(0)} %`;
  } else if (e.type === "cp_file_done" && rows[e.index]) {
    const row = rows[e.index];
    row.querySelector(".fbar").classList.add("hidden");
    row.querySelector(".qstats").textContent =
      e.ok ? ` · ${e.orig} → ${e.size}` : "";
    const st = row.querySelector(".fstate");
    if (e.ok) {
      st.innerHTML = `<span class="st-ok">✓</span>
        <button class="btn sm" data-reveal="${e.out.replaceAll('"', "&quot;")}">Voir</button>`;
      st.querySelector("[data-reveal]").addEventListener("click", (ev) =>
        api("reveal_file", ev.target.dataset.reveal));
    } else {
      st.innerHTML = `<span class="st-err" title="${e.error || ""}">✕</span>`;
      if (e.error) toast(e.error, "err", 7000);
    }
  } else if (e.type === "cp_done") {
    stopRunning(S.cp, "#btn-cp", "#btn-cp-cancel");
    if (e.cancelled) return toast("Compression annulée.");
    if (e.error) toast("Erreur : " + e.error, "err", 9000);
    $("#cp-done").classList.remove("hidden");
    $("#cp-done-txt").textContent =
      `${e.ok}/${e.total} fichier(s) compressé(s)`;
    toast(e.ok === e.total ? "Compression terminée"
                           : "Terminé, avec des erreurs",
          e.ok === e.total ? "ok" : "err");
    notifyIfLong(S.cp.t0, "Compression terminée",
                 `${e.ok}/${e.total} fichier(s) compressé(s)`);
  }
}

/* ---------------- upscaler ---------------- */

function renderModels(st) {
  const avail = Object.fromEntries(
    (st.models || []).map((m) => [m.key, m.available]));
  const box = $("#up-models");
  box.innerHTML = "";
  let missingPack = false;
  for (const [key, name, desc, isUpscayl] of MODEL_META) {
    if (isUpscayl && !avail[key]) { missingPack = true; continue; }
    const b = document.createElement("button");
    b.className = "model";
    b.dataset.v = key;
    b.innerHTML = `
      <span class="mname">${name}
        ${isUpscayl ? `<span class="tag">Upscayl</span>` : ""}</span>
      <span class="mdesc">${desc}</span>`;
    if (!avail[key]) b.disabled = true;
    box.appendChild(b);
  }
  $("#up-pack-install").classList.toggle("hidden", !missingPack);

  if (!S.up.model || !avail[S.up.model]) {
    S.up.model = avail.standard ? "standard"
               : avail.photo ? "photo" : (st.models || [])[0]?.key;
  }
  box.querySelectorAll(".model").forEach((b) =>
    b.classList.toggle("on", b.dataset.v === S.up.model));

  box.onclick = (e) => {
    const btn = e.target.closest(".model");
    if (!btn || btn.disabled) return;
    box.querySelectorAll(".model").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    S.up.model = btn.dataset.v;
  };
}

function upChips() {
  const box = $("#up-files");
  box.innerHTML = "";
  S.up.files.forEach((f, i) => {
    const c = document.createElement("div");
    c.className = "fchip" + (S.up.sel === f.path ? " sel" : "");
    c.innerHTML = `
      <img alt="">
      <div class="fmeta">
        <div class="fname">${f.name}</div>
        <div class="fsub">${f.size}${f.dims ? " · " + f.dims : ""}</div>
      </div>
      <span class="fstate"></span>
      <button class="fdel" title="Retirer">✕</button>
      <div class="fprog"></div>`;
    box.appendChild(c);
    api("thumb", f.path).then((src) => {
      if (src) c.querySelector("img").src = src;
    });
    if (S.up.results[f.path])
      c.querySelector(".fstate").innerHTML = `<span class="st-ok">✓</span>`;
    c.addEventListener("click", (e) => {
      if (e.target.closest(".fdel")) return;
      upSelect(f.path);
    });
    c.querySelector(".fdel").addEventListener("click", () => {
      if (S.up.running) return;
      S.up.files.splice(i, 1);
      delete S.up.results[f.path];
      if (S.up.sel === f.path) S.up.sel = S.up.files[0]?.path || null;
      upChips();
      upStage();
    });
  });
}

async function upSelect(path) {
  S.up.sel = path;
  $$("#up-files .fchip").forEach((c, i) =>
    c.classList.toggle("sel", S.up.files[i]?.path === path));
  await upStage();
}

async function upStage() {
  const empty = $("#up-empty"), img = $("#up-preview"), cmp = $("#cmp");
  const bar = $("#up-stagebar");
  const f = S.up.files.find((x) => x.path === S.up.sel);
  if (!f) {
    empty.classList.remove("hidden");
    img.classList.add("hidden");
    cmp.classList.add("hidden");
    bar.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  bar.classList.remove("hidden");
  $("#up-stage-name").textContent = f.name;

  const out = S.up.results[f.path];
  if (out) {
    const [before, after] = await Promise.all([preview(f.path), preview(out)]);
    $("#cmp-before").src = before || "";
    $("#cmp-after").src = after || "";
    cmp.classList.remove("hidden");
    img.classList.add("hidden");
    const dims = f.dims ? ` — ${f.dims} → ${scaleDims(f.dims, S.up.scaleUsed)}` : "";
    $("#up-stage-dims").textContent = `x${S.up.scaleUsed}${dims}`;
  } else {
    img.src = (await preview(f.path)) || "";
    img.classList.remove("hidden");
    cmp.classList.add("hidden");
    $("#up-stage-dims").textContent = f.dims || "";
  }
}

function scaleDims(dims, k) {
  const m = dims.match(/(\d+)\s*[×x]\s*(\d+)/);
  return m ? `${m[1] * k}×${m[2] * k}` : "";
}

async function upAddPaths(paths) {
  if (S.up.running) return;
  const infos = await api("file_infos", paths);
  if (!infos) return;
  const imgs = infos.filter((f) => f.category === "image");
  if (imgs.length !== infos.length)
    toast("Certains fichiers ne sont pas des images — ignorés.");
  const known = new Set(S.up.files.map((f) => f.path));
  S.up.files.push(...imgs.filter((f) => !known.has(f.path)));
  if (!S.up.sel && S.up.files.length) S.up.sel = S.up.files[0].path;
  upChips();
  upStage();
}

function wireUpscaler() {
  wireDrop($("#up-drop"), "images", upAddPaths);

  wirePills("#pills-scale", (v) => (S.up.scale = +v));
  wirePills("#pills-upformat", (v) => (S.up.format = v));

  $("#btn-pack").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Téléchargement… 0 %";
    await api("install_tool", "upscayl_models");
  });

  $("#btn-up").addEventListener("click", async () => {
    if (!S.up.files.length)
      return toast("Ajoute d'abord des images.", "err");
    S.up.running = true;
    S.up.t0 = Date.now();
    S.up.scaleUsed = S.up.scale;
    $("#btn-up").disabled = true;
    $("#btn-up-cancel").classList.remove("hidden");
    const ok = await api("start_upscale", {
      files: S.up.files.map((f) => f.path),
      model: S.up.model,
      scale: S.up.scale,
      out_format: S.up.format,
    });
    if (!ok) stopRunning(S.up, "#btn-up", "#btn-up-cancel");
  });
  $("#btn-up-cancel").addEventListener("click", () => {
    api("cancel", "upscale");
    toast("Annulation…");
  });

  wireCmpDrag($("#cmp"));
}

/* comparateur avant / apres : glisser pour deplacer la ligne */
function wireCmpDrag(cmp) {
  function track(e) {
    const r = cmp.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - r.left) / r.width, 0.02), 0.98);
    cmp.style.setProperty("--x", (x * 100).toFixed(2) + "%");
  }
  cmp.addEventListener("pointerdown", (e) => {
    cmp.setPointerCapture(e.pointerId);
    track(e);
    const move = (ev) => track(ev);
    const upH = () => {
      cmp.removeEventListener("pointermove", move);
      cmp.removeEventListener("pointerup", upH);
    };
    cmp.addEventListener("pointermove", move);
    cmp.addEventListener("pointerup", upH);
  });
}

function onUpEvent(e) {
  const chips = $$("#up-files .fchip");
  if (e.type === "up_progress" && chips[e.index]) {
    chips[e.index].querySelector(".fprog").style.width =
      (e.pct * 100).toFixed(0) + "%";
    chips[e.index].querySelector(".fstate").innerHTML =
      e.pct >= 1 ? `<span class="spin"></span>`
                 : `${(e.pct * 100).toFixed(0)}%`;
  } else if (e.type === "up_file_done" && chips[e.index]) {
    const f = S.up.files[e.index];
    chips[e.index].querySelector(".fprog").style.width = "0";
    if (e.ok) {
      chips[e.index].querySelector(".fstate").innerHTML =
        `<span class="st-ok">✓</span>`;
      if (f) {
        S.up.results[f.path] = e.out;
        previewCache.delete(e.out);
        if (S.up.sel === f.path) upStage();
      }
    } else {
      chips[e.index].querySelector(".fstate").innerHTML =
        `<span class="st-err" title="${e.error || ""}">✕</span>`;
      if (e.error) toast(e.error, "err", 7000);
    }
  } else if (e.type === "up_done") {
    stopRunning(S.up, "#btn-up", "#btn-up-cancel");
    if (e.cancelled) return toast("Upscale annulé.");
    if (e.error) toast("Erreur : " + e.error, "err", 9000);
    toast(`${e.ok}/${e.total} image(s) agrandie(s) — glisse le curseur pour comparer`,
          e.ok === e.total ? "ok" : "err", 6000);
    notifyIfLong(S.up.t0, "Upscale terminé",
                 `${e.ok}/${e.total} image(s) agrandie(s)`);
    const firstOk = S.up.files.find((f) => S.up.results[f.path]);
    if (firstOk && !S.up.results[S.up.sel]) upSelect(firstOk.path);
    if (firstOk) api("reveal_file", S.up.results[firstOk.path]);
  }
}

/* ---------------- detourage ---------------- */

async function bgAddPaths(paths) {
  if (S.bg.running) return;
  const infos = await api("file_infos", paths);
  if (!infos) return;
  const imgs = infos.filter((f) => f.category === "image");
  if (imgs.length !== infos.length)
    toast("Certains fichiers ne sont pas des images — ignorés.");
  const known = new Set(S.bg.files.map((f) => f.path));
  S.bg.files.push(...imgs.filter((f) => !known.has(f.path)));
  if (!S.bg.sel && S.bg.files.length) S.bg.sel = S.bg.files[0].path;
  bgChips();
  bgStage();
}

function bgChips() {
  const box = $("#bg-files");
  box.innerHTML = "";
  S.bg.files.forEach((f, i) => {
    const c = document.createElement("div");
    c.className = "fchip" + (S.bg.sel === f.path ? " sel" : "");
    c.innerHTML = `
      <img alt="">
      <div class="fmeta">
        <div class="fname"></div>
        <div class="fsub">${f.size}${f.dims ? " · " + f.dims : ""}</div>
      </div>
      <span class="fstate"></span>
      <button class="fdel" title="Retirer">✕</button>
      <div class="fprog"></div>`;
    c.querySelector(".fname").textContent = f.name;
    box.appendChild(c);
    api("thumb", f.path).then((src) => {
      if (src) c.querySelector("img").src = src;
    });
    if (S.bg.results[f.path])
      c.querySelector(".fstate").innerHTML = `<span class="st-ok">✓</span>`;
    c.addEventListener("click", (e) => {
      if (e.target.closest(".fdel")) return;
      bgSelect(f.path);
    });
    c.querySelector(".fdel").addEventListener("click", () => {
      if (S.bg.running) return;
      S.bg.files.splice(i, 1);
      delete S.bg.results[f.path];
      if (S.bg.sel === f.path) S.bg.sel = S.bg.files[0]?.path || null;
      bgChips();
      bgStage();
    });
  });
}

async function bgSelect(path) {
  S.bg.sel = path;
  $$("#bg-files .fchip").forEach((c, i) =>
    c.classList.toggle("sel", S.bg.files[i]?.path === path));
  await bgStage();
}

async function bgStage() {
  const empty = $("#bg-empty"), img = $("#bg-preview"), cmp = $("#bg-cmp");
  const bar = $("#bg-stagebar");
  const f = S.bg.files.find((x) => x.path === S.bg.sel);
  if (!f) {
    empty.classList.remove("hidden");
    img.classList.add("hidden");
    cmp.classList.add("hidden");
    bar.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  bar.classList.remove("hidden");
  $("#bg-stage-name").textContent = f.name;

  const out = S.bg.results[f.path];
  if (out) {
    const [before, after] = await Promise.all(
      [preview(f.path), api("preview_png", out)]);
    $("#bg-cmp-before").src = before || "";
    $("#bg-cmp-after").src = after || "";
    cmp.classList.remove("hidden");
    img.classList.add("hidden");
    $("#bg-stage-info").textContent = "PNG transparent · à côté de l'originale";
  } else {
    img.src = (await preview(f.path)) || "";
    img.classList.remove("hidden");
    cmp.classList.add("hidden");
    $("#bg-stage-info").textContent = f.dims || "";
  }
}

function wireCutout() {
  wireDrop($("#bg-drop"), "images", bgAddPaths);

  $("#bg-models").addEventListener("click", (e) => {
    const btn = e.target.closest(".model");
    if (!btn) return;
    $$("#bg-models .model").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    S.bg.model = btn.dataset.v;
  });

  $("#btn-bg").addEventListener("click", async () => {
    if (!S.bg.files.length)
      return toast("Ajoute d'abord des images.", "err");
    S.bg.running = true;
    S.bg.t0 = Date.now();
    $("#btn-bg").disabled = true;
    $("#btn-bg-cancel").classList.remove("hidden");
    const ok = await api("start_cutout", {
      files: S.bg.files.map((f) => f.path),
      model: S.bg.model,
    });
    if (!ok) stopRunning(S.bg, "#btn-bg", "#btn-bg-cancel");
  });
  $("#btn-bg-cancel").addEventListener("click", () => {
    api("cancel", "cutout");
    toast("Annulation après l'image en cours…");
  });

  wireCmpDrag($("#bg-cmp"));
}

let bgModelToastShown = false;

function onBgEvent(e) {
  const chips = $$("#bg-files .fchip");
  if (e.type === "bg_progress" && chips[e.index]) {
    const chip = chips[e.index];
    if (e.phase === "model") {
      // premier usage du modele : vrai pourcentage de telechargement
      chip.querySelector(".fstate").innerHTML = e.pct != null
        ? `${(e.pct * 100).toFixed(0)}%` : `<span class="spin"></span>`;
      chip.querySelector(".fprog").style.width =
        e.pct != null ? (e.pct * 100).toFixed(1) + "%" : "0";
      if (!bgModelToastShown) {
        bgModelToastShown = true;
        toast("Première utilisation de ce modèle : téléchargement en cours " +
              "(une seule fois), ça peut prendre quelques minutes.", "info",
              9000);
      }
    } else {
      chip.querySelector(".fprog").style.width = "0";
      chip.querySelector(".fstate").innerHTML = `<span class="spin"></span>`;
    }
  } else if (e.type === "bg_file_done" && chips[e.index]) {
    const f = S.bg.files[e.index];
    if (e.ok) {
      chips[e.index].querySelector(".fstate").innerHTML =
        `<span class="st-ok">✓</span>`;
      if (f) {
        S.bg.results[f.path] = e.out;
        if (S.bg.sel === f.path) bgStage();
      }
    } else {
      chips[e.index].querySelector(".fstate").innerHTML =
        `<span class="st-err" title="${e.error || ""}">✕</span>`;
      if (e.error) toast(e.error, "err", 7000);
    }
  } else if (e.type === "bg_done") {
    stopRunning(S.bg, "#btn-bg", "#btn-bg-cancel");
    if (e.cancelled) return toast("Détourage annulé.");
    if (e.error) toast("Erreur : " + e.error, "err", 9000);
    toast(`${e.ok}/${e.total} image(s) détourée(s) — glisse le curseur pour comparer`,
          e.ok === e.total ? "ok" : "err", 6000);
    notifyIfLong(S.bg.t0, "Détourage terminé",
                 `${e.ok}/${e.total} image(s) détourée(s)`);
    const firstOk = S.bg.files.find((f) => S.bg.results[f.path]);
    if (firstOk && !S.bg.results[S.bg.sel]) bgSelect(firstOk.path);
    if (firstOk) api("reveal_file", S.bg.results[firstOk.path]);
  }
}

/* ---------------- convertisseur ---------------- */

const CAT_LABELS = { image: "Images", audio: "Audio", video: "Vidéo" };

function cvRows() {
  const box = $("#cv-files");
  box.innerHTML = "";
  $("#cv-empty").classList.toggle("hidden", S.cv.files.length > 0);
  S.cv.files.forEach((f, i) => {
    const ext = f.name.split(".").pop().toUpperCase().slice(0, 4);
    const row = document.createElement("div");
    row.className = "frow";
    row.innerHTML = `
      <div class="fico">${ext}</div>
      <div class="fmain">
        <div class="fname">${f.name}</div>
        <div class="fsub">${f.size}</div>
        <div class="bar fbar hidden"><i></i></div>
      </div>
      <div class="fstate"></div>
      <button class="fdel" title="Retirer">✕</button>`;
    box.appendChild(row);
    row.querySelector(".fdel").addEventListener("click", () => {
      if (S.cv.running) return;
      S.cv.files.splice(i, 1);
      cvRows();
      cvTargets();
    });
  });
}

async function cvTargets() {
  const box = $("#cv-targets");
  const badge = $("#cv-cat");
  if (!S.cv.files.length) {
    box.innerHTML = `<span class="pills-empty">ajoute d'abord des fichiers</span>`;
    badge.classList.add("hidden");
    S.cv.target = null;
    return;
  }
  const res = await api("detect_targets", S.cv.files.map((f) => f.path));
  if (!res) return;
  if (!res.category) {
    box.innerHTML = `<span class="pills-empty">mélange de types — garde un seul type à la fois</span>`;
    badge.classList.add("hidden");
    S.cv.target = null;
    return;
  }
  badge.textContent = CAT_LABELS[res.category];
  badge.classList.remove("hidden");
  S.cv.target = res.targets[0];
  box.innerHTML = res.targets
    .map((t, i) =>
      `<button data-v="${t}" class="${i === 0 ? "on" : ""}">
         ${t === "mp3" && res.category === "video" ? "MP3 (audio)" : t.toUpperCase()}
       </button>`)
    .join("");
}

async function cvAddPaths(paths) {
  if (S.cv.running) return;
  const infos = await api("file_infos", paths);
  if (!infos) return;
  const valid = infos.filter((f) => f.category);
  if (valid.length !== infos.length)
    toast("Certains fichiers ont un format non géré — ignorés.");
  const known = new Set(S.cv.files.map((f) => f.path));
  S.cv.files.push(...valid.filter((f) => !known.has(f.path)));
  $("#cv-done").classList.add("hidden");
  cvRows();
  cvTargets();
}

function wireConverter() {
  wireDrop($("#cv-drop"), "any", cvAddPaths);

  wirePills("#cv-targets", (v) => (S.cv.target = v));

  $("#btn-cv").addEventListener("click", async () => {
    if (!S.cv.files.length)
      return toast("Ajoute d'abord des fichiers.", "err");
    if (!S.cv.target)
      return toast("Choisis un format de sortie.", "err");
    S.cv.running = true;
    S.cv.t0 = Date.now();
    $("#btn-cv").disabled = true;
    $("#btn-cv-cancel").classList.remove("hidden");
    $("#cv-done").classList.add("hidden");
    const ok = await api("start_convert", {
      files: S.cv.files.map((f) => f.path),
      target: S.cv.target,
    });
    if (!ok) stopRunning(S.cv, "#btn-cv", "#btn-cv-cancel");
  });
  $("#btn-cv-cancel").addEventListener("click", () => {
    api("cancel", "convert");
    toast("Annulation…");
  });
}

function onCvEvent(e) {
  const rows = $$("#cv-files .frow");
  if (e.type === "cv_progress" && rows[e.index]) {
    const bar = rows[e.index].querySelector(".fbar");
    bar.classList.remove("hidden");
    bar.querySelector("i").style.width = (e.pct * 100).toFixed(0) + "%";
    rows[e.index].querySelector(".fstate").innerHTML =
      e.pct >= 1 ? `<span class="spin"></span>`
                 : `${(e.pct * 100).toFixed(0)} %`;
  } else if (e.type === "cv_file_done" && rows[e.index]) {
    rows[e.index].querySelector(".fbar").classList.add("hidden");
    const st = rows[e.index].querySelector(".fstate");
    if (e.ok) {
      st.innerHTML = `<span class="st-ok">✓</span>
        <button class="btn sm" data-reveal="${e.out.replaceAll('"', "&quot;")}">Voir</button>`;
      st.querySelector("[data-reveal]").addEventListener("click", (ev) =>
        api("reveal_file", ev.target.dataset.reveal));
    } else {
      st.innerHTML = `<span class="st-err" title="${e.error || ""}">✕</span>`;
      if (e.error) toast(e.error, "err", 7000);
    }
  } else if (e.type === "cv_done") {
    stopRunning(S.cv, "#btn-cv", "#btn-cv-cancel");
    if (e.cancelled) return toast("Conversion annulée.");
    if (e.error) toast("Erreur : " + e.error, "err", 9000);
    $("#cv-done").classList.remove("hidden");
    $("#cv-done-txt").textContent =
      `${e.ok}/${e.total} fichier(s) converti(s)`;
    toast(e.ok === e.total ? "Conversion terminée" : "Terminé, avec des erreurs",
          e.ok === e.total ? "ok" : "err");
    notifyIfLong(S.cv.t0, "Conversion terminée",
                 `${e.ok}/${e.total} fichier(s) converti(s)`);
  }
}

/* ---------------- mises a jour de Mudkit ---------------- */

const U = { info: null, dev: false };

function updRender(state, extra = {}) {
  const desc = $("#upd-desc"), box = $("#upd-state"), notes = $("#upd-notes");
  box.innerHTML = "";
  notes.classList.add("hidden");
  $("#upd-pill").classList.toggle("hidden",
    !(state === "available" || state === "ready"));
  const btn = (label, primary, fn) => {
    const b = document.createElement("button");
    b.className = "btn sm" + (primary ? " primary" : "");
    b.textContent = label;
    b.addEventListener("click", fn);
    box.appendChild(b);
  };
  const i = U.info;
  if (state === "dev") {
    desc.textContent = "Version de développement — mises à jour via git.";
  } else if (state === "checking") {
    desc.textContent = "Recherche de mises à jour…";
    box.innerHTML = `<span class="spin"></span>`;
  } else if (state === "error") {
    desc.textContent = "Vérification impossible (hors ligne ?).";
    btn("Réessayer", false, () => checkUpdate(true));
  } else if (state === "uptodate") {
    desc.textContent = "Tu as la dernière version.";
    box.innerHTML = `<span class="chip">à jour</span>`;
    btn("Vérifier", false, () => checkUpdate(true));
  } else if (state === "available") {
    desc.textContent = i.full_only
      ? `Version ${i.latest} disponible — elle demande le nouvel installateur.`
      : `Version ${i.latest} disponible.`;
    if (i.full_only)
      btn("Télécharger l'installateur", true, () => api("open_url", i.page));
    else btn("Mettre à jour", true, startUpdate);
    if (i.notes) {
      notes.textContent = i.notes;
      notes.classList.remove("hidden");
    }
  } else if (state === "downloading") {
    desc.textContent = `Téléchargement de la version ${i.latest}…`;
    box.textContent = extra.pct != null
      ? `${(extra.pct * 100).toFixed(0)} %` : "…";
  } else if (state === "ready") {
    desc.textContent = `Version ${extra.version} installée`
      + (extra.premiere ? " — redémarre aussi Premiere Pro pour le panneau."
                        : ".");
    btn("Redémarrer Mudkit", true, () => api("update_restart"));
  }
}

async function checkUpdate(manual = false) {
  if (U.dev) return updRender("dev");
  updRender("checking");
  const r = await api("update_check");
  if (!r || r.error) return updRender("error");
  if (r.dev) {
    U.dev = true;
    return updRender("dev");
  }
  U.info = r;
  if (!r.available) return updRender("uptodate");
  updRender("available");
  if (!manual)
    toast(`Mudkit ${r.latest} est disponible.`, "info", 9000,
          { label: "Voir", run: () => go("set") });
}

async function startUpdate() {
  updRender("downloading");
  if (!(await api("update_start"))) updRender("available");
}

function onUpdEvent(e) {
  if (e.type === "upd_progress") return updRender("downloading", e);
  if (e.ok) {
    updRender("ready", e);
    return toast(`Mudkit ${e.version} est installé — redémarre pour l'utiliser.`,
                 "ok", 9000, { label: "Redémarrer", run: () => api("update_restart") });
  }
  if (e.full_only) {
    U.info.full_only = true;
    U.info.page = e.page || U.info.page;
  } else {
    toast("Mise à jour impossible : " + (e.error || "erreur inconnue"), "err", 9000);
  }
  updRender("available");
}

function wireSettings(st) {
  U.dev = !!st.dev;
  $("#upd-cur").textContent = "v" + st.version;
  $("#upd-pill").addEventListener("click", () => go("set"));
  $("#btn-report").addEventListener("click", () => copyReport("rapport manuel"));
  $("#btn-logs").addEventListener("click", () => api("open_logs"));
  if (U.dev) updRender("dev");
  else setTimeout(() => checkUpdate(false), 2500);
}

/* ---------------- evenements Python ---------------- */

window.mudkitEvent = (e) => {
  if (e.type === "dropped") {
    const route = DROP_ROUTES[e.zone];
    if (route && e.paths && e.paths.length) route(e.paths);
    return;
  }
  if (e.type.startsWith("dl_")) return onDlEvent(e);
  if (e.type.startsWith("up_")) return onUpEvent(e);
  if (e.type.startsWith("cv_")) return onCvEvent(e);
  if (e.type.startsWith("cp_")) return onCpEvent(e);
  if (e.type.startsWith("bg_")) return onBgEvent(e);
  if (e.type.startsWith("upd_")) return onUpdEvent(e);

  if (e.type === "install") {
    const pct = e.pct != null ? `${(e.pct * 100).toFixed(0)} %` : (e.done || "…");
    const b = $(`[data-install="${e.name}"]`);
    if (b) b.textContent = pct;
    if (e.name === "upscayl_models")
      $("#btn-pack").textContent = `Téléchargement… ${pct}`;
  } else if (e.type === "install_done") {
    toast(e.ok ? `Installation terminée` : `Échec : ${e.error}`,
          e.ok ? "ok" : "err", e.ok ? 4000 : 8000);
    api("ui_ready").then((st) => {
      if (!st) return;
      renderEngines(st);
      renderModels(st);
      if (e.name === "upscayl_models" && e.ok) {
        const b = $("#btn-pack");
        b.disabled = false;
        b.textContent = "Installer les modèles Upscayl (~110 Mo)";
      }
    });
  } else if (e.type === "ytdlp_updated") {
    toast(e.ok ? `yt-dlp à jour (${e.version}) — effectif au prochain lancement`
               : "Échec de la mise à jour de yt-dlp", e.ok ? "ok" : "err", 7000);
    api("ui_ready").then((st) => st && renderEngines(st));
  }
};

/* ---------------- simulation (preview navigateur) ---------------- */

function mockImage(sharp) {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 400;
  const g = c.getContext("2d");
  if (sharp) {
    const grad = g.createLinearGradient(0, 0, 640, 400);
    grad.addColorStop(0, "#2C5F82"); grad.addColorStop(1, "#4FB3E8");
    g.fillStyle = grad; g.fillRect(0, 0, 640, 400);
    g.fillStyle = "#F09A47";
    g.beginPath(); g.arc(320, 200, 90, 0, 7); g.fill();
    g.fillStyle = "#fff"; g.font = "bold 28px Segoe UI";
    g.fillText("APRÈS — net", 240, 350);
  } else {
    const s = document.createElement("canvas");
    s.width = 64; s.height = 40;
    const sg = s.getContext("2d");
    sg.fillStyle = "#2C5F82"; sg.fillRect(0, 0, 64, 40);
    sg.fillStyle = "#F09A47";
    sg.beginPath(); sg.arc(32, 20, 9, 0, 7); sg.fill();
    g.imageSmoothingEnabled = false;
    g.drawImage(s, 0, 0, 640, 400);
    g.fillStyle = "#fff"; g.font = "bold 28px Segoe UI";
    g.fillText("AVANT — flou", 236, 350);
  }
  return c.toDataURL("image/jpeg", .9);
}

function mockApi(method, ...args) {
  const delay = (v, ms = 200) =>
    new Promise((r) => setTimeout(() => r(v), ms));
  switch (method) {
    case "update_check":
      return delay({ current: "2.9.0", latest: "2.10.0", available: true,
        full_only: false, page: "https://github.com/Rayou444/Mudkit/releases",
        notes: "- Exemple de note de version\n- Deuxième ligne" }, 700);
    case "update_start": {
      let pct = 0;
      const iv = setInterval(() => {
        pct += 0.1;
        if (pct >= 1) {
          clearInterval(iv);
          window.mudkitEvent({ type: "upd_done", ok: true, version: "2.10.0" });
        } else window.mudkitEvent({ type: "upd_progress", pct });
      }, 150);
      return delay(true);
    }
    case "history_list":
      return delay([
        { id: "a", ts: Date.now() / 1000 - 600, exists: true,
          title: "Une super vidéo de démonstration", url: "https://www.youtube.com/watch?v=demo",
          mode: "video", quality: "1080", format: "mp4", files: ["C:\\demo\\a.mp4"] },
        { id: "b", ts: Date.now() / 1000 - 90000, exists: false,
          title: "Un son pour le montage", url: "https://www.tiktok.com/@demo/video/1",
          mode: "audio", quality: "max", format: "mp3", files: ["C:\\demo\\b.mp3"] },
      ]);
    case "error_report":
      return delay("Mudkit (aperçu navigateur)\n--- journal ---\n(rien)");
    case "ui_ready":
      return delay({ version: "dev", ffmpeg: true, realesrgan: true,
        upscayl_models: true, ytdlp: "2026.08.19",
        download_dir: "C:\\Users\\Rayan\\Downloads\\Mudkit",
        models: MODEL_META.map(([key]) => ({ key, available: true })) });
    case "analyze_url":
      return delay({ ok: true, info: { kind: "video",
        title: "Une super vidéo de démonstration — les gobous à l'état sauvage",
        channel: "Chaîne Démo", duration: "12:34", duration_s: 754,
        thumb: mockImage(true) } }, 900);
    case "start_compress": {
      const files = args[0].files;
      files.forEach((p, i) => {
        let pct = 0;
        setTimeout(() => {
          const iv = setInterval(() => {
            pct += 0.06;
            if (pct >= 1) {
              clearInterval(iv);
              window.mudkitEvent({ type: "cp_file_done", index: i, ok: true,
                out: p.replace(/(\.\w+)$/, "_25Mo.mp4"),
                orig: "148 Mo", size: "23,7 Mo" });
              if (i === files.length - 1)
                window.mudkitEvent({ type: "cp_done",
                  ok: files.length, total: files.length });
            } else {
              window.mudkitEvent({ type: "cp_progress", index: i, pct });
            }
          }, 100);
        }, i * 500);
      });
      return delay(true);
    }
    case "pick_files":
      return delay(args[0] === "images"
        ? ["C:\\demo\\photo_vacances.png", "C:\\demo\\fond_ecran.jpg"]
        : ["C:\\demo\\clip_gameplay.mp4", "C:\\demo\\montage.mkv"]);
    case "file_infos":
      return delay(args[0].map((p) => ({
        path: p, name: p.split("\\").pop(), size: "2,4 Mo", dims: "640×400",
        category: /\.(png|jpe?g|webp|bmp)$/i.test(p) ? "image"
                : /\.(mp4|mkv|webm)$/i.test(p) ? "video" : "audio" })));
    case "detect_targets": {
      const vid = args[0].some((p) => /\.(mp4|mkv|webm)$/i.test(p));
      return delay(vid
        ? { category: "video",
            targets: ["mp4", "mkv", "webm", "mov", "avi", "gif", "mp3"] }
        : { category: "image",
            targets: ["png", "jpg", "webp", "bmp", "ico"] });
    }
    case "paste_files":
      return delay({ paths: ["C:\\demo\\colle_1.png", "C:\\demo\\colle_2.jpg"] });
    case "thumb":
      return delay(mockImage(false));
    case "preview":
      return delay(mockImage(/\dx_/.test(args[0])), 300);
    case "preview_png":
      return delay(mockImage(true), 300);
    case "start_cutout": {
      const files = args[0].files;
      files.forEach((p, i) => {
        setTimeout(() => {
          window.mudkitEvent({ type: "bg_progress", index: i, phase: "run" });
          setTimeout(() => {
            window.mudkitEvent({ type: "bg_file_done", index: i, ok: true,
              out: p.replace(/(\.\w+)$/, "_detoure.png") });
            if (i === files.length - 1)
              window.mudkitEvent({ type: "bg_done",
                ok: files.length, total: files.length });
          }, 1200);
        }, i * 1400);
      });
      return delay(true);
    }
    case "start_download": {
      let pct = 0;
      const iv = setInterval(() => {
        pct += 0.05;
        if (pct >= 1) {
          clearInterval(iv);
          window.mudkitEvent({ type: "dl_progress", phase: "processing" });
          setTimeout(() => window.mudkitEvent(
            { type: "dl_done", ok: true,
              title: "Une super vidéo de démonstration" }), 1200);
        } else {
          window.mudkitEvent({ type: "dl_progress", phase: "downloading",
            pct, done: `${(pct * 240).toFixed(0)} Mo`, total: "240 Mo",
            speed: "12,4 Mo/s", eta: (1 - pct) * 16 });
        }
      }, 180);
      return delay(true);
    }
    case "start_upscale":
    case "start_convert": {
      const pre = method === "start_upscale" ? "up" : "cv";
      const files = args[0].files;
      files.forEach((p, i) => {
        let pct = 0;
        setTimeout(() => {
          const iv = setInterval(() => {
            pct += 0.1;
            if (pct >= 1) {
              clearInterval(iv);
              window.mudkitEvent({ type: `${pre}_file_done`, index: i,
                ok: true, out: p.replace(/([^\\]+)$/, "4x_$1") });
              if (i === files.length - 1)
                window.mudkitEvent({ type: `${pre}_done`,
                  ok: files.length, total: files.length });
            } else {
              window.mudkitEvent({ type: `${pre}_progress`, index: i, pct });
            }
          }, 110);
        }, i * 600);
      });
      return delay(true);
    }
    default:
      return delay(true);
  }
}

/* ---------------- demarrage ---------------- */

(async function init() {
  const st = await api("ui_ready");
  if (!st) return;  // erreur deja affichee (avec le bouton de rapport)
  $("#app-ver").textContent = "v" + st.version;
  wireTheme(st);
  if (st.page && $(`#page-${st.page}`)) go(st.page);
  renderEngines(st);
  renderModels(st);
  wireDownloader(st);
  wireHistory();
  wireSection();
  wireUpscaler();
  wireConverter();
  wireCompressor();
  wireCutout();
  wireSettings(st);
  if (MOCK) toast("Mode aperçu navigateur (simulation).");
})();
