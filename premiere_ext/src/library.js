/* Gestionnaire de medias local du panneau Mudkit.

   Remplace la User Library de Mister Horse (plan gratuit plafonne a 500 items)
   et en reprend l'ergonomie : arborescence de dossiers persistante a gauche,
   grille de vignettes a droite, favoris, slider de taille, splitter, et
   glisser-deposer natif vers la timeline Premiere.

   Plusieurs dossiers racine peuvent etre montes en meme temps : chacun devient
   une categorie de premier niveau dans l'arbre (equivalent d'un "pack").

   Aucune limite d'elements : tout est lu en local, rien n'appelle de serveur.
   Volontairement en ASCII (les accents dans ce panneau = ennuis). */
"use strict";

(function () {

var nodeReq = (window.cep_node && window.cep_node.require)
  ? window.cep_node.require
  : (typeof require !== "undefined" ? require : null);

var fs, path, os, crypto, spawn;
if (nodeReq) {
  fs = nodeReq("fs"); path = nodeReq("path"); os = nodeReq("os");
  crypto = nodeReq("crypto"); spawn = nodeReq("child_process").spawn;
}

var MUDKIT = "C:\\Users\\Rayan\\Mudkit";
var FFMPEG = MUDKIT + "\\bin\\ffmpeg.exe";
var FFPROBE = MUDKIT + "\\bin\\ffprobe.exe";
var LOCALAPP = (typeof process !== "undefined" && process.env && process.env.LOCALAPPDATA)
  ? process.env.LOCALAPPDATA
  : (os ? os.homedir() + "\\AppData\\Local" : null);
var CACHE = LOCALAPP ? LOCALAPP + "\\Mudkit\\lib-cache" : null;

var MAX_DEPTH = 12;
var PAGE = 150;
var SPRITE_N = 24;
var SKIP_DIRS = { "node_modules":1, "$recycle.bin":1, ".git":1,
                  "system volume information":1, ".cache":1 };

/* Mister Horse depose ses apercus dans un dossier "_Mister Horse Previews"
   place dans le dossier ajoute a sa User Library, et qui reproduit toute
   l'arborescence en dessous. Convention observee sur une vraie bibliotheque :
     <nom complet du fichier source> + .webp | .jpg | .png
     mp3/wav -> .png  320x180  (forme d'onde)
     jpg/png/gif/mogrt -> .webp/.jpg  320x180 (image fixe)
     mp4 -> .webp  320x1800  (sprite VERTICAL de 10 images)
     mov/wmv -> .webp anime
   On ne les compte donc PAS comme des medias (sinon des milliers de faux
   items), et on les REUTILISE comme vignettes : autant de ffmpeg economise. */
var MH_DIR_RE = /^_mister horse previews$/i;
var MH_EXT_RE = /\.(webp|jpg|png)$/i;

var EXT = {};
"mp3 wav flac m4a aac ogg opus aif aiff wma mka".split(" ").forEach(function (e) { EXT[e] = "audio"; });
"mp4 mov mkv avi webm mxf m4v wmv mpg mpeg mts m2ts flv ts r3d braw".split(" ").forEach(function (e) { EXT[e] = "video"; });
"jpg jpeg png gif webp bmp tif tiff avif heic heif svg tga dpx exr psd".split(" ").forEach(function (e) { EXT[e] = "image"; });
EXT["mogrt"] = "mogrt";   // Motion Graphics Template : va sur la timeline via importMGT

var WEB_AUDIO = { mp3:1, wav:1, flac:1, m4a:1, aac:1, ogg:1, opus:1, mka:1 };
var WEB_IMAGE = { jpg:1, jpeg:1, png:1, gif:1, webp:1, bmp:1, svg:1, avif:1 };
var WEB_VIDEO = { mp4:1, m4v:1, mov:1, webm:1 };

/* Icones en SVG inline plutot qu'en caracteres Unicode : selon la police
   installee, des glyphes comme U+25A2 ou U+FF0B ne sont pas couverts et
   Chromium affiche un carre vide ("tofu"). En SVG c'est garanti, ca suit
   currentColor donc le theme, et ca reste net a toutes les tailles. */
var S = '<svg class="ic" viewBox="0 0 16 16">';
var ICO = {
  audio:  S + '<path d="M6.4 11V4.2l5.2-1.1v6.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="4.9" cy="11.2" r="1.7" fill="currentColor"/><circle cx="10.1" cy="9.9" r="1.7" fill="currentColor"/></svg>',
  video:  S + '<path d="M5.2 3.4l7.2 4.6-7.2 4.6z" fill="currentColor"/></svg>',
  image:  S + '<rect x="2" y="3.2" width="12" height="9.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.5" cy="6.4" r="1.1" fill="currentColor"/><path d="M2.6 11.6l3.3-3.1 2.4 2.1 2.3-2.1 2.8 3.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  mogrt:  S + '<path d="M8 2.3l5.7 5.7L8 13.7 2.3 8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 5.5L10.5 8 8 10.5 5.5 8z" fill="currentColor"/></svg>',
  chev:   S + '<path d="M6.2 4.4L9.8 8l-3.6 3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: S + '<path d="M1.9 4h4l1.1 1.5h7.1v6.6H1.9z" fill="currentColor"/></svg>',
  star:   S + '<path d="M8 2.2l1.75 3.54 3.91.57-2.83 2.76.67 3.89L8 11.13l-3.5 1.83.67-3.89L2.34 6.31l3.91-.57z" fill="currentColor"/></svg>',
  plus:   S + '<path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
};
var CHECK  = "OK";

/* --------------------------------- etat -------------------------------- */

var libs = [];          // [{ root, items:[...], meta:{} }]
var all = [];           // concat des items, chacun avec .lib
var favs = {};          // chemin -> 1
var open = {};          // cle de noeud -> ouvert
var sel = "";           // cle du noeud selectionne ("" = tout)
var view = [];
var rendered = 0;
var query = "";
var favOnly = false;
var kind = "all";
var action = "insert";
var tileW = 116;
var token = 0;

var audio = new Audio();
var playingTile = null;
var selTile = null;

/* -------------------------------- helpers ------------------------------ */

function $(s) { return document.querySelector(s); }
function ls(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function md5(s) { return crypto.createHash("md5").update(s, "utf8").digest("hex"); }
function ext(p) { var i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i + 1).toLowerCase(); }
function mkdirp(p) { try { fs.mkdirSync(p, { recursive:true }); } catch (e) {} }
function base(p) { return p.replace(/[\\\/]+$/, "").split(/[\\\/]/).pop() || p; }

function fileUrl(p) {
  return "file:///" + encodeURI(p.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F");
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
function say(msg, cls) { var el = $("#libstatus"); el.textContent = msg; el.className = "msg " + (cls || ""); }

function evalScript(script) {
  return new Promise(function (resolve) {
    if (window.__adobe_cep__) window.__adobe_cep__.evalScript(script, resolve);
    else resolve("err:pas dans Premiere");
  });
}

/* --------------------------- file d'attente ffmpeg --------------------- */

/* 8 jobs en parallele : la bibliotheque est massivement audio (41k fichiers)
   et Mister Horse n'avait genere que 22 formes d'onde, donc c'est nous qui
   produisons les 41 000 autres. La machine a 12 coeurs. */
var queue = [], busy = 0, MAXJOBS = 8;

/* token = "epoque" globale. Elle n'avance QUE sur une invalidation volontaire
   (rescan, demontage) -- surtout pas a chaque scan, sinon monter deux dossiers
   en parallele ferait avorter le premier scan (et refreshAfterMount ne serait
   jamais appele). Chaque scan compare l'epoque capturee au demarrage. */
function invalidate() { token++; queue.length = 0; }

/* opts.el   : tuile concernee -- si elle a quitte le DOM (defilement, filtre,
                changement de dossier), le job est abandonne au lieu de bloquer
                la file derriere des vignettes que plus personne ne regarde.
   opts.first : passe devant. Les vignettes demandees en dernier sont celles
                qui viennent d'entrer a l'ecran, ce sont donc les urgentes. */
function run(exe, args, done, opts) {
  opts = opts || {};
  var job = { exe:exe, args:args, done:done, tok:token, el:opts.el };
  if (opts.first) queue.unshift(job); else queue.push(job);
  pump();
}
function pump() {
  while (busy < MAXJOBS && queue.length) {
    var job = queue.shift();
    if (job.tok !== token) continue;
    if (job.el && !job.el.isConnected) continue;   // tuile plus a l'ecran
    busy++;
    (function (j) {
      var out = "", err = "", p;
      try { p = spawn(j.exe, j.args, { windowsHide:true }); }
      catch (e) { busy--; j.done(String(e)); return pump(); }
      p.stdout.on("data", function (c) { out += c.toString(); });
      p.stderr.on("data", function (c) { err += c.toString(); });
      p.on("error", function (e) { busy--; j.done(String(e)); pump(); });
      p.on("close", function (c) { busy--; j.done(c === 0 ? null : (err.trim() || ("code " + c)), out); pump(); });
    })(job);
  }
}

/* --------------------------------- cache ------------------------------- */

function cachePath(sub, key, ex) { var d = CACHE + "\\" + sub; mkdirp(d); return d + "\\" + key + ex; }
function keyOf(it) { return md5(it.p + "|" + it.mt + "|" + it.sz); }
function indexFile(r) { mkdirp(CACHE); return CACHE + "\\idx-" + md5(r.toLowerCase()) + ".json"; }
function loadIndex(r) {
  try { var o = JSON.parse(fs.readFileSync(indexFile(r), "utf8")); if (o && o.v === 2 && o.items) return o; }
  catch (e) {}
  return null;
}
function saveIndex(lib) {
  try {
    fs.writeFileSync(indexFile(lib.root),
      JSON.stringify({ v:2, root:lib.root, ts:Date.now(), items:lib.items, meta:lib.meta, mh:lib.mh }));
  } catch (e) {}
}

/* ---------------------------------- scan ------------------------------- */

function scan(lib, after) {
  var mine = token;          // epoque capturee : PAS d'increment ici
  lib.items = [];
  lib.mh = {};               // cle "rel/nom.ext" en minuscules -> chemin d'apercu
  /* mh sur une entree de file = { base, sub } : on est DANS un dossier
     d'apercus Mister Horse ; base = rel du dossier qui le contient, sub = le
     chemin parcouru a l'interieur. Le media source est donc base/sub/<nom>. */
  var dirs = [{ d:lib.root, rel:"", lvl:0, mh:null }], seenDirs = 0, nPrev = 0;

  function step() {
    if (mine !== token) return;
    var budget = 60;
    while (dirs.length && budget-- > 0) {
      var cur = dirs.shift(); seenDirs++;
      var ents;
      try { ents = fs.readdirSync(cur.d, { withFileTypes:true }); } catch (e) { continue; }
      for (var i = 0; i < ents.length; i++) {
        var en = ents[i], nm = en.name;
        if (nm.charAt(0) === ".") continue;
        var full = cur.d + "\\" + nm;

        if (en.isDirectory()) {
          if (cur.lvl >= MAX_DEPTH || SKIP_DIRS[nm.toLowerCase()]) continue;
          var childRel = cur.rel ? cur.rel + "/" + nm : nm;
          if (cur.mh) {
            dirs.push({ d:full, rel:childRel, lvl:cur.lvl + 1,
                        mh:{ base:cur.mh.base, sub: cur.mh.sub ? cur.mh.sub + "/" + nm : nm } });
          } else if (MH_DIR_RE.test(nm)) {
            dirs.push({ d:full, rel:cur.rel, lvl:cur.lvl + 1, mh:{ base:cur.rel, sub:"" } });
          } else {
            dirs.push({ d:full, rel:childRel, lvl:cur.lvl + 1, mh:null });
          }
          continue;
        }

        if (cur.mh) {                       // fichier d'apercu, pas un media
          if (!MH_EXT_RE.test(nm)) continue;
          var srcName = nm.replace(MH_EXT_RE, "");
          var k2 = [cur.mh.base, cur.mh.sub, srcName].filter(Boolean).join("/").toLowerCase();
          lib.mh[k2] = full; nPrev++;
          continue;
        }

        var e = ext(nm), k = EXT[e];
        if (!k) continue;
        var st; try { st = fs.statSync(full); } catch (er) { continue; }
        lib.items.push({ p:full, n:nm, e:e, k:k, rel:cur.rel, sz:st.size, mt:st.mtimeMs | 0 });
      }
    }
    say("Scan... " + lib.items.length + " fichiers, " + seenDirs + " dossiers" +
        (nPrev ? " (" + nPrev + " apercus Mister Horse reutilisables)" : ""));
    if (dirs.length) return setTimeout(step, 0);
    lib.items.sort(function (a, b) { return a.rel === b.rel ? a.n.localeCompare(b.n) : a.rel.localeCompare(b.rel); });
    saveIndex(lib);
    after();
  }
  setTimeout(step, 0);
}

/* Apercu deja produit par Mister Horse pour cet item, ou null. */
function mhPreview(it) {
  var lib = libs[it.lib];
  if (!lib || !lib.mh) return null;
  return lib.mh[((it.rel ? it.rel + "/" : "") + it.n).toLowerCase()] || null;
}

/* ------------------------------- arborescence -------------------------- */

function rebuildAll() {
  invalidateTree();
  all = [];
  libs.forEach(function (lib, li) {
    lib.items.forEach(function (it) { it.lib = li; all.push(it); });
  });
}

function nodeKey(li, rel) { return rel ? li + ":" + rel : String(li); }

var treeCache = null;
function invalidateTree() { treeCache = null; }

function buildTree() {
  if (treeCache) return treeCache;          // 33 ms sur 43k items : on garde
  treeCache = libs.map(function (lib, li) {
    var rootNode = { name:base(lib.root), key:String(li), lib:li, rel:"", kids:{}, count:0, isRoot:true };
    lib.items.forEach(function (it) {
      rootNode.count++;
      if (!it.rel) return;
      var parts = it.rel.split("/"), cur = rootNode, acc = "";
      for (var i = 0; i < parts.length; i++) {
        acc = acc ? acc + "/" + parts[i] : parts[i];
        if (!cur.kids[parts[i]]) cur.kids[parts[i]] = { name:parts[i], key:nodeKey(li, acc), lib:li, rel:acc, kids:{}, count:0 };
        cur = cur.kids[parts[i]];
        cur.count++;
      }
    });
    return rootNode;
  });
  return treeCache;
}

function renderTree() {
  var t = $("#tree");
  t.innerHTML = "";
  if (!libs.length) return;
  buildTree().forEach(function (n) { renderNode(t, n, 0); });
}

function renderNode(host, n, depth) {
  var kids = Object.keys(n.kids).sort(function (a, b) { return a.localeCompare(b); });
  var row = document.createElement("div");
  row.className = "node" + (n.isRoot ? " root" : "") + (sel === n.key ? " sel" : "");
  row.style.paddingLeft = (6 + depth * 11) + "px";
  row.title = n.name + " - " + n.count + " elements";

  var tw = document.createElement("span");
  tw.className = "tw" + (kids.length ? (open[n.key] ? " open" : "") : " leaf");
  tw.innerHTML = ICO.chev;
  row.appendChild(tw);

  var ic = document.createElement("span"); ic.className = "fic"; ic.innerHTML = ICO.folder; row.appendChild(ic);
  var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = n.name; row.appendChild(nm);
  var ct = document.createElement("span"); ct.className = "ct"; ct.textContent = n.count; row.appendChild(ct);

  tw.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (!kids.length) return;
    open[n.key] = !open[n.key];
    lsSet("mudkit.lib.open", JSON.stringify(open));
    renderTree();
  });
  row.addEventListener("click", function () {
    sel = n.key;
    if (kids.length && !open[n.key]) { open[n.key] = true; lsSet("mudkit.lib.open", JSON.stringify(open)); }
    lsSet("mudkit.lib.sel", sel);
    renderTree(); redraw();
  });
  host.appendChild(row);

  if (kids.length && open[n.key])
    kids.forEach(function (k) { renderNode(host, n.kids[k], depth + 1); });
}

/* Le noeud selectionne montre TOUT son sous-arbre (comme Mister Horse). */
function inSelection(it) {
  if (!sel) return true;
  var c = sel.split(":"), li = +c[0], rel = c[1] || "";
  if (it.lib !== li) return false;
  if (!rel) return true;
  return it.rel === rel || it.rel.indexOf(rel + "/") === 0;
}

function computeView() {
  var terms = query.trim() ? query.toLowerCase().trim().split(/\s+/) : null;
  return all.filter(function (it) {
    if (kind !== "all" && it.k !== kind) return false;
    if (favOnly && !favs[it.p]) return false;
    if (terms) {
      var hay = (it.rel + "/" + it.n).toLowerCase();
      for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
      return true;                       // la recherche ignore la selection
    }
    return inSelection(it);
  });
}

/* --------------------------------- rendu ------------------------------- */

var io = null;

function redraw() {
  stopAudio();
  var g = $("#grid");
  g.innerHTML = ""; rendered = 0; selTile = null;
  if (io) io.disconnect();
  io = new IntersectionObserver(onVisible, { root:g, rootMargin:"300px" });

  view = computeView();

  if (!view.length) {
    var d = document.createElement("div"); d.className = "empty";
    d.innerHTML = !libs.length
      ? "Aucun dossier monte.<br>Clique sur <b>+</b> en haut a droite pour en ajouter un."
      : (favOnly ? "Aucun favori ici." : "Rien a afficher.");
    g.appendChild(d);
  } else renderMore();

  countLine();
}

function countLine() {
  var n = { audio:0, video:0, image:0, mogrt:0 };
  view.forEach(function (i) { n[i.k]++; });
  var where = query.trim() ? "\u00AB " + query.trim() + " \u00BB" : (sel ? "" : "tout");
  say(view.length + " elements " + (where ? where + " " : "") +
      "- " + n.audio + " sons, " + n.video + " videos, " + n.image + " images" +
      (n.mogrt ? ", " + n.mogrt + " mogrt" : ""), "ok");
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
    more.textContent = "... " + (view.length - rendered) + " de plus";
    g.appendChild(more); io.observe(more);
  }
  for (var j = 0; j < fresh.length; j++) io.observe(fresh[j]);
}

function onVisible(entries) {
  entries.forEach(function (en) {
    if (!en.isIntersecting) return;
    if (en.target.id === "more") { io.unobserve(en.target); return renderMore(); }
    io.unobserve(en.target); thumb(en.target);
  });
}

function tile(it) {
  var el = document.createElement("div");
  el.className = "tile";
  el.title = it.p + "\n" + human(it.sz);
  el._it = it;
  el.setAttribute("draggable", "true");

  var th = document.createElement("div"); th.className = "th";
  var gl = document.createElement("div"); gl.className = "glyph"; gl.innerHTML = ICO[it.k] || ""; th.appendChild(gl);
  var add = document.createElement("div"); add.className = "add"; add.innerHTML = ICO.plus; add.title = "Importer"; th.appendChild(add);
  var dur = document.createElement("div"); dur.className = "dur"; th.appendChild(dur);

  var meta = document.createElement("div"); meta.className = "meta";
  var bd = document.createElement("span"); bd.className = "badge " + it.k; bd.innerHTML = ICO[it.k] || "";
  var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = it.n.replace(/\.[^.]+$/, "");
  var fv = document.createElement("span"); fv.className = "fav" + (favs[it.p] ? " on" : ""); fv.innerHTML = ICO.star;
  fv.title = "Favori";
  meta.appendChild(bd); meta.appendChild(nm); meta.appendChild(fv);

  el.appendChild(th); el.appendChild(meta);

  // Glisser vers la timeline : cle CEP officielle.
  el.addEventListener("dragstart", function (ev) {
    try {
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("com.adobe.cep.dnd.file.0", it.p);
      ev.dataTransfer.setData("text/uri-list", fileUrl(it.p));
      ev.dataTransfer.setData("text/plain", it.p);
      ev.dataTransfer.setDragImage(el, 40, 22);
    } catch (e) {}
    say("Glisse \u00AB " + it.n + " \u00BB sur la timeline...");
  });

  fv.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (favs[it.p]) delete favs[it.p]; else favs[it.p] = 1;
    fv.classList.toggle("on", !!favs[it.p]);
    lsSet("mudkit.lib.favs", JSON.stringify(Object.keys(favs)));
    if (favOnly) redraw();
  });
  add.addEventListener("click", function (ev) { ev.stopPropagation(); doImport(it); });
  el.addEventListener("click", function () { selectTile(el); preview(el, it); });
  el.addEventListener("dblclick", function () { doImport(it); });

  if (it.k === "video") {
    el.addEventListener("mouseenter", function () {
      if (el.dataset.vsprite) return attachVSprite(el);   // sprite Mister Horse
      hoverSprite(el, it);                                // sinon on le fabrique
    });
    el.addEventListener("mouseleave", function () {
      if (el.dataset.vsprite) { th.style.backgroundPosition = "50% 0%"; return; }
      th.classList.remove("sprite"); th.style.backgroundSize = "cover"; th.style.backgroundPosition = "center";
      if (el.dataset.poster) th.style.backgroundImage = "url(" + el.dataset.poster + ")";
    });
  }
  return el;
}

