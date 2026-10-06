/* Panneau Mudkit pour Premiere Pro : telechargement via le moteur Mudkit. */
"use strict";

var nodeReq = (window.cep_node && window.cep_node.require)
  ? window.cep_node.require
  : (typeof require !== "undefined" ? require : null);

/* Mudkit vit toujours dans %USERPROFILE%\Mudkit. Moteur Python : python\
   (portable, PC installes via l'installateur) ou .venv (PC de dev). */
var MUDKIT = nodeReq ? nodeReq("os").homedir() + "\\Mudkit" : "";
var SCRIPT = MUDKIT + "\\premiere_dl.py";
var PY = (function () {
  var cands = [MUDKIT + "\\python\\python.exe",
               MUDKIT + "\\.venv\\Scripts\\python.exe"];
  if (!nodeReq) return cands[0];
  var fs = nodeReq("fs");
  for (var i = 0; i < cands.length; i++)
    if (fs.existsSync(cands[i])) return cands[i];
  return cands[0];
})();

var mode = "h264";
var action = "insert";
var proc = null;

function $(s) { return document.querySelector(s); }

function parseTime(txt) {
  // accepte "90", "1:30", "1:02:30"
  txt = (txt || "").trim();
  if (!txt) return null;
  var parts = txt.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  var s = 0;
  for (var i = 0; i < parts.length; i++) s = s * 60 + parts[i];
  return s;
}

/* ------- theme : suit la couleur du theme Apparence de Premiere ------- */

/* Derive TOUTE la palette de la couleur de fond que Premiere nous donne.
   Chaque variable definie dans index.html doit etre pilotee ici, sinon la
   moitie du panneau reste figee sur les valeurs de secours et ne suit plus
   la luminosite reglee dans Premiere. */
function setTheme(r, g, b) {
  function shade(d) {
    function f(x) { return Math.max(0, Math.min(255, Math.round(x + d))); }
    return "rgb(" + f(r) + "," + f(g) + "," + f(b) + ")";
  }
  var light = (r + g + b) / 3 > 128;   // theme clair de Premiere
  var s = light ? -1 : 1;              // sens pour "se detacher du fond"
  var root = document.documentElement.style;
  root.setProperty("--bg",    shade(0));
  root.setProperty("--side",  shade(s * 6));
  root.setProperty("--panel", shade(s * 10));
  root.setProperty("--row-h", shade(s * 20));
  root.setProperty("--row-s", shade(s * 32));
  root.setProperty("--line",  shade(s * 24));
  root.setProperty("--input", light ? shade(14) : shade(-9));
  root.setProperty("--text",  light ? "#1B1B1B" : "#D2D2D2");
  root.setProperty("--dim",   light ? "#5A5A5A" : "#969696");
  root.setProperty("--faint", light ? "#8A8A8A" : "#6C6C6C");
}

function applyTheme() {
  try {
    var env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    var sk = env.appSkinInfo;
    var c = sk.panelBackgroundColor.color;
    setTheme(c.red, c.green, c.blue);
    // meme police et meme taille de base que l'hote
    var root = document.documentElement.style;
    if (sk.baseFontFamily)
      root.setProperty("--font", '"' + sk.baseFontFamily +
                       '", "Adobe Clean", "Segoe UI", "Segoe UI Symbol",' +
                       ' "Segoe UI Emoji", "Yu Gothic UI", "Malgun Gothic",' +
                       ' "Microsoft YaHei UI", system-ui, sans-serif');
    var fsz = parseFloat(sk.baseFontSize);
    if (isFinite(fsz) && fsz > 0)
      root.setProperty("--fs", Math.max(10, Math.min(13, fsz)) + "px");
  } catch (e) { /* garde le theme sombre par defaut */ }
}

if (window.__adobe_cep__) {
  applyTheme();
  try {
    window.__adobe_cep__.addEventListener(
      "com.adobe.csxs.events.ThemeColorChanged", applyTheme);
  } catch (e) {}
}

/* ------------------------------ logique ------------------------------ */

