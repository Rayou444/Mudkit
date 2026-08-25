/* Gestionnaire de medias local du panneau Mudkit -- pense pour remplacer la
   User Library de Mister Horse (plan gratuit plafonne a 500 items).

   Fonctionne comme un navigateur de dossiers : on pointe un dossier racine,
   il est scanne recursivement (Node fs) et mis en cache, on descend dans les
   sous-dossiers (fil d'Ariane), on cherche, on previsualise au survol (forme
   d'onde audio, poster + sprite scrubable pour la video, vignette image), et
   on GLISSE l'item sur la timeline Premiere (drag natif CEP via la cle
   com.adobe.cep.dnd.file.0) ; double-clic = import direct en secours.
   Rien n'appelle de serveur : aucune limite d'elements.
   Volontairement en ASCII (les accents dans ce panneau = ennuis). */
"use strict";

(function () {

var nodeReq = (window.cep_node && window.cep_node.require)
  ? window.cep_node.require
  : (typeof require !== "undefined" ? require : null);

var fs, path, os, crypto, spawn;
if (nodeReq) {
  fs = nodeReq("fs");
  path = nodeReq("path");
  os = nodeReq("os");
  crypto = nodeReq("crypto");
  spawn = nodeReq("child_process").spawn;
}

var MUDKIT = "C:\\Users\\Rayan\\Mudkit";
var FFMPEG = MUDKIT + "\\bin\\ffmpeg.exe";
var FFPROBE = MUDKIT + "\\bin\\ffprobe.exe";
var LOCALAPP = (typeof process !== "undefined" && process.env &&
                process.env.LOCALAPPDATA)
  ? process.env.LOCALAPPDATA
  : (os ? os.homedir() + "\\AppData\\Local" : null);
var CACHE = LOCALAPP ? LOCALAPP + "\\Mudkit\\lib-cache" : null;

var MAX_DEPTH = 12;
var PAGE = 120;
var SPRITE_N = 24;
var HOVER_MS = 230;
var SKIP_DIRS = { "node_modules": 1, "$recycle.bin": 1, ".git": 1,
                  "system volume information": 1, ".cache": 1 };

var EXT = {};
"mp3 wav flac m4a aac ogg opus aif aiff wma mka".split(" ")
  .forEach(function (e) { EXT[e] = "audio"; });
"mp4 mov mkv avi webm mxf m4v wmv mpg mpeg mts m2ts flv ts r3d braw"
  .split(" ").forEach(function (e) { EXT[e] = "video"; });
"jpg jpeg png gif webp bmp tif tiff avif heic heif svg tga dpx exr psd"
  .split(" ").forEach(function (e) { EXT[e] = "image"; });

var WEB_AUDIO = { mp3: 1, wav: 1, flac: 1, m4a: 1, aac: 1, ogg: 1, opus: 1, mka: 1 };
var WEB_IMAGE = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, bmp: 1, svg: 1, avif: 1 };
var WEB_VIDEO = { mp4: 1, m4v: 1, mov: 1, webm: 1 };

var GLYPH = { audio: "\u266A", video: "\u25B6", image: "\u25A3" };
var SEP = "\u25B8";           // petit triangle du fil d'Ariane
var CHECK = "\u2713";

/* --------------------------------- etat -------------------------------- */

var roots = [];        // dossiers racine memorises
var root = "";         // racine courante (absolu)
var stack = [];        // segments de sous-dossiers dans la racine
var all = [];          // tous les fichiers (recursif) : { p,n,e,k,sz,mt,rel }
var meta = {};         // p -> { dur }
var view = [];         // items affiches (apres filtre / niveau)
var rendered = 0;
var kind = "all";
var query = "";
var action = "insert";
var listView = false;
var token = 0;

var audio = new Audio();
var playingTile = null;
var hoverTimer = null;

/* ------------------------------- helpers ------------------------------- */

function $(s) { return document.querySelector(s); }
function ls(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function md5(s) { return crypto.createHash("md5").update(s, "utf8").digest("hex"); }
function ext(p) { var i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i + 1).toLowerCase(); }
function mkdirp(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

function fileUrl(p) {
  return "file:///" + encodeURI(p.replace(/\\/g, "/"))
    .replace(/#/g, "%23").replace(/\?/g, "%3F");
}
function human(n) {
  if (n < 1024) return n + " o";
  if (n < 1048576) return (n / 1024).toFixed(0) + " Ko";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " Mo";
  return (n / 1073741824).toFixed(2) + " Go";
}
function clock(s) {
  if (s == null || !isFinite(s)) return "";
  s = Math.round(s);
  var m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return h + ":" + ("0" + (m % 60)).slice(-2) + ":" + ("0" + (s % 60)).slice(-2);
  return m + ":" + ("0" + (s % 60)).slice(-2);
}
function say(msg, cls) { var el = $("#libstatus"); el.textContent = msg; el.className = cls || ""; }
function curRel() { return stack.join("/"); }

function evalScript(script) {
  return new Promise(function (resolve) {
    if (window.__adobe_cep__) window.__adobe_cep__.evalScript(script, resolve);
    else resolve("err:pas dans Premiere");
  });
}

/* ------------------------- file d'attente ffmpeg ----------------------- */

var queue = [], busy = 0, MAXJOBS = 2;

function run(exe, args, done) { queue.push({ exe: exe, args: args, done: done, tok: token }); pump(); }

function pump() {
  while (busy < MAXJOBS && queue.length) {
    var job = queue.shift();
    if (job.tok !== token) continue;
    busy++;
    (function (j) {
      var out = "", err = "", p;
      try { p = spawn(j.exe, j.args, { windowsHide: true }); }
      catch (e) { busy--; j.done(String(e)); return pump(); }
      p.stdout.on("data", function (c) { out += c.toString(); });
      p.stderr.on("data", function (c) { err += c.toString(); });
      p.on("error", function (e) { busy--; j.done(String(e)); pump(); });
      p.on("close", function (code) { busy--; j.done(code === 0 ? null : (err.trim() || ("code " + code)), out); pump(); });
    })(job);
  }
}

/* --------------------------------- cache ------------------------------- */

function cachePath(sub, key, ex) { var d = CACHE + "\\" + sub; mkdirp(d); return d + "\\" + key + ex; }
function keyOf(it) { return md5(it.p + "|" + it.mt + "|" + it.sz); }
function indexFile(r) { mkdirp(CACHE); return CACHE + "\\idx-" + md5(r.toLowerCase()) + ".json"; }

function loadIndex(r) {
  try { var o = JSON.parse(fs.readFileSync(indexFile(r), "utf8")); if (o && o.v === 1 && o.items) return o; }
  catch (e) {}
  return null;
}
function saveIndex(r) {
  try { fs.writeFileSync(indexFile(r), JSON.stringify({ v: 1, root: r, ts: Date.now(), items: all, meta: meta })); }
  catch (e) {}
}

/* --------------------------------- scan -------------------------------- */

function scan(r, after) {
  var mine = ++token;
  all = [];
  var dirs = [{ d: r, rel: "", lvl: 0 }], seenDirs = 0;
  queue.length = 0;

  function step() {
    if (mine !== token) return;
    var budget = 60;
    while (dirs.length && budget-- > 0) {
      var cur = dirs.shift();
      seenDirs++;
      var ents;
      try { ents = fs.readdirSync(cur.d, { withFileTypes: true }); } catch (e) { continue; }
      for (var i = 0; i < ents.length; i++) {
        var en = ents[i], nm = en.name;
        if (nm.charAt(0) === ".") continue;
        var full = cur.d + "\\" + nm;
        if (en.isDirectory()) {
          if (cur.lvl >= MAX_DEPTH || SKIP_DIRS[nm.toLowerCase()]) continue;
          dirs.push({ d: full, rel: cur.rel ? cur.rel + "/" + nm : nm, lvl: cur.lvl + 1 });
          continue;
        }
        var e = ext(nm), k = EXT[e];
        if (!k) continue;
        var st; try { st = fs.statSync(full); } catch (er) { continue; }
        all.push({ p: full, n: nm, e: e, k: k, rel: cur.rel, sz: st.size, mt: st.mtimeMs | 0 });
      }
    }
    say("Scan... " + all.length + " fichiers, " + seenDirs + " dossiers");
    if (dirs.length) return setTimeout(step, 0);
    all.sort(function (a, b) { return a.rel === b.rel ? a.n.localeCompare(b.n) : a.rel.localeCompare(b.rel); });
    saveIndex(r);
    after();
  }
  setTimeout(step, 0);
}

/* ------------------------- navigation / niveaux ------------------------ */

/* Contenu du niveau courant : sous-dossiers (agreges) + fichiers directs. */
function levelView() {
  var rel = curRel();
  var prefix = rel ? rel + "/" : "";
  var folders = {}, files = [];
  for (var i = 0; i < all.length; i++) {
    var it = all[i];
    if (kind !== "all" && it.k !== kind) continue;
    if (it.rel === rel) { files.push(it); continue; }
    if (it.rel.indexOf(prefix) === 0) {
      var seg = it.rel.slice(prefix.length).split("/")[0];
      folders[seg] = (folders[seg] || 0) + 1;
    }
  }
  var fl = Object.keys(folders).sort(function (a, b) { return a.localeCompare(b); })
    .map(function (n) { return { name: n, rel: prefix + n, count: folders[n] }; });
  return { folders: fl, files: files };
}

function searchView() {
  var terms = query.toLowerCase().trim().split(/\s+/);
  return all.filter(function (it) {
    if (kind !== "all" && it.k !== kind) return false;
    var hay = (it.rel + "/" + it.n).toLowerCase();
    for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
    return true;
  });
}

function crumb() {
  var c = $("#crumb");
  c.innerHTML = "";
  var searching = !!query.trim();
  $("#folders").classList.toggle("hidden", stack.length > 0 || searching);
  $("#back").classList.toggle("hidden", stack.length === 0 && !searching);

  if (searching) {
    var s = document.createElement("span");
    s.className = "seg last";
    s.textContent = "Resultats \u00AB " + query.trim() + " \u00BB";
    c.appendChild(s); return;
  }
  stack.forEach(function (seg, i) {
    var sep = document.createElement("span"); sep.className = "sep"; sep.textContent = SEP;
    c.appendChild(sep);
    var el = document.createElement("span");
    el.className = "seg" + (i === stack.length - 1 ? " last" : "");
    el.textContent = seg;
    if (i < stack.length - 1) el.addEventListener("click", function () { stack = stack.slice(0, i + 1); redraw(); });
    c.appendChild(el);
  });
}

/* ------------------------------- rendu --------------------------------- */

var io = null;

function redraw() {
  stopHoverPreview();
  crumb();
  var g = $("#grid");
  g.innerHTML = "";
  rendered = 0;
  if (io) io.disconnect();
  io = new IntersectionObserver(onVisible, { root: g, rootMargin: "280px" });

  var lv = query.trim() ? { folders: [], files: searchView() } : levelView();

  lv.folders.forEach(function (f) { g.appendChild(folderTile(f)); });

  view = lv.files;
  if (!lv.folders.length && !view.length) {
    var d = document.createElement("div");
    d.className = "empty";
    d.innerHTML = root
      ? "Rien ici." + (query.trim() ? "" : " Ce dossier ne contient pas de media reconnu.")
      : "Aucun dossier.<br>Clique sur <b>+</b> en haut pour en ajouter un.";
    g.appendChild(d);
  } else {
    renderMore();
  }
  countLine(lv);
}

function countLine(lv) {
  if (query.trim()) { say(view.length + " resultats pour \u00AB " + query.trim() + " \u00BB", "ok"); return; }
  var n = { audio: 0, video: 0, image: 0 };
  view.forEach(function (i) { n[i.k]++; });
  var f = lv.folders.length ? (lv.folders.length + " dossiers - ") : "";
  say(f + view.length + " fichiers - " + n.audio + " sons - " + n.video + " videos - " + n.image + " images", "ok");
}

function renderMore() {
  var g = $("#grid");
  var old = $("#more"); if (old) old.remove();
  var end = Math.min(rendered + PAGE, view.length);
  var frag = document.createDocumentFragment(), fresh = [];
  for (var i = rendered; i < end; i++) { var t = tile(view[i]); fresh.push(t); frag.appendChild(t); }
  g.appendChild(frag);
  rendered = end;
  if (rendered < view.length) {
    var more = document.createElement("div"); more.id = "more";
    more.textContent = "..." + (view.length - rendered) + " de plus";
    g.appendChild(more); io.observe(more);
  }
  for (var j = 0; j < fresh.length; j++) io.observe(fresh[j]);
}

function onVisible(entries) {
  entries.forEach(function (en) {
    if (!en.isIntersecting) return;
    if (en.target.id === "more") { io.unobserve(en.target); return renderMore(); }
    io.unobserve(en.target);
    thumb(en.target);
  });
}

function folderTile(f) {
  var el = document.createElement("div");
  el.className = "folder";
  el.innerHTML = '<span class="fi">\uD83D\uDCC1</span>';
  var nm = document.createElement("span"); nm.className = "fn"; nm.textContent = f.name;
  var ct = document.createElement("span"); ct.className = "fc"; ct.textContent = f.count;
  el.appendChild(nm); el.appendChild(ct);
  el.title = f.name + " - " + f.count + " elements";
  el.addEventListener("click", function () { stack = f.rel.split("/"); redraw(); });
  return el;
}

function tile(it) {
  var el = document.createElement("div");
  el.className = "tile";
  el.title = it.p + "\n" + human(it.sz);
  el._it = it;
  el.setAttribute("draggable", "true");

  var th = document.createElement("div"); th.className = "th";
  var gl = document.createElement("div"); gl.className = "glyph"; gl.textContent = GLYPH[it.k]; th.appendChild(gl);
  var add = document.createElement("div"); add.className = "add"; add.textContent = "+"; add.title = "Importer dans Premiere"; th.appendChild(add);
  var dur = document.createElement("div"); dur.className = "dur"; th.appendChild(dur);
  var nm = document.createElement("div"); nm.className = "nm"; nm.textContent = it.n;
  el.appendChild(th); el.appendChild(nm);

  // GLISSER vers Premiere (cle CEP) -- geste principal, comme Mister Horse.
  el.addEventListener("dragstart", function (ev) {
    try {
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("com.adobe.cep.dnd.file.0", it.p);
      ev.dataTransfer.setData("text/uri-list", fileUrl(it.p));
      ev.dataTransfer.setData("text/plain", it.p);
      ev.dataTransfer.setDragImage(el, 40, 24);
    } catch (e) {}
    say("Glisse \u00AB " + it.n + " \u00BB sur la timeline...");
  });

  add.addEventListener("click", function (ev) { ev.stopPropagation(); doImport(it); });
  el.addEventListener("click", function () { preview(el, it); });
  el.addEventListener("dblclick", function () { doImport(it); });

  if (it.k === "audio") {
    el.addEventListener("mouseenter", function () {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () { if (el.matches(":hover")) playAudio(el, it, true); }, HOVER_MS);
    });
    el.addEventListener("mouseleave", function () { clearTimeout(hoverTimer); if (el._hoverPlay) stopAudio(); });
  }
  if (it.k === "video") {
    el.addEventListener("mouseenter", function () { hoverSprite(el, it); });
    el.addEventListener("mouseleave", function () {
      th.classList.remove("sprite"); th.style.backgroundSize = "cover"; th.style.backgroundPosition = "center";
      if (el.dataset.poster) th.style.backgroundImage = "url(" + el.dataset.poster + ")";
    });
  }
  return el;
}

/* ------------------------------ vignettes ------------------------------ */

function setBg(el, url, sprite) {
  var th = el.querySelector(".th");
  th.style.backgroundImage = "url(" + url + ")";
  th.classList.toggle("sprite", !!sprite);
  var g = th.querySelector(".glyph"); if (g) g.style.display = "none";
}
function setDur(el, s) { var d = el.querySelector(".dur"); if (d) d.textContent = clock(s); }

function probeDur(it, cb) {
  if (meta[it.p] && meta[it.p].dur != null) return cb(meta[it.p].dur);
  run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", it.p],
    function (err, out) {
      var d = err ? null : parseFloat(String(out).trim());
      if (!isFinite(d)) d = null;
      meta[it.p] = meta[it.p] || {}; meta[it.p].dur = d; cb(d);
    });
}

function thumb(el) {
  var it = el._it; if (!it || !CACHE || !nodeReq) return;
  var key = keyOf(it);

  if (it.k === "image") {
    if (WEB_IMAGE[it.e] && it.sz < 6 * 1024 * 1024) return setBg(el, fileUrl(it.p));
    var out = cachePath("th", key, ".jpg");
    if (fs.existsSync(out)) return setBg(el, fileUrl(out));
    run(FFMPEG, ["-v", "error", "-i", it.p, "-frames:v", "1", "-vf",
      "scale=320:200:force_original_aspect_ratio=increase,crop=320:200", "-q:v", "4", "-y", out],
      function (err) { if (!err && fs.existsSync(out)) setBg(el, fileUrl(out)); });
    return;
  }
  if (it.k === "audio") {
    var wf = cachePath("wf", key, ".png");
    probeDur(it, function (d) { setDur(el, d); });
    if (fs.existsSync(wf)) return setBg(el, fileUrl(wf));
    run(FFMPEG, ["-v", "error", "-i", it.p, "-filter_complex",
      "aformat=channel_layouts=mono,showwavespic=s=320x200:colors=#3E8FE0", "-frames:v", "1", "-y", wf],
      function (err) { if (!err && fs.existsSync(wf)) setBg(el, fileUrl(wf)); });
    return;
  }
  var po = cachePath("th", key, ".jpg");
  probeDur(it, function (d) {
    setDur(el, d);
    if (fs.existsSync(po)) { el.dataset.poster = fileUrl(po); return setBg(el, fileUrl(po)); }
    var at = (d && d > 3) ? Math.min(d * 0.15, 20) : 0;
    run(FFMPEG, ["-v", "error", "-ss", String(at.toFixed(2)), "-i", it.p, "-frames:v", "1", "-vf",
      "scale=320:200:force_original_aspect_ratio=increase,crop=320:200", "-q:v", "4", "-y", po],
      function (err) { if (!err && fs.existsSync(po)) { el.dataset.poster = fileUrl(po); setBg(el, fileUrl(po)); } });
  });
}

var CELL = "scale=160:100:force_original_aspect_ratio=increase,crop=160:100";

function spriteArgs(file, dur, out) {
  if (dur <= 45) {
    return ["-v", "error", "-i", file, "-vf",
      "fps=" + (SPRITE_N / dur).toFixed(6) + "," + CELL + ",tile=" + SPRITE_N + "x1",
      "-frames:v", "1", "-q:v", "5", "-y", out];
  }
  var args = ["-v", "error"], fc = [], names = "";
  for (var i = 0; i < SPRITE_N; i++) {
    args.push("-ss", (dur * (i + 0.5) / SPRITE_N).toFixed(3), "-i", file);
    fc.push("[" + i + ":v]" + CELL + ",setsar=1[v" + i + "]");
    names += "[v" + i + "]";
  }
  fc.push(names + "hstack=inputs=" + SPRITE_N + "[o]");
  return args.concat(["-filter_complex", fc.join(";"), "-map", "[o]", "-frames:v", "1", "-q:v", "5", "-y", out]);
}

function hoverSprite(el, it) {
  if (!CACHE || !nodeReq) return;
  var th = el.querySelector(".th"), key = keyOf(it), sp = cachePath("sp", key, ".jpg");
  function attach() {
    th.style.backgroundImage = "url(" + fileUrl(sp) + ")";
    th.style.backgroundSize = (SPRITE_N * 100) + "% 100%";
    th.classList.add("sprite");
    var g = th.querySelector(".glyph"); if (g) g.style.display = "none";
    if (th._scrub) return;
    th._scrub = function (ev) {
      var r = th.getBoundingClientRect();
      var f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      var i = Math.min(SPRITE_N - 1, Math.floor(f * SPRITE_N));
      th.style.backgroundPosition = (i / (SPRITE_N - 1) * 100) + "% 50%";
    };
    th.addEventListener("mousemove", th._scrub);
  }
  if (fs.existsSync(sp)) return attach();
  if (el.dataset.spriteBusy) return;
  el.dataset.spriteBusy = "1";
  probeDur(it, function (d) {
    if (!d || d < 0.5) { el.dataset.spriteBusy = ""; return; }
    run(FFMPEG, spriteArgs(it.p, d, sp), function (err) {
      el.dataset.spriteBusy = "";
      if (!err && fs.existsSync(sp) && el.matches(":hover")) attach();
    });
  });
}

/* ------------------------------- preview ------------------------------- */

function stopAudio() {
  try { audio.pause(); } catch (e) {}
  if (playingTile) {
    var b = playingTile.querySelector(".pos"); if (b) b.remove();
    playingTile.classList.remove("playing"); playingTile._hoverPlay = false; playingTile = null;
  }
}
function stopHoverPreview() { clearTimeout(hoverTimer); if (playingTile && playingTile._hoverPlay) stopAudio(); }

audio.addEventListener("timeupdate", function () {
  if (!playingTile || !audio.duration) return;
  var b = playingTile.querySelector(".pos"); if (b) b.style.width = (audio.currentTime / audio.duration * 100) + "%";
});
audio.addEventListener("ended", stopAudio);

function playAudio(el, it, hover) {
  if (playingTile === el && !hover) return stopAudio();
  stopAudio();
  playingTile = el; el._hoverPlay = !!hover;
  el.classList.add("playing");
  var b = document.createElement("div"); b.className = "pos"; el.querySelector(".th").appendChild(b);
  audio.volume = (+$("#vol").value) / 100;
  function start(src) { audio.src = src; audio.play().catch(function () {}); }
  if (WEB_AUDIO[it.e]) { audio.onerror = function () { transcode(); }; start(fileUrl(it.p)); }
  else transcode();
  function transcode() {
    audio.onerror = null;
    var pv = cachePath("pv", keyOf(it), ".mp3");
    if (fs.existsSync(pv)) return start(fileUrl(pv));
    if (hover) return;   // pas de conversion lourde juste au survol
    say("Conversion pour l'ecoute (" + it.e + ")...");
    run(FFMPEG, ["-v", "error", "-i", it.p, "-vn", "-ac", "2", "-b:a", "192k", "-y", pv],
      function (err) { if (!err && fs.existsSync(pv) && playingTile === el) start(fileUrl(pv)); });
  }
}

var viewerItem = null;

function openViewer(it) {
  viewerItem = it;
  var body = $("#vbody"); body.innerHTML = "";
  $("#vname").textContent = it.p;
  $("#viewer").classList.add("on");
  if (it.k === "image") {
    if (WEB_IMAGE[it.e]) { var img = document.createElement("img"); img.src = fileUrl(it.p); body.appendChild(img); }
    else {
      var big = cachePath("big", keyOf(it), ".jpg"), im2 = document.createElement("img"); body.appendChild(im2);
      if (fs.existsSync(big)) im2.src = fileUrl(big);
      else run(FFMPEG, ["-v", "error", "-i", it.p, "-frames:v", "1", "-vf", "scale='min(1600,iw)':-1", "-q:v", "3", "-y", big],
        function (err) {
          if (!err && fs.existsSync(big)) im2.src = fileUrl(big);
          else body.innerHTML = '<div class="vmsg">Apercu impossible pour ce format (' + it.e + ').<br>Le fichier reste importable.</div>';
        });
    }
    return;
  }
  if (it.k === "video") {
    if (WEB_VIDEO[it.e]) {
      var v = document.createElement("video");
      v.src = fileUrl(it.p); v.controls = true; v.autoplay = true; v.loop = true; v.volume = (+$("#vol").value) / 100;
      v.onerror = function () { body.innerHTML = '<div class="vmsg">Codec non lisible par Chromium.<br>Survole la vignette pour scruber, ou glisse-le sur la timeline.</div>'; };
      body.appendChild(v);
    } else body.innerHTML = '<div class="vmsg">Format conteneur non lisible ici (' + it.e + ').<br>Survole la vignette pour scruber les images.</div>';
  }
}
function closeViewer() {
  var v = $("#vbody").querySelector("video"); if (v) { try { v.pause(); } catch (e) {} }
  $("#vbody").innerHTML = ""; $("#viewer").classList.remove("on"); viewerItem = null;
}
function preview(el, it) {
  if (it.k === "audio") return playAudio(el, it, false);
  stopAudio(); openViewer(it);
}

/* -------------------------------- import ------------------------------- */

function doImport(it) {
  var bin = root ? path.basename(root) : "Mudkit";
  say("Import de " + it.n + "...");
  evalScript("mudkitLibImport(" + JSON.stringify(it.p) + "," + JSON.stringify(action) + "," + JSON.stringify(bin) + ")")
    .then(function (res) {
      if (res === "inserted") say(CHECK + " " + it.n + " pose sur la timeline", "ok");
      else if (res === "imported") say(CHECK + " " + it.n + " dans le chutier \u00AB " + bin + " \u00BB", "ok");
      else if (res === "imported_no_seq") say(CHECK + " Importe (aucune sequence active)", "ok");
      else if (res && res.indexOf("imported_insert_failed") === 0) say("Importe, insertion impossible : " + res.split(":").slice(1).join(":"), "err");
      else say("Import echoue : " + res, "err");
    });
}

/* -------------------------------- racines ------------------------------ */

function saveRoots() { lsSet("mudkit.lib.roots", JSON.stringify(roots)); }

function fillRoots() {
  var sel = $("#folders"); sel.innerHTML = "";
  if (!roots.length) { sel.innerHTML = '<option value="">Aucun dossier</option>'; return; }
  roots.forEach(function (f) {
    var o = document.createElement("option"); o.value = f;
    o.textContent = (path.basename(f) || f); o.title = f;
    if (f === root) o.selected = true; sel.appendChild(o);
  });
}

function openRoot(r, forceRescan) {
  stopHoverPreview();
  root = r; stack = [];
  lsSet("mudkit.lib.current", r);
  fillRoots();
  token++; queue.length = 0; meta = {};
  if (!r) { all = []; return redraw(); }
  if (!fs.existsSync(r)) { all = []; redraw(); return say("Dossier introuvable : " + r, "err"); }
  var cached = forceRescan ? null : loadIndex(r);
  if (cached) {
    all = cached.items; meta = cached.meta || {}; redraw();
    var age = Math.round((Date.now() - cached.ts) / 60000);
    say(all.length + " elements (cache, " + (age < 60 ? age + " min" : Math.round(age / 60) + " h") + ") - rescan avec le bouton tournant");
    return;
  }
  all = []; $("#grid").innerHTML = '<div class="empty">Scan en cours...</div>'; say("Scan de " + r + "...");
  scan(r, function () { redraw(); });
}

function pickFolder() {
  if (!window.cep || !window.cep.fs || !window.cep.fs.showOpenDialog)
    return say("Selecteur de dossier indisponible (CEP).", "err");
  var res = window.cep.fs.showOpenDialog(false, true, "Dossier de medias", root || "", []);
  var p = res && res.data && res.data[0]; if (!p) return;
  p = p.replace(/\//g, "\\").replace(/\\+$/, "");
  if (roots.indexOf(p) < 0) { roots.unshift(p); saveRoots(); }
  openRoot(p, false);
}

/* -------------------------------- cablage ------------------------------ */

document.querySelectorAll("#kinds button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#kinds button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on"); kind = b.dataset.k; lsSet("mudkit.lib.kind", kind); redraw();
  });
});
document.querySelectorAll("#libact button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#libact button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on"); action = b.dataset.v; lsSet("mudkit.lib.action", action);
  });
});