/* ------------------------------- vignettes ----------------------------- */

function setBg(el, url) {
  var th = el.querySelector(".th");
  th.style.backgroundImage = "url(" + url + ")";
  var g = th.querySelector(".glyph"); if (g) g.style.display = "none";
}
function setDur(el, s) { var d = el.querySelector(".dur"); if (d) d.textContent = clock(s); }

function metaOf(it) {
  var lib = libs[it.lib]; if (!lib) return {};
  lib.meta[it.p] = lib.meta[it.p] || {};
  return lib.meta[it.p];
}

/* Une seule sonde ffprobe donne la duree ET la presence d'une piste video.
   Indispensable : la bibliotheque contient des .mp4/.mov qui ne sont QUE de
   l'audio (musique dans un conteneur video, typiquement dans 03_MUSIQUE).
   Tenter d'en extraire une image echoue avec "Output file does not contain
   any stream" et laisse une vignette vide -- le fameux carre. */
function probeInfo(it, cb) {
  var m = metaOf(it);
  if (m.vid !== undefined) return cb(m);
  run(FFPROBE, ["-v","error","-show_entries","format=duration:stream=codec_type",
                "-of","default=nw=1:nk=1", it.p], 
    function (err, out) {
      var toks = String(out || "").trim().split(/\s+/);
      var d = null, hasVid = false;
      for (var i = 0; i < toks.length; i++) {
        if (toks[i] === "video") { hasVid = true; continue; }
        var f = parseFloat(toks[i]);
        if (isFinite(f)) d = f;
      }
      m.dur = d; m.vid = hasVid;
      cb(m);
    });
}