function evalScript(script) {
  return new Promise(function (resolve) {
    if (window.__adobe_cep__) window.__adobe_cep__.evalScript(script, resolve);
    else resolve("err:pas dans Premiere");
  });
}

/* Chaine pour ExtendScript (ES3) : tout le non-ASCII echappe. JSON.stringify
   laisse passer U+2028 / U+2029, fins de ligne en ES3 : un titre YouTube qui
   en contenait faisait echouer l'import. */
function esStr(v) {
  return JSON.stringify(String(v)).replace(/[^\x00-\x7e]/g, function (c) {
    return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function status(msg, cls) {
  var el = $("#status");
  el.textContent = msg;
  el.className = cls || "";
}

/* Progression aussi sur le bouton Telecharger : on peut fermer la fenetre et
   continuer a parcourir la bibliotheque pendant le telechargement. */
function pillProgress(txt) {
  $("#dllabel").textContent = txt || "Télécharger";
}

function running(on) {
  if (!on) pillProgress(null);
  $("#go").disabled = on;
  $("#cancel").classList.toggle("hidden", !on);
  $("#bar").classList.toggle("hidden", !on);
  if (on) {
    $("#bar").classList.remove("indet");
    $("#bar i").style.width = "0%";
  }
}

document.querySelectorAll("#seg button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#seg button").forEach(function (x) {
      x.classList.remove("on");
    });
    b.classList.add("on");
    mode = b.dataset.v;
    try { localStorage.setItem("mudkit.dl.mode", mode); } catch (e) {}
  });
});

document.querySelectorAll("#act button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#act button").forEach(function (x) {
      x.classList.remove("on");
    });
    b.classList.add("on");
    action = b.dataset.v;
    try { localStorage.setItem("mudkit.dl.action", action); } catch (e) {}
  });
});

/* format et action du dernier telechargement : retrouves a l'ouverture */
(function () {
  function restore(sel, key, cur) {
    var v = cur;
    try { v = localStorage.getItem(key) || cur; } catch (e) {}
    var found = false;
    document.querySelectorAll(sel + " button").forEach(function (x) {
      x.classList.toggle("on", x.dataset.v === v);
      if (x.dataset.v === v) found = true;
    });
    if (!found) {
      document.querySelectorAll(sel + " button").forEach(function (x) { x.classList.toggle("on", x.dataset.v === cur); });
      return cur;
    }
    return v;
  }
  mode = restore("#seg", "mudkit.dl.mode", mode);
  action = restore("#act", "mudkit.dl.action", action);
})();

/* Tab reste dans la fenetre de telechargement : avant, il atteignait la
   recherche derriere, et taper filtrait la grille sans qu'on le voie. */
document.addEventListener("keydown", function (e) {
  if (e.key !== "Tab" || !$("#dloverlay").classList.contains("on")) return;
  var f = [].slice.call($("#dloverlay").querySelectorAll("button, input, a[href]"))
    .filter(function (x) { return !x.disabled && x.offsetParent !== null; });
  if (!f.length) return;
  var i = f.indexOf(document.activeElement);
  if (i < 0 || (e.shiftKey && i === 0) || (!e.shiftKey && i === f.length - 1)) {
    e.preventDefault();
    f[e.shiftKey ? f.length - 1 : 0].focus();
  }
});

$("#cut").addEventListener("change", function (e) {
  $("#cutrow").classList.toggle("hidden", !e.target.checked);
});

/* Le moteur (Python de Mudkit) manque : spawn emet "error" (ENOENT). */
var ENGINE_MISSING = "Moteur Mudkit introuvable dans " + MUDKIT +
  " : installe ou répare Mudkit (INSTALLER Mudkit.bat).";

/* Derniere ligne utile de stderr (ex. « ModuleNotFoundError: ... »). */
function lastLine(txt) {
  var lines = (txt || "").split(/\r?\n/).map(function (l) { return l.trim(); })
    .filter(function (l) { return l; });
  return lines.length ? lines[lines.length - 1].slice(0, 240) : "";
}