var qTimer = null;
$("#q").addEventListener("input", function (e) { query = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(redraw, 170); });

$("#back").addEventListener("click", function () {
  if (query.trim()) { query = ""; $("#q").value = ""; return redraw(); }
  if (stack.length) { stack.pop(); redraw(); }
});
$("#pick").addEventListener("click", pickFolder);
$("#forget").addEventListener("click", function () {
  if (!root) return;
  var i = roots.indexOf(root); if (i >= 0) roots.splice(i, 1); saveRoots();
  openRoot(roots[0] || "", false);
});
$("#rescan").addEventListener("click", function () { if (root) openRoot(root, true); });
$("#folders").addEventListener("change", function (e) { if (e.target.value) openRoot(e.target.value, false); });
$("#viewmode").addEventListener("click", function () {
  listView = !listView; $("#grid").classList.toggle("list", listView);
  lsSet("mudkit.lib.view", listView ? "list" : "grid");
});
$("#vol").addEventListener("input", function (e) {
  audio.volume = (+e.target.value) / 100;
  var v = $("#vbody").querySelector("video"); if (v) v.volume = audio.volume;
  lsSet("mudkit.lib.vol", e.target.value);
});
$("#vclose").addEventListener("click", closeViewer);
$("#vadd").addEventListener("click", function () { if (viewerItem) doImport(viewerItem); });