/* Un fichier classe "video" mais sans image est en realite un son : on le
   requalifie, on l'affiche comme tel, et on memorise la correction. */
function demoteToAudio(it, el) {
  if (it.k === "audio") return;
  it.k = "audio";
  if (el) {
    var bd = el.querySelector(".badge");
    if (bd) { bd.className = "badge audio"; bd.innerHTML = ICO.audio; }
    var gl = el.querySelector(".glyph");
    if (gl) gl.innerHTML = ICO.audio;
  }
  saveIndexSoon(libs[it.lib]);
}

/* Sauvegarde differee : l'index fait ~13 Mo, on ne le reecrit pas a chaque
   requalification. */
var saveTimer = null, savePending = [];
function saveIndexSoon(lib) {
  if (!lib) return;
  if (savePending.indexOf(lib) < 0) savePending.push(lib);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    savePending.forEach(function (l) { saveIndex(l); });
    savePending = [];
  }, 4000);
}

/* Vignette : on tente d'abord de reutiliser l'apercu Mister Horse deja
   present sur le disque, sinon on le fabrique nous-memes avec ffmpeg. */
function thumb(el) {
  var it = el._it; if (!it || !CACHE || !nodeReq) return;
  useMH(el, it, function (ok) {
    if (!ok) return thumbGenerate(el);
    if (it.k !== "image") probeInfo(it, function (m) {
      setDur(el, m.dur);
      if (it.k === "video" && !m.vid) demoteToAudio(it, el);
    });
  });
}