function killTree(p) {
  try {
    nodeReq("child_process").spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"],
                                   { windowsHide: true });
  } catch (e) {
    try { p.kill(); } catch (e2) {}
  }
}

$("#url").addEventListener("keydown", function (e) {
  if (e.key === "Enter") $("#go").click();
});

$("#cancel").addEventListener("click", function () {
  // tout l'arbre : tuer Python seul laissait tourner le ffmpeg lance par
  // yt-dlp (fusion, extrait) a 100 % du processeur
  if (proc) killTree(proc);
  status("Annulé.");
  running(false);
});

$("#go").addEventListener("click", function () {
  var url = $("#url").value.trim();
  if (!url) return status("Colle d'abord un lien.", "err");
  if (!nodeReq) return status("Node est désactivé dans ce panneau (CEP).", "err");
  if (ytdlpBusy)
    return status("yt-dlp se met à jour, réessaie dans quelques secondes.", "err");

  // -E -s : ignore un eventuel Python perso (PYTHONPATH, site utilisateur)
  var args = ["-E", "-s", "-X", "utf8", "-u", SCRIPT, url, mode];
  if ($("#cut").checked) {
    var tin = parseTime($("#t-in").value) || 0;
    var tout = parseTime($("#t-out").value);
    if (tout == null || tout <= tin)
      return status("Passage invalide : mets une fin après le début " +
                    "(ex. 0:30 → 1:45).", "err");
    args.push(String(tin), String(tout));
  }

  var spawn = nodeReq("child_process").spawn;
  running(true);
  status("Téléchargement…");

  try {
    proc = spawn(PY, args, { windowsHide: true });
  } catch (e) {
    running(false);
    return status("Impossible de lancer Mudkit : " + e.message, "err");
  }

  var buf = "", errBuf = "";
  // lu en continu : un tampon stderr plein bloquerait Python
  proc.stderr.on("data", function (chunk) {
    errBuf = (errBuf + chunk.toString("utf8")).slice(-4000);
  });
  proc.on("error", function () {
    proc = null;
    running(false);
    status(ENGINE_MISSING, "err");
  });
  proc.stdout.on("data", function (chunk) {
    buf += chunk.toString("utf8");
    var lines = buf.split("\n");
    buf = lines.pop();
    lines.forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      onMessage(msg);
    });
  });
  proc.on("exit", function (code) {
    proc = null;
    if (code !== 0 && !$("#status").classList.contains("err")) {
      running(false);
      if ($("#status").textContent.indexOf("Annulé") !== 0) {
        var why = lastLine(errBuf);  // plantage Python : la vraie cause
        status("Le téléchargement s'est arrêté" +
               (why ? " : " + why : " (code " + code + ")."), "err");
      }
    }
  });
});

/* -------------- mise a jour : un seul bouton, comme l'appli -------------
   Le panneau et l'appli se mettent a jour ensemble (meme zip). Le bouton
   vert n'apparait que s'il y a quelque chose a faire, et un clic suffit :
     « Mettre à jour » telecharge + installe (python -m mudkit.updater apply)
                       puis recharge le panneau tout seul ;
     « Recharger »     l'appli a deja installe une nouvelle version : il ne
                       reste qu'a recharger le panneau ;
     « Nouvelle version » la release demande l'installateur complet.
   Sur le PC de dev (depot git), le moteur repond "dev" : pas de bouton de
   mise a jour, seulement « Recharger » si la version du depot change. */

var UPD_EVERY = 6 * 3600 * 1000;
var upd = { state: "", info: null, proc: null };

function libSay(msg, cls) {
  var el = $("#libstatus");
  el.textContent = msg;
  el.className = "msg " + (cls || "");
}

/* Version du code Mudkit sur le disque (appli + panneau voyagent ensemble). */
function diskVersion() {
  if (!nodeReq) return null;
  try {
    var src = nodeReq("fs").readFileSync(MUDKIT + "\\mudkit\\__init__.py", "utf8");
    var m = /__version__\s*=\s*"([^"]+)"/.exec(src);
    return m ? m[1] : null;
  } catch (e) { return null; }
}
var loadedVersion = diskVersion();   // la version avec laquelle ce panneau a demarre