/* overlay telechargement */
$("#dl").addEventListener("click", function () { $("#dloverlay").classList.add("on"); var u = $("#url"); if (u) u.focus(); });
$("#dlclose").addEventListener("click", function () { $("#dloverlay").classList.remove("on"); });
$("#dloverlay").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("on"); });

document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  if ($("#dloverlay").classList.contains("on")) return $("#dloverlay").classList.remove("on");
  if ($("#viewer").classList.contains("on")) return closeViewer();
  stopAudio();
});

/* ------------------------------ demarrage ------------------------------ */

if (!nodeReq) {
  say("Node est desactive dans ce panneau - le gestionnaire ne peut pas lire le disque.", "err");
} else {
  try { roots = JSON.parse(ls("mudkit.lib.roots", "[]")) || []; } catch (e) { roots = []; }
  kind = ls("mudkit.lib.kind", "all");
  action = ls("mudkit.lib.action", "insert");
  listView = ls("mudkit.lib.view", "grid") === "list";
  $("#vol").value = ls("mudkit.lib.vol", "70"); audio.volume = (+$("#vol").value) / 100;
  $("#grid").classList.toggle("list", listView);
  document.querySelectorAll("#kinds button").forEach(function (b) { b.classList.toggle("on", b.dataset.k === kind); });
  document.querySelectorAll("#libact button").forEach(function (b) { b.classList.toggle("on", b.dataset.v === action); });
  mkdirp(CACHE);
  fillRoots();
  var last = ls("mudkit.lib.current", "");
  if (last && roots.indexOf(last) >= 0) openRoot(last, false);
  else if (roots.length) openRoot(roots[0], false);
  else redraw();
}

})();