/* Charge l'apercu Mister Horse et decide image fixe vs sprite VERTICAL.
   Leurs sprites video font 320 x (N*180) : N images empilees. */
function useMH(el, it, cb) {
  var f = mhPreview(it);
  if (!f) return cb(false);
  var url = fileUrl(f), img = new Image();
  img.onload = function () {
    var w = img.naturalWidth, h = img.naturalHeight;
    var frames = w > 0 ? Math.round(h / (w * 9 / 16)) : 1;
    var expected = frames * w * 9 / 16;
    if (frames >= 2 && Math.abs(h - expected) <= frames * 4) {
      var th = el.querySelector(".th");
      el.dataset.vsprite = url; el.dataset.vframes = String(frames);
      th.style.backgroundImage = "url(" + url + ")";
      th.style.backgroundSize = "100% " + (frames * 100) + "%";
      th.style.backgroundPosition = "50% 0%";
      var g = th.querySelector(".glyph"); if (g) g.style.display = "none";
    } else setBg(el, url);
    cb(true);
  };
  img.onerror = function () { cb(false); };
  img.src = url;
}

function thumbGenerate(el) {
  var it = el._it; if (!it) return;
  if (it.k === "mogrt") return;      // rien a extraire : on garde le glyphe
  var key = keyOf(it);

  if (it.k === "image") {
    if (WEB_IMAGE[it.e] && it.sz < 6 * 1024 * 1024) return setBg(el, fileUrl(it.p));
    var out = cachePath("th", key, ".jpg");
    if (fs.existsSync(out)) return setBg(el, fileUrl(out));
    run(FFMPEG, ["-v","error","-i",it.p,"-frames:v","1","-vf",
      "scale=320:180:force_original_aspect_ratio=increase,crop=320:180","-q:v","4","-y",out],
      function (err) { if (!err && fs.existsSync(out)) setBg(el, fileUrl(out)); },
      { el:el, first:true });
    return;
  }
  if (it.k === "audio") return waveform(el, it, key);

  // Classe "video" : on verifie qu'il y a bien une image avant d'en extraire une.
  probeInfo(it, function (m) {
    setDur(el, m.dur);
    if (!m.vid) { demoteToAudio(it, el); return waveform(el, it, key); }
    var po = cachePath("th", key, ".jpg");
    if (fs.existsSync(po)) { el.dataset.poster = fileUrl(po); return setBg(el, fileUrl(po)); }
    var at = (m.dur && m.dur > 3) ? Math.min(m.dur * 0.15, 20) : 0;
    run(FFMPEG, ["-v","error","-ss",String(at.toFixed(2)),"-i",it.p,"-frames:v","1","-vf",
      "scale=320:180:force_original_aspect_ratio=increase,crop=320:180","-q:v","4","-y",po],
      function (err) { if (!err && fs.existsSync(po)) { el.dataset.poster = fileUrl(po); setBg(el, fileUrl(po)); } },
      { el:el, first:true });
  });
}