function updShow(state, label, title) {
  upd.state = state;
  var b = $("#updpill");
  b.classList.toggle("hidden", !label);
  b.disabled = state === "running";
  if (label) { b.querySelector("span").textContent = label; b.title = title || ""; }
}

/* Lance le moteur de mise a jour ; onLine recoit chaque ligne JSON. */
function runUpdater(cmd, onLine, onEnd) {
  var spawn = nodeReq("child_process").spawn, p, buf = "", got = false, ended = false;
  function end() { if (!ended) { ended = true; onEnd(got); } }
  try {
    p = spawn(PY, ["-E", "-s", "-X", "utf8", "-m", "mudkit.updater", cmd],
              { cwd: MUDKIT, windowsHide: true });
  } catch (e) { return end(); }
  p.stdout.on("data", function (c) {
    buf += c.toString("utf8");
    var lines = buf.split("\n");
    buf = lines.pop();
    lines.forEach(function (l) {
      var msg;
      try { msg = JSON.parse(l); } catch (e) { return; }
      got = true; onLine(msg);
    });
  });
  p.stderr.on("data", function () {});   // lu pour ne jamais bloquer Python
  p.on("error", end);
  p.on("close", end);   // "close" et non "exit" : stdout est alors lu en entier
  return p;
}

/* Recharge le panneau sur les nouveaux fichiers. host.jsx (ExtendScript)
   n'est relu qu'au chargement de l'extension : on le reevalue a la main,
   sinon les fonctions d'import resteraient les anciennes. */
function reloadPanel() {
  if (proc) {
    // un telechargement tourne dans ce panneau : on ne le coupe pas
    updShow("reload", "Recharger", "Nouvelle version installée : un clic recharge le panneau");
    return libSay("Mise à jour installée : le panneau se rechargera via le bouton vert après le téléchargement.", "ok");
  }
  var host = decodeURIComponent(new URL("host.jsx", location.href).pathname)
    .replace(/^\/(?=[A-Za-z]:)/, "");
  evalScript("try { $.evalFile(new File(" + JSON.stringify(host) + ")); 'ok' } catch (e) { 'err:' + e }")
    .then(function () { location.reload(); });
}

function applyUpdate() {
  if (!nodeReq || upd.state === "running") return;
  updShow("running", "Mise à jour…", "Téléchargement et installation de la nouvelle version");
  libSay("Mise à jour de Mudkit…");
  var last = null;
  upd.proc = runUpdater("apply", function (msg) {
    last = msg;
    if (msg.pct != null) {
      $("#updpill span").textContent = "Mise à jour " + Math.round(msg.pct * 100) + " %";
    }
  }, function () {
    upd.proc = null;
    if (last && last.done) {
      libSay("Mudkit " + last.version + " installé, rechargement du panneau…", "ok");
      return setTimeout(reloadPanel, 600);
    }
    if (last && last.full_only) return showFullOnly(last.page);
    var why = (last && last.error) || "le moteur Mudkit ne répond pas";
    updShow("error", "Réessayer la mise à jour", why);
    libSay("Mise à jour impossible : " + why, "err");
  });
}

function showFullOnly(page) {
  upd.info = upd.info || {};
  upd.info.page = page || upd.info.page;
  updShow("full", "Nouvelle version",
          "Cette version demande le nouvel installateur : un clic ouvre la page de téléchargement");
}

function checkUpdate() {
  if (!nodeReq || upd.state === "running" || upd.state === "reload") return;
  var last = null;
  runUpdater("check", function (msg) { last = msg; }, function () {
    if (!last || last.dev || last.error) return;   // dev, hors ligne : rien
    upd.info = last;
    if (loadedVersion && last.installed && last.installed !== loadedVersion)
      return updShow("reload", "Recharger", "Mudkit " + last.installed + " est installé : un clic recharge le panneau");
    if (!last.available) return updShow("", null);
    if (last.full_only) return showFullOnly(last.page);
    updShow("available", "Mettre à jour",
            "Mudkit " + last.latest + " est disponible : un clic l'installe (panneau + appli) et recharge le panneau");
  });
}

