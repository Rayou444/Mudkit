/* Panneau Mudkit pour Premiere Pro — telechargement via le moteur Mudkit. */
"use strict";

var PY = "C:\\Users\\Rayan\\Mudkit\\.venv\\Scripts\\python.exe";
var SCRIPT = "C:\\Users\\Rayan\\Mudkit\\premiere_dl.py";

var nodeReq = (window.cep_node && window.cep_node.require)
  ? window.cep_node.require
  : (typeof require !== "undefined" ? require : null);

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

function setTheme(r, g, b) {
  function shade(d) {
    function f(x) { return Math.max(0, Math.min(255, Math.round(x + d))); }
    return "rgb(" + f(r) + "," + f(g) + "," + f(b) + ")";
  }
  var root = document.documentElement.style;
  root.setProperty("--bg", shade(0));
  root.setProperty("--panel", shade(12));
  root.setProperty("--panel-h", shade(24));
  root.setProperty("--line", shade(30));
  root.setProperty("--input", shade(-10));
  var light = (r + g + b) / 3 > 128;  // theme clair de Premiere
  root.setProperty("--text", light ? "#1B1B1B" : "#D6D6D6");
  root.setProperty("--dim", light ? "#5A5A5A" : "#999999");
}

function applyTheme() {
  try {
    var env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    var c = env.appSkinInfo.panelBackgroundColor.color;
    setTheme(c.red, c.green, c.blue);
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

function status(msg, cls) {
  var el = $("#status");
  el.textContent = msg;
  el.className = cls || "";
}

function running(on) {
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
  });
});

document.querySelectorAll("#act button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#act button").forEach(function (x) {
      x.classList.remove("on");
    });
    b.classList.add("on");
    action = b.dataset.v;
  });
});

$("#cut").addEventListener("change", function (e) {
  $("#cutrow").classList.toggle("hidden", !e.target.checked);
});

$("#upd").addEventListener("click", function (e) {
  e.preventDefault();
  if (!nodeReq || proc) return;
  var spawn = nodeReq("child_process").spawn;
  status("Mise à jour de yt-dlp…");
  var code = "import sys; sys.path.insert(0, r'C:\\Users\\Rayan\\Mudkit'); " +
    "from mudkit import dnsfix; dnsfix.activate_if_needed(); " +
    "sys.argv = ['pip', 'install', '-q', '-U', 'yt-dlp']; " +
    "from pip._internal.cli.main import main; sys.exit(main())";
  var p = spawn(PY, ["-c", code], { windowsHide: true });
  p.on("exit", function (c) {
    status(c === 0 ? "yt-dlp à jour ✓" : "Échec de la mise à jour de yt-dlp",
           c === 0 ? "ok" : "err");
  });
});

$("#url").addEventListener("keydown", function (e) {
  if (e.key === "Enter") $("#go").click();
});

$("#cancel").addEventListener("click", function () {
  if (proc) { try { proc.kill(); } catch (e) {} }
  status("Annulé.");
  running(false);
});

$("#go").addEventListener("click", function () {
  var url = $("#url").value.trim();
  if (!url) return status("Colle d'abord un lien.", "err");
  if (!nodeReq) return status("Node est désactivé dans ce panneau (CEP).", "err");

  var args = ["-u", SCRIPT, url, mode];
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

  var buf = "";
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
      if ($("#status").textContent.indexOf("Annulé") !== 0)
        status("Le téléchargement s'est arrêté (code " + code + ").", "err");
    }
  });
});

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
    return status("Codec non lisible par Premiere — conversion en H.264…");
  }
  if (msg.pct != null) {
    $("#bar").classList.remove("indet");
    $("#bar i").style.width = (msg.pct * 100).toFixed(1) + "%";
    status((msg.transcode ? "Conversion pour Premiere… "
                          : "Téléchargement… ")
           + (msg.pct * 100).toFixed(0) + " %"
           + (msg.speed ? " · " + msg.speed : ""));
    return;
  }
  if (msg.done) {
    $("#bar").classList.add("indet");
    status("Import dans Premiere…");
    evalScript("mudkitImport(" + JSON.stringify(msg.path) + ", \"" +
               action + "\")").then(function (res) {
      running(false);
      if (res === "inserted")
        status("✓ " + msg.title + " — importé et posé sur la timeline", "ok");
      else if (res === "imported")
        status("✓ " + msg.title + " — dans le chutier Mudkit", "ok");
      else if (res === "imported_no_seq")
        status("✓ Importé dans le chutier Mudkit (aucune séquence active " +
               "pour l'insertion)", "ok");
      else if (res && res.indexOf("imported_insert_failed") === 0)
        status("Importé, mais insertion timeline impossible : " +
               res.split(":").slice(1).join(":"), "err");
      else
        status("Téléchargé, mais import échoué : " + res, "err");
    });
  }
}