function waveform(el, it, key) {
  var wf = cachePath("wf", key, ".png");
  probeInfo(it, function (m) { setDur(el, m.dur); });
  if (fs.existsSync(wf)) return setBg(el, fileUrl(wf));
  run(FFMPEG, ["-v","error","-i",it.p,"-filter_complex",
    "aformat=channel_layouts=mono,showwavespic=s=320x180:colors=#5B9BE8","-frames:v","1","-y",wf],
    function (err) { if (!err && fs.existsSync(wf)) setBg(el, fileUrl(wf)); },
    { el:el, first:true });
}

/* Scrub d'un sprite VERTICAL (format Mister Horse) : la souris balaie en X,
   on deplace le fond en Y. Aucun ffmpeg necessaire. */
function attachVSprite(el) {
  var th = el.querySelector(".th"), frames = +el.dataset.vframes || 1;
  if (frames < 2 || th._scrubV) return;
  th._scrubV = function (ev) {
    var r = th.getBoundingClientRect();
    var f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    var i = Math.min(frames - 1, Math.floor(f * frames));
    th.style.backgroundPosition = "50% " + (i / (frames - 1) * 100) + "%";
  };
  th.addEventListener("mousemove", th._scrubV);
}

var CELL = "scale=160:90:force_original_aspect_ratio=increase,crop=160:90";