$("#updpill").addEventListener("click", function () {
  if (upd.state === "available" || upd.state === "error") return applyUpdate();
  if (upd.state === "reload") return reloadPanel();
  if (upd.state === "full" && upd.info && upd.info.page) {
    try { window.cep.util.openURLInDefaultBrowser(upd.info.page); } catch (e) {}
  }
});

/* yt-dlp a jour tout seul : `python -m mudkit.updater ytdlp` ne fait rien
   s'il a deja ete mis a jour dans les 24 h (par l'appli ou le panneau), ni
   sur le PC de dev. Jamais pendant un telechargement. */
var ytdlpBusy = false;
function ytdlpAuto() {
  if (!nodeReq || proc || ytdlpBusy || upd.state === "running") return;
  ytdlpBusy = true;
  runUpdater("ytdlp", function () {}, function () { ytdlpBusy = false; });
}

if (nodeReq) {
  setTimeout(ytdlpAuto, 30 * 1000);
  setInterval(ytdlpAuto, UPD_EVERY);
}

if (nodeReq && loadedVersion) {
  setTimeout(checkUpdate, 5000);
  setInterval(checkUpdate, UPD_EVERY);
  /* L'appli a pu mettre a jour le panneau pendant que Premiere tournait :
     simple lecture d'un fichier local, donc verifiee souvent. */
  setInterval(function () {
    var v = diskVersion();
    if (v && v !== loadedVersion && upd.state !== "running" && upd.state !== "reload")
      updShow("reload", "Recharger", "Mudkit " + v + " est installé : un clic recharge le panneau");
  }, 60 * 1000);
}

function onMessage(msg) {
  if (msg.error) {
    running(false);
    return status("Erreur : " + msg.error, "err");
  }
  if (msg.processing) {
    $("#bar").classList.add("indet");
    return status("Fusion / conversion…");
  }
  if (msg.transcode_start) {
    $("#bar").classList.remove("indet");
    $("#bar i").style.width = "0%";
    return status("Codec non lisible par Premiere : conversion en H.264…");
  }
  if ("pct" in msg && msg.pct == null) {
    $("#bar").classList.add("indet");
    return status(msg.transcode ? "Conversion pour Premiere…"
                                : "Téléchargement…" + (msg.speed ? " · " + msg.speed : ""));
  }
  if (msg.pct != null) {
    $("#bar").classList.remove("indet");
    $("#bar i").style.width = (msg.pct * 100).toFixed(1) + "%";
    pillProgress((msg.transcode ? "Conversion " : "Téléchargement ")
                 + (msg.pct * 100).toFixed(0) + " %");
    status((msg.transcode ? "Conversion pour Premiere… "
                          : "Téléchargement… ")
           + (msg.pct * 100).toFixed(0) + " %"
           + (msg.speed ? " · " + msg.speed : ""));
    return;
  }
  if (msg.done) {
    $("#bar").classList.add("indet");
    status("Import dans Premiere…");
    evalScript("mudkitImport(" + esStr(msg.path) + ", " + esStr(action) + ")")
      .then(function (res) {
      running(false);
      if (res === "inserted")
        status("OK " + msg.title + " : importé et posé sur la timeline", "ok");
      else if (res === "imported")
        status("OK " + msg.title + " : dans le chutier Mudkit", "ok");
      else if (res === "imported_no_seq")
        status("OK Importé dans le chutier Mudkit (aucune séquence active " +
               "pour l'insertion)", "ok");
      else if (res && res.indexOf("imported_insert_failed") === 0)
        status("Importé, mais insertion timeline impossible : " +
               res.split(":").slice(1).join(":"), "err");
      else
        status("Téléchargé, mais import échoué : " + res, "err");
    });
  }
}