function spriteArgs(file, dur, out) {
  if (dur <= 45) {
    return ["-v","error","-i",file,"-vf",
      "fps=" + (SPRITE_N / dur).toFixed(6) + "," + CELL + ",tile=" + SPRITE_N + "x1",
      "-frames:v","1","-q:v","5","-y",out];
  }
  var args = ["-v","error"], fc = [], names = "";
  for (var i = 0; i < SPRITE_N; i++) {
    args.push("-ss", (dur * (i + 0.5) / SPRITE_N).toFixed(3), "-i", file);
    fc.push("[" + i + ":v]" + CELL + ",setsar=1[v" + i + "]");
    names += "[v" + i + "]";
  }
  fc.push(names + "hstack=inputs=" + SPRITE_N + "[o]");
  return args.concat(["-filter_complex", fc.join(";"), "-map","[o]","-frames:v","1","-q:v","5","-y",out]);
}

function hoverSprite(el, it) {
  if (!CACHE || !nodeReq) return;
  var th = el.querySelector(".th"), sp = cachePath("sp", keyOf(it), ".jpg");
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
  probeInfo(it, function (m) {
    // fichier sans image (musique en conteneur .mp4) : pas de sprite possible
    if (!m.vid || !m.dur || m.dur < 0.5) { el.dataset.spriteBusy = ""; return; }
    run(FFMPEG, spriteArgs(it.p, m.dur, sp), function (err) {
      el.dataset.spriteBusy = "";
      if (!err && fs.existsSync(sp) && el.matches(":hover")) attach();
    });
  });
}

/* -------------------------------- preview ------------------------------ */

function stopAudio() {
  try { audio.pause(); } catch (e) {}
  if (playingTile) {
    var b = playingTile.querySelector(".pos"); if (b) b.remove();
    playingTile.classList.remove("playing"); playingTile = null;
  }
}

audio.addEventListener("timeupdate", function () {
  if (!playingTile || !audio.duration) return;
  var b = playingTile.querySelector(".pos");
  if (b) b.style.width = (audio.currentTime / audio.duration * 100) + "%";
});
audio.addEventListener("ended", stopAudio);

function playAudio(el, it) {
  if (playingTile === el) return stopAudio();   // reclic = stop
  stopAudio();
  playingTile = el;
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
    say("Conversion pour l'ecoute (" + it.e + ")...");
    run(FFMPEG, ["-v","error","-i",it.p,"-vn","-ac","2","-b:a","192k","-y",pv],
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
      else run(FFMPEG, ["-v","error","-i",it.p,"-frames:v","1","-vf","scale='min(1600,iw)':-1","-q:v","3","-y",big],
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
      v.src = fileUrl(it.p); v.controls = true; v.autoplay = true; v.loop = true;
      v.volume = (+$("#vol").value) / 100;
      v.onerror = function () { body.innerHTML = '<div class="vmsg">Codec non lisible par Chromium.<br>Survole la vignette pour scruber, ou glisse-le sur la timeline.</div>'; };
      body.appendChild(v);
    } else body.innerHTML = '<div class="vmsg">Format conteneur non lisible ici (' + it.e + ').<br>Survole la vignette pour scruber les images.</div>';
  }
}
function closeViewer() {
  var v = $("#vbody").querySelector("video"); if (v) { try { v.pause(); } catch (e) {} }
  $("#vbody").innerHTML = ""; $("#viewer").classList.remove("on"); viewerItem = null;
}
function selectTile(el) {
  if (selTile === el) return;
  if (selTile) selTile.classList.remove("sel");
  selTile = el; el.classList.add("sel");
}

function preview(el, it) {
  if (it.k === "audio") return playAudio(el, it);
  stopAudio(); openViewer(it);
}

/* --------------------------------- import ------------------------------ */

function doImport(it) {
  var bin = libs[it.lib] ? base(libs[it.lib].root) : "Mudkit";
  say("Import de " + it.n + "...");
  evalScript("mudkitLibImport(" + JSON.stringify(it.p) + "," + JSON.stringify(action) + "," + JSON.stringify(bin) + ")")
    .then(function (res) {
      if (res === "inserted") say(CHECK + " " + it.n + " pose sur la timeline", "ok");
      else if (res === "imported") say(CHECK + " " + it.n + " dans le chutier " + bin, "ok");
      else if (res === "imported_no_seq") say(CHECK + " Importe (aucune sequence active)", "ok");
      else if (res === "mogrt_needs_sequence") say("Un MOGRT exige une sequence active.", "err");
      else if (res === "mogrt_no_bin") say("Les MOGRT vont directement sur la timeline, pas dans un chutier.", "err");
      else if (res && res.indexOf("imported_insert_failed") === 0) say("Importe, insertion impossible : " + res.split(":").slice(1).join(":"), "err");
      else say("Import echoue : " + res, "err");
    });
}

/* --------------------------------- racines ----------------------------- */

function saveRoots() { lsSet("mudkit.lib.roots", JSON.stringify(libs.map(function (l) { return l.root; }))); }

function mountRoot(r, forceRescan, done) {
  var lib = { root:r, items:[], meta:{}, mh:{} };
  libs.push(lib);
  var cached = forceRescan ? null : loadIndex(r);
  if (cached) { lib.items = cached.items; lib.meta = cached.meta || {}; lib.mh = cached.mh || {}; return done(lib, true); }
  scan(lib, function () { done(lib, false); });
}

function refreshAfterMount() {
  rebuildAll(); renderTree(); redraw();
}

function pickFolder() {
  if (!window.cep || !window.cep.fs || !window.cep.fs.showOpenDialog)
    return say("Selecteur de dossier indisponible (CEP).", "err");
  var res = window.cep.fs.showOpenDialog(false, true, "Dossier de medias", "", []);
  var p = res && res.data && res.data[0]; if (!p) return;
  p = p.replace(/\//g, "\\").replace(/\\+$/, "");
  for (var i = 0; i < libs.length; i++) if (libs[i].root.toLowerCase() === p.toLowerCase()) return say("Deja monte.", "err");
  say("Scan de " + p + "...");
  mountRoot(p, false, function () { saveRoots(); refreshAfterMount(); });
}

function selectedLib() {
  if (!sel) return -1;
  return +sel.split(":")[0];
}

/* --------------------------------- cablage ----------------------------- */

document.querySelectorAll("#libact button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#libact button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on"); action = b.dataset.v; lsSet("mudkit.lib.action", action);
  });
});

var qTimer = null;
$("#q").addEventListener("input", function (e) {
  query = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(redraw, 170);
});

document.querySelectorAll("#kinds button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#kinds button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on"); kind = b.dataset.k; lsSet("mudkit.lib.kind", kind); redraw();
  });
});

$("#favfilter").addEventListener("click", function () {
  favOnly = !favOnly;
  this.classList.toggle("on", favOnly);
  lsSet("mudkit.lib.favonly", favOnly ? "1" : "0");
  redraw();
});

$("#pick").addEventListener("click", pickFolder);

$("#forget").addEventListener("click", function () {
  var li = selectedLib();
  if (li < 0 || !libs[li]) return say("Selectionne d'abord un dossier racine dans l'arbre.", "err");
  invalidate();
  libs.splice(li, 1); sel = ""; saveRoots();
  lsSet("mudkit.lib.sel", "");
  refreshAfterMount();
});

$("#rescan").addEventListener("click", function () {
  var li = selectedLib();
  var targets = (li >= 0 && libs[li]) ? [libs[li]] : libs.slice();
  if (!targets.length) return;
  invalidate();
  var n = targets.length, done = 0;
  targets.forEach(function (lib) {
    scan(lib, function () { saveIndex(lib); if (++done === n) refreshAfterMount(); });
  });
});

$("#size").addEventListener("input", function (e) {
  tileW = +e.target.value;
  document.documentElement.style.setProperty("--tw", tileW + "px");
  lsSet("mudkit.lib.tilew", String(tileW));
});

$("#vol").addEventListener("input", function (e) {
  audio.volume = (+e.target.value) / 100;
  var v = $("#vbody").querySelector("video"); if (v) v.volume = audio.volume;
  lsSet("mudkit.lib.vol", e.target.value);
});

$("#vclose").addEventListener("click", closeViewer);
$("#vadd").addEventListener("click", function () { if (viewerItem) doImport(viewerItem); });

/* splitter */
(function () {
  var dragging = false;
  $("#split").addEventListener("mousedown", function (e) { dragging = true; e.preventDefault(); });
  document.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    var w = Math.max(110, Math.min(window.innerWidth * 0.6, e.clientX));
    $("#side").style.width = w + "px";
  });
  document.addEventListener("mouseup", function () {
    if (!dragging) return;
    dragging = false;
    lsSet("mudkit.lib.sidew", String(parseInt($("#side").style.width, 10) || 168));
  });
})();

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

/* -------------------------------- demarrage ---------------------------- */

if (!nodeReq) {
  say("Node est desactive dans ce panneau - impossible de lire le disque.", "err");
} else {
  var savedRoots = [];
  try { savedRoots = JSON.parse(ls("mudkit.lib.roots", "[]")) || []; } catch (e) {}
  try { (JSON.parse(ls("mudkit.lib.favs", "[]")) || []).forEach(function (p) { favs[p] = 1; }); } catch (e) {}
  try { open = JSON.parse(ls("mudkit.lib.open", "{}")) || {}; } catch (e) { open = {}; }
  sel = ls("mudkit.lib.sel", "");
  action = ls("mudkit.lib.action", "insert");
  favOnly = ls("mudkit.lib.favonly", "0") === "1";
  kind = ls("mudkit.lib.kind", "all");
  tileW = +ls("mudkit.lib.tilew", "116") || 116;

  document.documentElement.style.setProperty("--tw", tileW + "px");
  $("#size").value = tileW;
  $("#vol").value = ls("mudkit.lib.vol", "70");
  audio.volume = (+$("#vol").value) / 100;
  $("#side").style.width = (+ls("mudkit.lib.sidew", "168") || 168) + "px";
  $("#favfilter").classList.toggle("on", favOnly);
  document.querySelectorAll("#kinds button").forEach(function (b) { b.classList.toggle("on", b.dataset.k === kind); });
  document.querySelectorAll("#libact button").forEach(function (b) { b.classList.toggle("on", b.dataset.v === action); });
  mkdirp(CACHE);

  var pending = savedRoots.filter(function (r) { return fs.existsSync(r); });
  if (!pending.length) redraw();
  else {
    var left = pending.length;
    pending.forEach(function (r) {
      mountRoot(r, false, function () { if (--left === 0) refreshAfterMount(); });
    });
  }
}

})();
