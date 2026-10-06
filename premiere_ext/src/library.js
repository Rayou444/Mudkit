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

var MUDKIT = os ? os.homedir() + "\\Mudkit" : "";   /* %USERPROFILE%\Mudkit */
var FFMPEG = MUDKIT + "\\bin\\ffmpeg.exe";
var FFPROBE = MUDKIT + "\\bin\\ffprobe.exe";
var LOCALAPP = (typeof process !== "undefined" && process.env && process.env.LOCALAPPDATA)
  ? process.env.LOCALAPPDATA
  : (os ? os.homedir() + "\\AppData\\Local" : null);
var CACHE = LOCALAPP ? LOCALAPP + "\\Mudkit\\lib-cache" : null;

var MAX_DEPTH = 12;
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
  check:  S + '<path d="M3.5 8.4l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock:  S + '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star:   S + '<path d="M8 2.2l1.75 3.54 3.91.57-2.83 2.76.67 3.89L8 11.13l-3.5 1.83.67-3.89L2.34 6.31l3.91-.57z" fill="currentColor"/></svg>',
  plus:   S + '<path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  play:   S + '<path d="M5.4 3.2l7.2 4.8-7.2 4.8z" fill="currentColor"/></svg>',
  pause:  S + '<path d="M4.6 3.4h2.3v9.2H4.6zM9.1 3.4h2.3v9.2H9.1z" fill="currentColor"/></svg>',
  prev:   S + '<path d="M3.8 3.4v9.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12.6 3.4L5.6 8l7 4.6z" fill="currentColor"/></svg>',
  next:   S + '<path d="M12.2 3.4v9.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3.4 3.4l7 4.6-7 4.6z" fill="currentColor"/></svg>',
  speaker:S + '<path d="M2.4 6h2.5l3.3-2.8v9.6L4.9 10H2.4z" fill="currentColor"/><path d="M10.5 5.7a3.3 3.3 0 0 1 0 4.6M12.3 3.9a5.9 5.9 0 0 1 0 8.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  mute:   S + '<path d="M2.4 6h2.5l3.3-2.8v9.6L4.9 10H2.4z" fill="currentColor"/><path d="M10.3 6.1l3.6 3.8M13.9 6.1l-3.6 3.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  r_loop: S + '<path d="M2.8 7.4v-.9a2 2 0 0 1 2-2h7.6M10.6 2.6l1.9 1.9-1.9 1.9M13.2 8.6v.9a2 2 0 0 1-2 2H3.6M5.4 13.4l-1.9-1.9 1.9-1.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  r_next: S + '<path d="M2.6 4.2h8M2.6 8h5.2M2.6 11.8h5.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10 8.4l3.8 2.6L10 13.6z" fill="currentColor"/></svg>',
  r_once: S + '<path d="M2.6 8h7.6M7.6 5.2L10.4 8l-2.8 2.8M13.2 4v8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
var CHECK  = "OK";

/* --------------------------------- etat -------------------------------- */

var libs = [];          // [{ root, items:[...], meta:{} }]
var all = [];           // concat des items, chacun avec .lib
var favs = {};          // chemin -> 1
var open = {};          // cle de noeud -> ouvert
var sel = "";           // cle du noeud selectionne ("" = tout)
var view = [];
var byPath = {};        // chemin en minuscules -> item (Recents)
var recents = [];       // chemins des derniers fichiers poses, du plus recent
var missing = [];       // dossiers enregistres mais introuvables (disque debranche)
var query = "";
var favOnly = false;
var action = "insert";
var tileW = 116;
var token = 0;

var audio = new Audio();
var cur = null;          // son charge dans le lecteur -- survit aux redraw
var playingTile = null;  // sa tuile, si elle est affichee
var selTile = null;
var viewTimer = null;    // ouverture differee de la visionneuse (cf. dblclick)

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
function say(msg, cls) {
  var el = $("#libstatus");
  el.textContent = msg; el.title = msg;   // message entier au survol s'il est coupe
  el.className = "msg " + (cls || "");
}

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
function invalidate() {
  token++;
  var dropped = queue; queue = [];
  dropped.forEach(function (j) { j.done(SKIPPED); });   // cf. pump()
}

/* opts.el   : tuile concernee -- si elle a quitte le DOM (defilement, filtre,
                changement de dossier), le job est abandonne au lieu de bloquer
                la file derriere des vignettes que plus personne ne regarde.
   opts.first : passe devant. Les vignettes demandees en dernier sont celles
                qui viennent d'entrer a l'ecran, ce sont donc les urgentes.
   opts.bg   : tache de fond (mesure des durees pour le filtre) : abandonnee
                des que ce filtre change (bgGen avance).
   Chaque job est tue au bout de JOB_MAX_MS : un fichier qui fait tourner
   ffmpeg sans fin ne bloque plus une place de la file pour toujours. */
var JOB_MAX_MS = 120000;
var SKIPPED = "skipped";
var bgGen = 0;
function run(exe, args, done, opts) {
  opts = opts || {};
  var job = { exe:exe, args:args, done:done, tok:token, el:opts.el, bg:opts.bg };
  if (opts.first) queue.unshift(job); else queue.push(job);
  pump();
}
function pump() {
  while (busy < MAXJOBS && queue.length) {
    var job = queue.shift();
    /* Job abandonne : on le DIT a son demandeur (SKIPPED), sinon une sonde
       en attente restait "en cours" pour toujours et le fichier n'etait
       plus jamais mesure. */
    if (job.tok !== token ||                        // rescan / demontage
        (job.el && !job.el.isConnected) ||          // tuile plus a l'ecran
        (job.bg && job.bg !== bgGen)) {             // filtre de duree change
      job.done(SKIPPED);
      continue;
    }
    busy++;
    (function (j) {
      var out = "", err = "", p, ended = false, timer = null;
      /* Une seule fin par job : quand le lancement echoue, Node envoie
         "error" PUIS "close". Compte deux fois, busy devenait negatif et la
         limite de MAXJOBS ffmpeg en parallele sautait (PC qui gele). */
      function end(e, o) {
        if (ended) return;
        ended = true; clearTimeout(timer); busy--;
        j.done(e, o); pump();
      }
      try { p = spawn(j.exe, j.args, { windowsHide:true }); }
      catch (e) { return end(String(e)); }
      timer = setTimeout(function () { try { p.kill(); } catch (e) {} }, JOB_MAX_MS);
      p.stdout.on("data", function (c) { out += c.toString(); });
      p.stderr.on("data", function (c) { err += c.toString(); });
      p.on("error", function (e) { end(String(e)); });
      p.on("close", function (c) { end(c === 0 ? null : (err.trim() || ("code " + c)), out); });
    })(job);
  }
}

/* --------------------------------- cache ------------------------------- */

function cachePath(sub, key, ex) { var d = CACHE + "\\" + sub; mkdirp(d); return d + "\\" + key + ex; }
function keyOf(it) { return md5(it.p + "|" + it.mt + "|" + it.sz); }
function indexFile(r) { mkdirp(CACHE); return CACHE + "\\idx-" + md5(r.toLowerCase()) + ".json"; }

/* L'index d'un gros dossier pese ~13 Mo : lu et ecrit SANS bloquer le
   panneau (avant : readFileSync / writeFileSync sur le fil de l'interface).
   Ecriture dans un fichier temporaire puis renommage : jamais d'index a
   moitie ecrit si Premiere se ferme pendant l'ecriture. */
function loadIndex(r, cb) {
  fs.readFile(indexFile(r), "utf8", function (err, txt) {
    var o = null;
    if (!err) { try { o = JSON.parse(txt); } catch (e) { o = null; } }
    cb(o && o.v === 2 && o.items ? o : null);
  });
}
function saveIndex(lib) {
  if (!lib || lib.gone) return;
  var dest = indexFile(lib.root), tmp = dest + "." + Date.now() + ".tmp", data;
  try {
    data = JSON.stringify({ v:2, root:lib.root, ts:Date.now(), items:lib.items, meta:lib.meta, mh:lib.mh });
  } catch (e) { return; }
  fs.writeFile(tmp, data, function (err) {
    if (err) return fs.unlink(tmp, function () {});
    fs.rename(tmp, dest, function (e2) { if (e2) fs.unlink(tmp, function () {}); });
  });
}
/* Dossier retire : son index part avec lui (sinon, remonte des mois plus
   tard, il revenait avec son vieux contenu). */
function deleteIndex(r) { fs.unlink(indexFile(r), function () {}); }

/* ---------------------------------- scan ------------------------------- */

/* Annulation PAR dossier (lib.scanId) : rescanner ou retirer un dossier ne
   coupe plus, sans rien dire, le scan d'un autre dossier en cours (un
   dossier tout juste ajoute pouvait sinon disparaitre au redemarrage). */
var SCAN_SLICE = 1500;       // entrees traitees par tranche

/* Le resultat est construit a part puis remplace l'ancien d'un coup : la
   grille reste utilisable pendant un rescan, et quiet=true (rescan de fond)
   n'affiche rien. after(changed) : changed = la liste des fichiers a bouge. */
function scan(lib, after, quiet) {
  var mine = lib.scanId = (lib.scanId || 0) + 1;
  var items = [];
  var mh = {};               // cle "rel/nom.ext" en minuscules -> chemin d'apercu
  /* mh sur une entree de file = { base, sub } : on est DANS un dossier
     d'apercus Mister Horse ; base = rel du dossier qui le contient, sub = le
     chemin parcouru a l'interieur. Le media source est donc base/sub/<nom>. */
  var dirs = [{ d:lib.root, rel:"", lvl:0, mh:null }], seenDirs = 0, nPrev = 0;
  var cur = null, ents = null, i = 0;

  /* Le budget compte les FICHIERS, plus les dossiers : un dossier de 40 000
     sons faisait 40 000 statSync d'affilee et gelait le panneau. On reprend
     au milieu d'un dossier a la tranche suivante. */
  function step() {
    if (lib.scanId !== mine || lib.gone) return;
    var budget = SCAN_SLICE;
    while (budget > 0) {
      if (!ents) {
        if (!dirs.length) break;
        cur = dirs.shift(); seenDirs++; i = 0;
        try { ents = fs.readdirSync(cur.d, { withFileTypes:true }); } catch (e) { ents = null; continue; }
      }
      for (; i < ents.length && budget > 0; i++, budget--) {
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
          mh[k2] = full; nPrev++;
          continue;
        }

        var e = ext(nm), k = EXT[e];
        if (!k) continue;
        var st; try { st = fs.statSync(full); } catch (er) { continue; }
        items.push({ p:full, n:nm, e:e, k:k, rel:cur.rel, sz:st.size, mt:st.mtimeMs | 0 });
      }
      if (i >= ents.length) ents = null;
    }
    if (!quiet)
      say("Scan... " + items.length + " fichiers, " + seenDirs + " dossiers" +
          (nPrev ? " (" + nPrev + " apercus Mister Horse reutilisables)" : ""));
    if (ents || dirs.length) return setTimeout(step, 0);
    items.sort(function (a, b) { return a.rel === b.rel ? a.n.localeCompare(b.n) : a.rel.localeCompare(b.rel); });
    var changed = items.length !== lib.items.length;
    for (var c = 0; !changed && c < items.length; c++)
      changed = items[c].p !== lib.items[c].p || items[c].mt !== lib.items[c].mt;
    lib.items = items; lib.mh = mh;
    if (changed || !quiet) saveIndex(lib);
    after(changed);
  }
  setTimeout(step, 0);
}

/* Nouveaux fichiers visibles tout seuls (y compris ceux que le panneau
   vient de telecharger) : un rescan silencieux quelques secondes apres
   l'ouverture, puis a chaque changement signale par Windows dans le
   dossier (fs.watch recursif). Avant, il fallait cliquer sur Rescanner. */
function quietRescan(lib, delay) {
  clearTimeout(lib.rescanTimer);
  lib.rescanTimer = setTimeout(function () {
    if (lib.gone) return;
    scan(lib, function (changed) {
      if (!changed || lib.gone) return;
      rebuildAll(); renderTree(); redraw(true, true);
    }, true);
  }, delay);
}
function watchLib(lib) {
  try {
    lib.watcher = fs.watch(lib.root, { recursive:true }, function (evt, name) {
      // un apercu Mister Horse ou un fichier temporaire ne compte pas
      if (name && (MH_DIR_RE.test(String(name).split(/[\\\/]/)[0]) || /\.(tmp|part)$/i.test(name))) return;
      quietRescan(lib, 4000);
    });
    lib.watcher.on("error", function () {});   // disque debranche : on laisse
  } catch (e) { /* lecteur reseau sans surveillance : rescan au demarrage seulement */ }
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
  all = []; byPath = {};
  libs.forEach(function (lib, li) {
    lib.items.forEach(function (it) { it.lib = li; all.push(it); byPath[it.p.toLowerCase()] = it; });
  });
}

/* Cles de noeud par CHEMIN du dossier monte, plus par sa position dans la
   liste : un disque debranche au demarrage decalait toutes les positions, et
   la selection / les dossiers deplies pointaient sur un autre dossier. */
var RECENTS = "@recents", MISSING = "@missing|";
function rootKey(root) { return root.toLowerCase(); }
function nodeKey(li, rel) { return rootKey(libs[li].root) + "|" + rel; }
function libOfKey(key) {   // index du dossier monte vise par une cle, ou -1
  var rk = key.slice(0, key.indexOf("|"));
  for (var i = 0; i < libs.length; i++) if (rootKey(libs[i].root) === rk) return i;
  return -1;
}
function isNodeKey(key) { return key.indexOf("|") > 0 && key.charAt(0) !== "@"; }

var treeCache = null;
function invalidateTree() { treeCache = null; }

function buildTree() {
  if (treeCache) return treeCache;          // 33 ms sur 43k items : on garde
  treeCache = libs.map(function (lib, li) {
    var rootNode = { name:base(lib.root), key:nodeKey(li, ""), lib:li, rel:"", kids:{}, count:0, isRoot:true };
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

function selectKey(key) {
  sel = key;
  lsSet("mudkit.lib.sel", sel);
  renderTree(); redraw();
}

function renderTree() {
  var t = $("#tree");
  t.innerHTML = "";
  if (recents.length) {
    t.appendChild(flatRow(RECENTS, ICO.clock, "R\u00E9cents", recentItems().length, "",
      "Les derniers fichiers poses ou glisses sur la timeline"));
  }
  var pi = projectItems();
  if (pi.length) {
    t.appendChild(flatRow(PROJECT, ICO.check, "Dans ce projet", pi.length, "",
      "Les fichiers de la bibliotheque deja utilises dans le projet Premiere ouvert"));
  }
  buildTree().forEach(function (n) { renderNode(t, n, 0); });
  missing.forEach(function (r) {
    var row = flatRow(MISSING + r, ICO.folder, base(r), "?", " off",
      r + "\nIntrouvable (disque debranche ?). Clique dessus une fois rebranche ; - pour le retirer.");
    row.addEventListener("click", function () { retryMissing(r); });
    t.appendChild(row);
  });
}

/* Ligne sans enfants : Recents, dossier introuvable. */
function flatRow(key, icon, name, count, cls, title) {
  var row = document.createElement("div");
  row.className = "node root" + cls + (sel === key ? " sel" : "");
  row.style.paddingLeft = "6px";
  row.title = title;
  row.innerHTML = '<span class="tw leaf">' + ICO.chev + '</span><span class="fic">' + icon + '</span>';
  var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = name; row.appendChild(nm);
  var ct = document.createElement("span"); ct.className = "ct"; ct.textContent = count; row.appendChild(ct);
  row.addEventListener("click", function () { selectKey(key); });
  return row;
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
    if (kids.length && !open[n.key]) { open[n.key] = true; lsSet("mudkit.lib.open", JSON.stringify(open)); }
    selectKey(n.key);
  });
  host.appendChild(row);

  if (kids.length && open[n.key])
    kids.forEach(function (k) { renderNode(host, n.kids[k], depth + 1); });
}

/* ------------------------------- recents ------------------------------- */

/* Les derniers fichiers poses (double-clic, +) ou glisses sur la timeline,
   pour retrouver vite un son deja utilise. Chemins, du plus recent au plus
   ancien ; seuls ceux encore presents dans un dossier monte s'affichent. */
var RECENTS_MAX = 60;
function pushRecent(p) {
  var low = p.toLowerCase();
  recents = recents.filter(function (x) { return x.toLowerCase() !== low; });
  recents.unshift(p);
  if (recents.length > RECENTS_MAX) recents.length = RECENTS_MAX;
  lsSet("mudkit.lib.recents", JSON.stringify(recents));
  renderTree();
}
function recentItems() {
  var out = [];
  recents.forEach(function (p) { var it = byPath[p.toLowerCase()]; if (it) out.push(it); });
  return out;
}

/* -------------------------- filtre par duree --------------------------- */

/* Les bruitages se choisissent d'abord a leur duree. Les durees inconnues
   sont mesurees en tache de fond (ffprobe, file basse priorite) puis
   gardees dans l'index : la mesure n'est faite qu'une fois par fichier. */
var DUR = {
  lt1:  { lo:0,  hi:1 },
  s1_5: { lo:1,  hi:5 },
  s5_30:{ lo:5,  hi:30 },
  gt30: { lo:30, hi:Infinity }
};
var durf = "";            // filtre actif ("" = aucun)
var durMissing = [];      // fichiers du perimetre dont la duree manque
var durPass = null;       // { gen, done, total } mesure en cours
var durRefresh = null;

function knownDur(it) {
  var lib = libs[it.lib], m = lib && lib.meta[it.p];
  return m && m.dur != null ? m.dur : null;
}
function durOk(it) {
  if (it.k !== "audio" && it.k !== "video") return false;
  var d = knownDur(it);
  if (d == null) { if (!it._probeFail) durMissing.push(it); return false; }
  var r = DUR[durf];
  return d >= r.lo && d < r.hi;
}

function startDurationPass() {
  bgGen++;                               // abandonne la mesure precedente
  durPass = null;
  if (!durf || !durMissing.length) return;
  var gen = bgGen, list = durMissing.slice();
  durPass = { gen:gen, done:0, total:list.length };
  list.forEach(function (it) {
    probeInfo(it, function () {
      if (gen !== bgGen) return;
      durPass.done++;
      // la grille se complete au fil de l'eau, sans remonter en haut
      if (!durRefresh) durRefresh = setTimeout(function () {
        durRefresh = null;
        if (gen === bgGen) redraw(true, true);
      }, durPass.done >= durPass.total ? 0 : 1200);
    }, { bg:gen });
  });
}

/* Le noeud selectionne montre TOUT son sous-arbre (comme Mister Horse). */
function computeView() {
  var terms = query.trim() ? query.toLowerCase().trim().split(/\s+/) : null;
  var src = all, selLi = -1, selRel = "";
  if (!terms) {
    if (sel === RECENTS) src = recentItems();
    else if (sel === PROJECT) src = projectItems();
    else if (sel.indexOf(MISSING) === 0) return [];
    else if (isNodeKey(sel)) {
      selLi = libOfKey(sel);
      if (selLi < 0) return [];
      selRel = sel.slice(sel.indexOf("|") + 1);
    }
  }
  return src.filter(function (it) {
    if (favOnly && !favs[it.p]) return false;
    if (durf && !durOk(it)) return false;
    if (terms) {
      var hay = (it.rel + "/" + it.n).toLowerCase();
      for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
      return true;                       // la recherche ignore la selection
    }
    if (selLi < 0) return true;
    if (it.lib !== selLi) return false;
    if (!selRel) return true;
    return it.rel === selRel || it.rel.indexOf(selRel + "/") === 0;
  });
}

/* --------------------------------- rendu ------------------------------- */

/* Grille VIRTUELLE : seules les tuiles visibles (plus 2 rangees de marge)
   existent dans la page, placees en absolu dans une boite aussi haute que la
   grille entiere. Avant, chaque page de 150 tuiles s'ajoutait sans jamais
   repartir : 40 000 tuiles dans la page apres un long defilement, et chaque
   page relancait la mise en page de toute la grille. */
var GAP_X = 8, GAP_Y = 9, PAD = 8, META_H = 17, BUFFER_ROWS = 2;
var vbox = null, vtiles = new Map(), L = null, paintQueued = false;
var selPath = null;      // fichier selectionne : survit au recyclage des tuiles

/* Ne coupe PAS le son : chercher, changer de dossier ou filtrer les favoris
   pendant qu'une musique tourne est justement le cas d'usage. tile() remet
   le marquage sur la nouvelle tuile du son en cours si elle reapparait.
   keepScroll : garde la position (favori retire, mesure des durees...).
   soft : simple rafraichissement, ne relance pas la mesure des durees. */
function redraw(keepScroll, soft) {
  unmarkTile();
  var g = $("#grid"), top = keepScroll ? g.scrollTop : 0;
  g.innerHTML = ""; selTile = null; vtiles = new Map(); vbox = null; L = null;
  durMissing = [];
  view = computeView();
  if (!soft) startDurationPass();
  if (!keepScroll && !soft) { selSet = {}; if (selPath) selSet[selPath] = 1; }

  if (!view.length) {
    var d = document.createElement("div"); d.className = "empty";
    d.innerHTML = !libs.length && !missing.length
      ? "Aucun dossier monte.<br>Clique sur <b>+</b> en haut a droite pour en ajouter un."
      : sel.indexOf(MISSING) === 0 && !query.trim()
        ? "Ce dossier est introuvable (disque debranche ?).<br>Clique a nouveau dessus une fois rebranche, ou retire-le avec <b>-</b>."
      : durPass && durPass.done < durPass.total ? "Mesure des durees en cours..."
      : favOnly ? "Aucun favori ici."
      : sel === RECENTS && !query.trim() ? "Rien de recent pour l'instant."
      : sel === PROJECT && !query.trim() ? "Aucun fichier de la bibliotheque dans ce projet."
      : "Rien a afficher.";
    g.appendChild(d);
  } else {
    vbox = document.createElement("div"); vbox.className = "vbox";
    g.appendChild(vbox);
    layout();
    g.scrollTop = top;
    paint();
  }
  countLine();
}

function layout() {
  var g = $("#grid");
  var inner = Math.max(0, g.clientWidth - 2 * PAD);
  var cols = Math.max(1, Math.floor((inner + GAP_X) / (tileW + GAP_X)));
  var colW = (inner - (cols - 1) * GAP_X) / cols;
  var same = L && Math.abs(L.colW - colW) < 0.5;
  L = { cols:cols, colW:colW, rows:Math.ceil(view.length / cols),
        rowH: same ? L.rowH : colW * 0.5625 + 2 + META_H, measured: same && L.measured };
  vbox.style.height = (2 * PAD + L.rows * (L.rowH + GAP_Y) - GAP_Y) + "px";
}

function place(el, i) {
  var r = Math.floor(i / L.cols), c = i % L.cols;
  el.style.left = (PAD + c * (L.colW + GAP_X)) + "px";
  el.style.top = (PAD + r * (L.rowH + GAP_Y)) + "px";
  el.style.width = L.colW + "px";
}

function paint() {
  paintQueued = false;
  if (!vbox || !L) return;
  var g = $("#grid"), stride = L.rowH + GAP_Y;
  var r0 = Math.max(0, Math.floor((g.scrollTop - PAD) / stride) - BUFFER_ROWS);
  var r1 = Math.min(L.rows - 1, Math.floor((g.scrollTop + g.clientHeight - PAD) / stride) + BUFFER_ROWS);
  var i0 = r0 * L.cols, i1 = Math.min(view.length - 1, (r1 + 1) * L.cols - 1);
  vtiles.forEach(function (el, i) {
    if (i >= i0 && i <= i1) return;
    if (el === selTile) selTile = null;
    el.remove(); vtiles.delete(i);       // ses jobs ffmpeg en file sont abandonnes
  });
  var fresh = [];
  for (var i = i0; i <= i1; i++) {
    var el = vtiles.get(i);
    if (!el) { el = tile(view[i]); vtiles.set(i, el); vbox.appendChild(el); fresh.push(el); }
    place(el, i);
  }
  fresh.forEach(thumb);
  if (!L.measured && vtiles.size) {
    // hauteur reelle d'une tuile : depend de la police choisie dans Premiere
    L.measured = true;
    var h = vtiles.values().next().value.offsetHeight;
    if (h && Math.abs(h - L.rowH) > 0.5) {
      L.rowH = h;
      vbox.style.height = (2 * PAD + L.rows * (L.rowH + GAP_Y) - GAP_Y) + "px";
      vtiles.forEach(function (t, j) { place(t, j); });
      paint();
    }
  }
}

function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(paint);
  // filet : requestAnimationFrame est suspendu quand le panneau est masque
  setTimeout(function () { if (paintQueued) paint(); }, 80);
}

/* Largeur de la grille ou taille des vignettes changee : nouvelles colonnes. */
function relayout() {
  if (!vbox) return;
  layout();
  vtiles.forEach(function (t, j) { place(t, j); });
  paint();
}

/* Amene la tuile n i a l'ecran (son suivant / precedent du lecteur). */
function ensureVisible(i) {
  if (!vbox || !L) return null;
  var g = $("#grid"), y = PAD + Math.floor(i / L.cols) * (L.rowH + GAP_Y);
  if (y < g.scrollTop) g.scrollTop = y - PAD;
  else if (y + L.rowH > g.scrollTop + g.clientHeight) g.scrollTop = y + L.rowH - g.clientHeight + PAD;
  paint();
  return vtiles.get(i) || null;
}

function countLine() {
  var n = { audio:0, video:0, image:0, mogrt:0 };
  view.forEach(function (i) { n[i.k]++; });
  var where = query.trim() ? "\u00AB " + query.trim() + " \u00BB"
            : sel === RECENTS ? "recents" : sel === PROJECT ? "dans ce projet" : (sel ? "" : "tout");
  say(view.length + " elements " + (where ? where + " " : "") +
      "- " + n.audio + " sons, " + n.video + " videos, " + n.image + " images" +
      (n.mogrt ? ", " + n.mogrt + " mogrt" : "") +
      (durPass && durPass.done < durPass.total
        ? " - mesure des durees " + durPass.done + "/" + durPass.total : ""), "ok");
}

function tile(it) {
  var el = document.createElement("div");
  el.className = "tile";
  el.title = it.p + "\n" + human(it.sz) +
    (it.k === "audio" ? "\n\nClic sur le visuel : lecture a partir de cet endroit" +
                        "\nClic sur le nom : lecture / pause" : "") +
    "\nDouble-clic : importer" +
    "\nCtrl / Maj+clic : selection multiple" +
    (it.k === "audio" || it.k === "video" ? "\nI / O pendant l'ecoute : ne poser qu'un passage" : "");
  el._it = it;
  el.setAttribute("draggable", "true");

  var th = document.createElement("div"); th.className = "th";
  var gl = document.createElement("div"); gl.className = "glyph"; gl.innerHTML = ICO[it.k] || ""; th.appendChild(gl);
  var add = document.createElement("div"); add.className = "add"; add.innerHTML = ICO.plus; add.title = "Importer"; th.appendChild(add);
  var dur = document.createElement("div"); dur.className = "dur"; th.appendChild(dur);
  var ip = document.createElement("div"); ip.className = "ip"; ip.innerHTML = ICO.check; ip.title = "Deja dans ce projet"; th.appendChild(ip);

  var meta = document.createElement("div"); meta.className = "meta";
  var bd = document.createElement("span"); bd.className = "badge " + it.k; bd.innerHTML = ICO[it.k] || "";
  var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = it.n.replace(/\.[^.]+$/, "");
  var fv = document.createElement("span"); fv.className = "fav" + (favs[it.p] ? " on" : ""); fv.innerHTML = ICO.star;
  fv.title = "Favori";
  meta.appendChild(bd); meta.appendChild(nm); meta.appendChild(fv);

  el.appendChild(th); el.appendChild(meta);

  // Glisser vers la timeline : cle CEP officielle.
  var dragged = [];
  el.addEventListener("dragstart", function (ev) {
    // glisser un fichier de la selection = glisser toute la selection
    dragged = selSet[it.p] && selCount() > 1 ? selectedItems() : [it];
    try {
      ev.dataTransfer.effectAllowed = "copy";
      dragged.forEach(function (g, i) { ev.dataTransfer.setData("com.adobe.cep.dnd.file." + i, g.p); });
      ev.dataTransfer.setData("text/uri-list", dragged.map(function (g) { return fileUrl(g.p); }).join("\r\n"));
      ev.dataTransfer.setData("text/plain", dragged.map(function (g) { return g.p; }).join("\n"));
      ev.dataTransfer.setDragImage(el, 40, 22);
    } catch (e) {}
    say(dragged.length > 1 ? "Glisse les " + dragged.length + " fichiers sur la timeline..."
        : marks[it.p] ? "Glisser pose le fichier entier ; pour le passage choisi : double-clic ou +."
        : "Glisse \u00AB " + it.n + " \u00BB sur la timeline...");
  });
  el.addEventListener("dragend", function (ev) {
    // depose quelque part (la timeline) : ils rejoignent les Recents
    if (ev.dataTransfer && ev.dataTransfer.dropEffect !== "none") {
      pushRecents(dragged.map(function (g) { return g.p; }).reverse());
      refreshProjectSoon();
    }
  });

  fv.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (favs[it.p]) delete favs[it.p]; else favs[it.p] = 1;
    fv.classList.toggle("on", !!favs[it.p]);
    lsSet("mudkit.lib.favs", JSON.stringify(Object.keys(favs)));
    if (favOnly) redraw(true);          // sans remonter en haut de la grille
  });
  add.addEventListener("click", function (ev) { ev.stopPropagation(); doImport(it); });
  el.addEventListener("click", function (ev) {
    // 2e clic d'un double-clic : c'est un import, pas une bascule lecture/pause
    if (ev.detail > 1) return;
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return multiSelect(el, ev.shiftKey);
    // Clic DANS le visuel : on en tire la position de lecture (0 a 1).
    var frac = null;
    if (th.contains(ev.target)) {
      var r = th.getBoundingClientRect();
      if (r.width) frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    }
    /* Dans une multi-selection, le 1er clic d'un double-clic ne doit pas la
       reduire a ce seul fichier (le double-clic pose toute la selection) :
       on attend un instant, comme pour la visionneuse. */
    if (selSet[it.p] && selCount() > 1) {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(function () { selectTile(el); preview(el, it, frac); }, 260);
      return;
    }
    selectTile(el);
    if (it.k === "audio") return preview(el, it, frac);
    /* Image / video : la visionneuse (plein panneau) attend un instant. Ouverte
       tout de suite, elle recevait le 2e clic et le double-clic n'importait
       jamais rien. */
    clearTimeout(viewTimer);
    viewTimer = setTimeout(function () { preview(el, it, frac); }, 260);
  });
  el.addEventListener("dblclick", function () { clearTimeout(viewTimer); doImport(it); });

  if (it.k === "video") {
    el.addEventListener("mouseenter", function () {
      if (el.dataset.vsprite) return attachVSprite(el);   // sprite Mister Horse
      hoverSprite(el, it);                                // sinon on le fabrique
    });
    el.addEventListener("mouseleave", function () {
      if (el.dataset.vsprite) { th.style.backgroundPosition = "50% 0%"; return; }
      th.classList.remove("sprite"); th.style.backgroundSize = "cover"; th.style.backgroundPosition = "center";
      if (el.dataset.poster) th.style.backgroundImage = cssUrl(el.dataset.poster);
      // pas d'image fixe : on revient a la 1re image du sprite au lieu de
      // laisser deux demi-images du milieu de la video
      else if (th._scrub) { th.style.backgroundSize = (SPRITE_N * 100) + "% 100%"; th.style.backgroundPosition = "0% 50%"; }
    });
  }
  if (cur && cur.p === it.p) markTile(el);
  if (selSet[it.p]) el.classList.add("sel");
  if (selPath === it.p) selTile = el;
  if (isInProject(it)) el.classList.add("inproj");
  if (marks[it.p]) markBand(el);
  return el;
}

/* ------------------------------- vignettes ----------------------------- */

/* url("...") ENTRE GUILLEMETS : encodeURI laisse passer ( ) et ', et un
   url(...) nu avec `clip (1).jpg`, `Voix d'homme.wav` ou un profil Windows
   `O'Brien` etait une declaration CSS invalide -> vignette vide. */
function cssUrl(u) { return 'url("' + String(u).replace(/["\\]/g, "\\$&") + '")'; }

function setBg(el, url) {
  var th = el.querySelector(".th");
  th.style.backgroundImage = cssUrl(url);
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
var probing = {};       // chemin -> rappels en attente : une seule sonde par fichier
function probeInfo(it, cb, opts) {
  var m = metaOf(it);
  if (m.vid !== undefined) return cb(m);
  if (probing[it.p]) return probing[it.p].push(cb);
  probing[it.p] = [cb];
  run(FFPROBE, ["-v","error","-show_entries","format=duration:stream=codec_type",
                "-of","default=nw=1:nk=1", it.p],
    function (err, out) {
      var cbs = probing[it.p] || [];
      delete probing[it.p];
      if (err) {
        /* Sonde ratee (NAS deconnecte, ffprobe absent, .r3d illisible) ou
           abandonnee : on ne conclut RIEN. Avant, une video etait alors prise
           pour un son, et c'etait enregistre dans l'index jusqu'au Rescanner. */
        if (err !== SKIPPED) it._probeFail = true;
        var unknown = { dur:null, vid:it.k === "video", failed:true };
        return cbs.forEach(function (f) { f(unknown); });
      }
      var toks = String(out || "").trim().split(/\s+/);
      var d = null, hasVid = false;
      for (var i = 0; i < toks.length; i++) {
        if (toks[i] === "video") { hasVid = true; continue; }
        var f = parseFloat(toks[i]);
        if (isFinite(f)) d = f;
      }
      m.dur = d; m.vid = hasVid;
      saveIndexSoon(libs[it.lib]);   // duree gardee : plus de ffprobe a chaque session
      cbs.forEach(function (fn) { fn(m); });
    }, opts);
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
  /* Au plus une ecriture toutes les 15 s, et SANS repousser le delai a
     chaque appel : pendant une mesure de durees en continu, un delai
     repousse sans fin n'aurait jamais rien enregistre. */
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    savePending.forEach(function (l) { saveIndex(l); });
    savePending = [];
  }, 15000);
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
      th.style.backgroundImage = cssUrl(url);
      th.style.backgroundSize = "100% " + (frames * 100) + "%";
      th.style.backgroundPosition = "50% 0%";
      var g = th.querySelector(".glyph"); if (g) g.style.display = "none";
    } else setBg(el, url);
    cb(true);
  };
  img.onerror = function () { cb(false); };
  img.src = url;
}

/* Vignettes ecrites d'abord dans un .part puis renommees : un ffmpeg tue en
   route (delai max, fermeture de Premiere) laissait une image tronquee que
   le cache servait ensuite pour toujours. */
function partOf(out) { return out.replace(/(\.[a-z0-9]+)$/i, ".part$1"); }
function settle(err, part, out) {
  if (err) { fs.unlink(part, function () {}); return false; }
  try { fs.renameSync(part, out); return true; } catch (e) { return false; }
}

/* Fichier dont la vignette a echoue (corrompu, format exotique) : on ne
   relance plus ffmpeg a chaque defilement. Memorise dans l'index avec la
   cle du fichier (chemin + date + taille) : modifie, il est retente. */
function thumbFailed(it) {
  var lib = libs[it.lib], m = lib && lib.meta[it.p];
  return !!(m && m.nothumb && m.nothumb === keyOf(it));
}
function markThumbFailed(it, err) {
  if (err === SKIPPED) return;           // abandonne, pas rate
  metaOf(it).nothumb = keyOf(it);
  saveIndexSoon(libs[it.lib]);
}

function thumbGenerate(el) {
  var it = el._it; if (!it) return;
  if (it.k === "mogrt") return;      // rien a extraire : on garde le glyphe
  if (thumbFailed(it)) {
    if (it.k !== "image") probeInfo(it, function (m) { setDur(el, m.dur); });
    return;
  }
  var key = keyOf(it);

  if (it.k === "image") {
    /* Petite image : affichee telle quelle. Au-dela, une miniature 320 px
       en cache : une photo de 24 Mpx occupait ~96 Mo une fois decodee dans
       la grille. Les GIF passent aussi par une miniature fixe (sinon ils
       s'animaient tous en meme temps). */
    if (WEB_IMAGE[it.e] && it.e !== "gif" && it.sz < 400 * 1024) return setBg(el, fileUrl(it.p));
    var out = cachePath("th", key, ".jpg"), part = partOf(out);
    if (fs.existsSync(out)) return setBg(el, fileUrl(out));
    run(FFMPEG, ["-v","error","-i",it.p,"-frames:v","1","-vf",
      "scale=320:180:force_original_aspect_ratio=increase,crop=320:180","-q:v","4","-y",part],
      function (err) {
        if (settle(err, part, out)) setBg(el, fileUrl(out)); else markThumbFailed(it, err);
      }, { el:el, first:true });
    return;
  }
  if (it.k === "audio") return waveform(el, it, key);

  // Classe "video" : on verifie qu'il y a bien une image avant d'en extraire une.
  probeInfo(it, function (m) {
    setDur(el, m.dur);
    if (!m.vid) { demoteToAudio(it, el); return waveform(el, it, key); }
    var po = cachePath("th", key, ".jpg"), part = partOf(po);
    if (fs.existsSync(po)) { el.dataset.poster = fileUrl(po); return setBg(el, fileUrl(po)); }
    var at = (m.dur && m.dur > 3) ? Math.min(m.dur * 0.15, 20) : 0;
    run(FFMPEG, ["-v","error","-ss",String(at.toFixed(2)),"-i",it.p,"-frames:v","1","-vf",
      "scale=320:180:force_original_aspect_ratio=increase,crop=320:180","-q:v","4","-y",part],
      function (err) {
        if (settle(err, part, po)) { el.dataset.poster = fileUrl(po); setBg(el, fileUrl(po)); }
        else markThumbFailed(it, err);
      }, { el:el, first:true });
  });
}
function waveform(el, it, key) {
  var wf = cachePath("wf", key, ".png"), part = partOf(wf);
  probeInfo(it, function (m) { setDur(el, m.dur); });
  if (fs.existsSync(wf)) return setBg(el, fileUrl(wf));
  run(FFMPEG, ["-v","error","-i",it.p,"-filter_complex",
    "aformat=channel_layouts=mono,showwavespic=s=320x180:colors=#5B9BE8","-frames:v","1","-y",part],
    function (err) {
      if (settle(err, part, wf)) setBg(el, fileUrl(wf)); else markThumbFailed(it, err);
    }, { el:el, first:true });
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
    th.style.backgroundImage = cssUrl(fileUrl(sp));
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
    var part = partOf(sp);
    run(FFMPEG, spriteArgs(it.p, m.dur, part), function (err) {
      el.dataset.spriteBusy = "";
      if (settle(err, part, sp) && el.matches(":hover")) attach();
    });
  });
}

/* -------------------------------- lecteur ------------------------------ */

/* Barre de lecture des sons (au-dessus de la barre du bas). Le son en cours
   est garde dans `cur`, independamment de la grille : chercher, changer de
   dossier ou ouvrir une image ne coupe plus la musique.

   Fin du son, au choix (bouton a droite, memorise) :
     loop  recommence au debut -- defaut, on ecoute en boucle le temps de
           decider au lieu de devoir relancer a chaque fin ;
     next  enchaine le son suivant de la grille ;
     once  s'arrete (le bouton lecture repart du debut). */
var REPEAT = ["loop", "next", "once"];
var REPEAT_TIP = { loop:"Fin du son : recommence (boucle)",
                   next:"Fin du son : enchaine le son suivant",
                   once:"Fin du son : s'arrete" };
var repeat = "loop";
var muted = false;
var seeking = false;     // la barre de position est tenue a la souris
var pendingFrac = null;  // calage demande avant que la duree soit connue

function markTile(el) {
  if (playingTile === el) return;
  unmarkTile();
  if (!el) return;
  playingTile = el;
  el.classList.add("playing");
  if (!el.querySelector(".pos")) {
    var b = document.createElement("div"); b.className = "pos";
    el.querySelector(".th").appendChild(b);
  }
  syncUI();
}
function unmarkTile() {
  if (!playingTile) return;
  var b = playingTile.querySelector(".pos"); if (b) b.remove();
  playingTile.classList.remove("playing", "paused");
  playingTile = null;
}

/* Tuile actuellement affichee pour ce fichier (comparaison par chemin : un
   rescan recree les objets item). */
function tileOf(it) {
  var found = null;
  vtiles.forEach(function (el) { if (!found && el._it.p === it.p) found = el; });
  return found;
}

function syncTime() {
  var d = audio.duration, t = audio.currentTime || 0;
  var ok = isFinite(d) && d > 0;
  var pct = ok ? Math.min(100, t / d * 100) : 0;
  var sk = $("#pseek");
  if (!seeking) { sk.value = Math.round(pct * 10); sk.style.setProperty("--p", pct + "%"); }
  $("#ptime").textContent = clock(t) + " / " + (ok ? clock(d) : "-:--");
  if (playingTile) { var b = playingTile.querySelector(".pos"); if (b) b.style.width = pct + "%"; }
}
function syncUI() {
  var on = !!cur && !audio.paused;
  var b = $("#pplay");
  b.innerHTML = on ? ICO.pause : ICO.play;
  b.title = (on ? "Pause" : "Lecture") + " (Espace)";
  if (playingTile) playingTile.classList.toggle("paused", !on);
  syncTime();
}

function seekFrac(f) {
  f = Math.max(0, Math.min(1, f));
  if (!isFinite(audio.duration) || !audio.duration) { pendingFrac = f; return; }
  try { audio.currentTime = f * audio.duration; } catch (e) {}
  syncTime();
}
function nudge(sec) {
  if (!cur || !isFinite(audio.duration)) return;
  try { audio.currentTime = Math.max(0, Math.min(audio.duration - 0.05, audio.currentTime + sec)); } catch (e) {}
  syncTime();
}

function resume() { if (cur) audio.play().catch(function () {}); }
function pauseAudio() { try { audio.pause(); } catch (e) {} }

/* Arret complet : on vide la source et on range le lecteur. */
function stopAudio() {
  audio.onerror = null;
  pauseAudio();
  audio.removeAttribute("src");
  try { audio.load(); } catch (e) {}
  cur = null; pendingFrac = null;
  unmarkTile();
  $("#player").classList.add("hidden");
}

function togglePlay() {
  if (!cur) {
    // rien de charge : le son selectionne, sinon le premier son de la grille
    if (selTile && selTile._it && selTile._it.k === "audio") return playAudio(selTile, selTile._it, null);
    return step(1);
  }
  if (audio.paused) resume(); else pauseAudio();
}

/* Son precedent / suivant dans la vue courante (les non-sons sont sautes).
   La grille etant virtuelle, on fait defiler jusqu'a la tuile cible. */
function step(dir) {
  var i = -1;
  if (cur) for (var j = 0; j < view.length; j++) if (view[j].p === cur.p) { i = j; break; }
  for (var k = i + dir; k >= 0 && k < view.length; k += dir) {
    if (view[k].k !== "audio") continue;
    var el = ensureVisible(k);
    if (el) selectTile(el);
    playAudio(el, view[k], null);
    return true;
  }
  return false;
}
function prev() {
  // comme tout lecteur : au-dela de 3 s, "precedent" revient au debut du son
  if (cur && audio.currentTime > 3) return seekFrac(0);
  if (!step(-1) && cur) seekFrac(0);
}

function setRepeat(m) {
  repeat = REPEAT_TIP[m] ? m : "loop";
  audio.loop = repeat === "loop";
  var b = $("#prep");
  b.innerHTML = ICO["r_" + repeat];
  b.title = REPEAT_TIP[repeat] + " - clic pour changer";
  b.classList.toggle("lit", repeat !== "once");
  lsSet("mudkit.lib.repeat", repeat);
}

function applyVol() {
  var v = (+$("#vol").value) / 100;
  audio.volume = v; audio.muted = muted;
  if (vplayer) vplayer.setVolume(v, muted, true);
  var b = $("#pmute");
  b.innerHTML = (muted || v === 0) ? ICO.mute : ICO.speaker;
  b.title = muted ? "Remettre le son" : "Couper le son";
}

audio.addEventListener("timeupdate", syncTime);
audio.addEventListener("durationchange", syncTime);
audio.addEventListener("play", syncUI);
audio.addEventListener("pause", syncUI);
audio.addEventListener("loadedmetadata", function () {
  if (pendingFrac != null) { var f = pendingFrac; pendingFrac = null; seekFrac(f); }
  syncUI();
});
/* Avec loop=true "ended" ne se declenche pas : on n'arrive ici qu'en mode
   next ou once. On ne demonte plus rien, le lecteur reste sur le son. */
audio.addEventListener("ended", function () {
  if (repeat === "next" && step(1)) return;
  syncUI();
});

/* frac : position du clic sur la forme d'onde, entre 0 et 1. On demarre la
   lecture a cet endroit du son -- cliquer au milieu du visuel joue le milieu.
   frac null = clic ailleurs sur la tuile : lecture / pause (on garde la
   position, on ne repart plus du debut). */
function playAudio(el, it, frac) {
  $("#player").classList.remove("hidden");

  if (cur && cur.p === it.p) {                 // meme son
    markTile(el || tileOf(it));
    if (frac != null) { seekFrac(frac); resume(); }
    else if (audio.paused) resume(); else pauseAudio();
    return;
  }

  cur = it; pendingFrac = frac;
  markTile(el || tileOf(it));
  $("#pname").textContent = it.n.replace(/\.[^.]+$/, "");
  $("#pname").title = it.p;
  showMarks(it);
  audio.onerror = null;
  pauseAudio();
  syncUI();

  function start(src) {
    if (cur !== it) return;                    // on est passe a un autre son entre-temps
    audio.src = src;                           // currentTime sera cale sur loadedmetadata
    audio.play().catch(function () {});
  }
  function transcode() {
    audio.onerror = null;
    var pv = cachePath("pv", keyOf(it), ".mp3");
    if (fs.existsSync(pv)) return start(fileUrl(pv));
    say("Conversion pour l'ecoute (" + it.e + ")...");
    /* Fichier temporaire puis renommage : une conversion interrompue ne
       laisse pas un mp3 tronque que le cache servirait ensuite pour toujours.
       first:true -- sinon l'ecoute attendait derriere toutes les vignettes. */
    var tmp = pv.replace(/\.mp3$/, ".part.mp3");
    run(FFMPEG, ["-v","error","-i",it.p,"-vn","-ac","2","-b:a","192k","-y",tmp],
      function (err) {
        if (!err) { try { fs.renameSync(tmp, pv); } catch (e) { err = String(e); } }
        if (cur !== it) return;
        if (!err && fs.existsSync(pv)) { countLine(); start(fileUrl(pv)); }
        else say("Lecture impossible pour " + it.n, "err");
      }, { first:true });
  }

  if (WEB_AUDIO[it.e]) { audio.onerror = transcode; start(fileUrl(it.p)); }
  else transcode();
}

var viewerItem = null;

function openViewer(it) {
  if (proxyProc) { try { proxyProc.kill(); } catch (e) {} proxyProc = null; }
  if (vplayer) { vplayer.destroy(); vplayer = null; }
  $("#vinfo").textContent = "";
  viewerItem = it;
  var body = $("#vbody"); body.innerHTML = ""; body.classList.remove("hasplayer");
  $("#vname").textContent = it.p;
  $("#viewer").classList.add("on");
  if (it.k === "image") {
    if (WEB_IMAGE[it.e]) { var img = document.createElement("img"); img.src = fileUrl(it.p); body.appendChild(img); }
    else {
      var big = cachePath("big", keyOf(it), ".jpg"), im2 = document.createElement("img"); body.appendChild(im2);
      if (fs.existsSync(big)) im2.src = fileUrl(big);
      else run(FFMPEG, ["-v","error","-i",it.p,"-frames:v","1","-vf","scale='min(1600,iw)':-1","-q:v","3","-y",big],
        function (err) {
          if (viewerItem !== it) return;     // visionneuse fermee ou autre media entre-temps
          if (!err && fs.existsSync(big)) im2.src = fileUrl(big);
          else body.innerHTML = '<div class="vmsg">Apercu impossible pour ce format (' + it.e + ').<br>Le fichier reste importable.</div>';
        }, { first:true });
    }
    return;
  }
  if (it.k === "video") openVideo(it, body);
}

/* ------------------------- visionneuse video --------------------------
   Lecteur MkPlayer (player.js, partage avec l'appli) : barre de temps avec
   images au survol (sprite de la vignette), image par image, J / K / L,
   vitesse, passage In / Out pose directement sur la barre (memes points que
   les touches I / O), temps tapables. Un codec que Chromium ne lit pas
   (ProRes, DNxHD, HEVC, AVI, MXF...) est converti une fois en apercu leger
   (540p H.264) garde en cache : plus de \u00AB Codec non lisible \u00BB. */
var vplayer = null, proxyProc = null;

function openVideo(it, body) {
  var m = metaOf(it);
  var mk = marks[it.p];
  body.classList.add("hasplayer");
  vplayer = new MkPlayer(body, {
    duration: m.dur || 0, range: true, autoplay: true, loop: true, compact: true,
    a: mk ? mk.a : null, b: mk ? mk.b : null,
    volume: (+$("#vol").value) / 100, muted: muted,
    thumbs: function (t, d) { return spriteAt(it, t, d); },
    onRange: function (a, b, pl) {
      if (a == null) delete marks[it.p];
      else { delete marks[it.p]; marks[it.p] = { a: a, b: b, d: pl.dur }; }
      saveMarks(); showMarks(it);
    },
    onVolume: function (v, mu) {
      $("#vol").value = Math.round(v * 100); muted = mu;
      lsSet("mudkit.lib.vol", $("#vol").value);
      audio.volume = v; audio.muted = mu;
      var bt = $("#pmute"); bt.innerHTML = (mu || !v) ? ICO.mute : ICO.speaker;
    },
    onError: function () { proxyFor(it); return true; }
  });
  vplayer.el.style.flex = "1 1 auto";
  videoInfo(it);
  ensureSprite(it);
  if (WEB_VIDEO[it.e]) vplayer.load(fileUrl(it.p));
  else proxyFor(it);
}

/* Infos sous la video (definition, cadence, codec) + cadence pour l'image
   par image et le timecode. */
function videoInfo(it) {
  run(FFPROBE, ["-v","error","-select_streams","v:0","-show_entries",
                "stream=width,height,r_frame_rate,codec_name:format=duration","-of","json", it.p],
    function (err, out) {
      if (viewerItem !== it || !vplayer || err) return;
      var j; try { j = JSON.parse(out); } catch (e) { return; }
      var st = (j.streams || [])[0] || {}, fr = String(st.r_frame_rate || "").split("/");
      var fps = fr.length === 2 && +fr[1] ? +fr[0] / +fr[1] : 0;
      if (fps > 0 && fps < 240) vplayer.fps = fps;
      var bits = [];
      if (st.width) bits.push(st.width + "x" + st.height);
      if (fps) bits.push((Math.round(fps * 100) / 100) + " i/s");
      if (st.codec_name) bits.push(String(st.codec_name).toUpperCase());
      $("#vinfo").textContent = bits.join("  \u00B7  ");
      vplayer.paint(); vplayer.paintRange();
    }, { first:true });
}

/* Image du sprite de survol (24 images de 160x90 cote a cote) a l'instant t */
function spriteAt(it, t, d) {
  var sp = it._sprite;
  if (!sp || !d) return null;
  var i = Math.max(0, Math.min(SPRITE_N - 1, Math.floor(t / d * SPRITE_N)));
  return { url: fileUrl(sp), w: 160, h: 90, x: i * 160, y: 0, sw: 160 * SPRITE_N, sh: 90 };
}
function ensureSprite(it) {
  if (!CACHE || !nodeReq) return;
  var sp = cachePath("sp", keyOf(it), ".jpg");
  if (fs.existsSync(sp)) { it._sprite = sp; return; }
  probeInfo(it, function (m) {
    if (!m.vid || !m.dur || m.dur < 0.5) return;
    var part = partOf(sp);
    run(FFMPEG, spriteArgs(it.p, m.dur, part), function (err) {
      if (settle(err, part, sp)) it._sprite = sp;
    }, { first:true });
  });
}

/* Apercu leger pour un codec illisible par Chromium : 540p H.264 + AAC,
   converti une fois puis garde en cache (sous-dossier px, purge comme le
   reste). Fichier .part tant que ce n'est pas fini. */
function proxyFor(it) {
  if (!vplayer) return;
  var px = cachePath("px", keyOf(it), ".mp4");
  if (fs.existsSync(px)) { if (vplayer.v.src.indexOf("/px/") < 0) vplayer.swap(fileUrl(px)); return; }
  if (proxyProc) return;
  var part = partOf(px), pl = vplayer;
  pl.msg("Pr\u00E9paration de l'aper\u00E7u (" + it.e.toUpperCase() + ")...");
  probeInfo(it, function (m) {
    if (vplayer !== pl) return;
    var dur = m.dur || 0;
    var args = ["-v","error","-y","-i",it.p,"-map","0:v:0","-map","0:a:0?",
                "-vf","scale=-2:'min(540,ih)':flags=bilinear,format=yuv420p",
                "-c:v","libx264","-preset","veryfast","-crf","26","-g","25",
                "-c:a","aac","-b:a","128k","-ac","2","-movflags","+faststart",
                "-progress","pipe:1","-nostats", part];
    var p;
    try { p = spawn(FFMPEG, args, { windowsHide:true }); }
    catch (e) { return pl.msg("Aper\u00E7u impossible pour ce fichier.<br>Il reste importable."); }
    proxyProc = p;
    var buf = "", err = "";
    p.stdout.on("data", function (c) {
      buf += c.toString();
      var mm = buf.match(/out_time_us=(\d+)/g);
      if (mm && dur > 0 && vplayer === pl) {
        var us = +mm[mm.length - 1].split("=")[1];
        pl.msg("Pr\u00E9paration de l'aper\u00E7u (" + it.e.toUpperCase() + ")... " +
               Math.min(99, Math.round(us / 1e6 / dur * 100)) + " %");
      }
      if (buf.length > 4000) buf = buf.slice(-400);
    });
    p.stderr.on("data", function (c) { err = (err + c.toString()).slice(-600); });
    p.on("error", function () { proxyProc = null; });
    p.on("close", function (code) {
      proxyProc = null;
      var ok = settle(code === 0 ? null : (err || "code " + code), part, px);
      if (vplayer !== pl) return;
      if (ok) { pl.msg(""); pl.swap(fileUrl(px)); countLine(); }
      else pl.msg("Aper\u00E7u impossible pour ce fichier (" + it.e + ").<br>Il reste importable : double-clic ou +.");
    });
  });
}

function closeViewer() {
  if (proxyProc) { try { proxyProc.kill(); } catch (e) {} proxyProc = null; }
  if (vplayer) { vplayer.destroy(); vplayer = null; }
  $("#vbody").innerHTML = ""; $("#vinfo").textContent = "";
  $("#viewer").classList.remove("on"); viewerItem = null;
}
function selectTile(el) {
  var p = el._it.p;            // retrouve la selection quand la tuile est recreee
  selPath = p; selAnchor = p; selTile = el;
  selSet = {}; selSet[p] = 1;
  refreshSel();
}

/* Une image se regarde par-dessus la musique ; une video a son propre son,
   donc on met le lecteur en PAUSE (pas a l'arret : il reprend ou il etait). */
function preview(el, it, frac) {
  if (it.k === "audio") return playAudio(el, it, frac);
  // MOGRT : rien a montrer, plutot qu'une visionneuse vide
  if (it.k === "mogrt") return say("Modele d'animation : double-clic ou + pour le poser sur la timeline.");
  if (it.k === "video") pauseAudio();
  openViewer(it);
}

/* ----------------- multi-selection, passages, projet ------------------- */

/* Multi-selection : Ctrl+clic ajoute / retire, Maj+clic prend tout entre le
   dernier clic et celui-ci, Ctrl+A tout ce qui est affiche, Echap vide.
   Double-clic ou + sur un fichier selectionne pose TOUTE la selection a la
   suite ; glisser la selection la depose d'un coup. */
var selSet = {};           // chemin -> 1
var selAnchor = null;      // chemin du dernier clic (depart de Maj+clic)

function selCount() { var n = 0; for (var k in selSet) n++; return n; }
function viewIndex(p) {
  for (var i = 0; i < view.length; i++) if (view[i].p === p) return i;
  return -1;
}
function selectedItems() { return view.filter(function (it) { return selSet[it.p]; }); }
function refreshSel() {
  vtiles.forEach(function (el) { el.classList.toggle("sel", !!selSet[el._it.p]); });
  var n = selCount();
  if (n > 1) say(n + " fichiers selectionnes : double-clic ou + pour les poser a la suite, ou glisse-les.", "ok");
}
function multiSelect(el, range) {
  var p = el._it.p;
  if (range && selAnchor) {
    var a = viewIndex(selAnchor), b = viewIndex(p);
    if (a < 0) a = b;
    for (var i = Math.min(a, b); i <= Math.max(a, b); i++) selSet[view[i].p] = 1;
  } else {
    if (selSet[p] && selCount() > 1) delete selSet[p]; else selSet[p] = 1;
    selAnchor = p;
  }
  selPath = p; selTile = el;
  refreshSel();
}
function selectAllInView() {
  selSet = {};
  view.forEach(function (it) { selSet[it.p] = 1; });
  refreshSel();
}
function clearMultiSel() {
  if (selCount() <= 1) return false;
  selSet = {};
  if (selPath) selSet[selPath] = 1;
  refreshSel(); countLine();
  return true;
}

/* Points d'entree / sortie : touches I et O pendant l'ecoute d'un son, ou
   dans la visionneuse video. Seul ce passage est ensuite pose (sous-plan
   Premiere, le fichier d'origine n'est pas touche). Gardes d'une session a
   l'autre ; un clic sur \u00AB In > Out \u00BB dans le lecteur les efface. Glisser
   pose toujours le fichier entier (seul un chemin de fichier passe). */
var marks = {};            // chemin -> { a: entree, b: sortie, d: duree } en s
var MARKS_MAX = 300;

function saveMarks() {
  var keys = Object.keys(marks);
  if (keys.length > MARKS_MAX) keys.slice(0, keys.length - MARKS_MAX).forEach(function (k) { delete marks[k]; });
  lsSet("mudkit.lib.marks", JSON.stringify(marks));
}
/* 1:05.3 : au dixieme, utile pour les bruitages de moins d'une seconde */
function fineClock(s) {
  var m = Math.floor(s / 60), r = s - m * 60;
  return m + ":" + (r < 10 ? "0" : "") + r.toFixed(1);
}
function markArgs(it) {
  var m = marks[it.p];
  return m && m.b > m.a ? m.a.toFixed(3) + "," + m.b.toFixed(3) : "null,null";
}
function setMark(which) {
  // visionneuse video : le lecteur pose le point lui-meme (et le montre sur sa barre)
  if (vplayer && viewerItem && $("#viewer").classList.contains("on")) return vplayer.mark(which === "in" ? "a" : "b");
  var it, t, dur;
  if (cur) { it = cur; t = audio.currentTime; dur = audio.duration; }
  else return say("Lance d'abord l'ecoute d'un son (ou ouvre une video) pour placer un point d'entree / sortie.", "err");
  var full = isFinite(dur) ? dur : t;
  var m = marks[it.p] || { a: 0, b: full };
  if (which === "in") { m.a = t; if (m.b <= t) m.b = full; }
  else { m.b = t; if (m.a >= t) m.a = 0; }
  if (isFinite(dur)) m.d = dur;
  delete marks[it.p]; marks[it.p] = m;   // en dernier : le plus recent est garde
  saveMarks(); showMarks(it);
  say((which === "in" ? "Entree" : "Sortie") + " placee : seul le passage " + fineClock(m.a) + " > " + fineClock(m.b) +
      " sera pose (double-clic ou +).", "ok");
}
function clearMarks(it) {
  if (!it || !marks[it.p]) return;
  delete marks[it.p]; saveMarks(); showMarks(it);
  say("Passage efface : le fichier entier sera pose.", "ok");
}
function showMarks(it) {
  var m = cur && marks[cur.p], pm = $("#pmarks");
  pm.textContent = m ? "In " + fineClock(m.a) + " > Out " + fineClock(m.b) : "";
  pm.title = m ? "Seul ce passage sera pose. Clic pour l'effacer." : "";
  if (viewerItem) {
    var vm = marks[viewerItem.p];
    $("#vname").textContent = viewerItem.p + (vm ? "   [In " + fineClock(vm.a) + " > Out " + fineClock(vm.b) + "]" : "");
  }
  vtiles.forEach(function (el) { if (!it || el._it.p === it.p) markBand(el); });
}
/* Bande orange sur la vignette : la partie qui sera posee. */
function markBand(el) {
  var m = marks[el._it.p], th = el.querySelector(".th"), band = th.querySelector(".mk");
  var d = m && (m.d || knownDur(el._it));
  if (!m || !d) { if (band) band.remove(); return; }
  if (!band) { band = document.createElement("div"); band.className = "mk"; th.appendChild(band); }
  band.style.left = Math.max(0, m.a / d * 100) + "%";
  band.style.width = Math.max(0, Math.min(100, (m.b - m.a) / d * 100)) + "%";
}

/* \u00AB Dans ce projet \u00BB : les fichiers de la bibliotheque deja utilises dans
   le projet Premiere ouvert (badge vert sur la vignette + dossier virtuel
   en haut de l'arbre). Releve au demarrage, quand le panneau reprend le
   focus, apres chaque import et chaque minute. */
var inProject = {};        // chemins (minuscules) des medias du projet ouvert
var PROJECT = "@project";
var projTimer = null, projLast = 0;

function isInProject(it) { return !!inProject[it.p.toLowerCase()]; }
function projectItems() { return all.filter(isInProject); }
function refreshProject(force) {
  if (!window.__adobe_cep__) return;
  if (!force && (document.visibilityState === "hidden" || Date.now() - projLast < 10000)) return;
  projLast = Date.now();
  evalScript("mudkitProjectMedia()").then(function (res) {
    if (typeof res !== "string" || res.indexOf("err:") === 0 || res.indexOf("EvalScript") === 0) return;
    var next = {}, k, same = true;
    res.split("\n").forEach(function (p) { if (p) next[p.toLowerCase()] = 1; });
    for (k in next) if (!inProject[k]) { same = false; break; }
    if (same) for (k in inProject) if (!next[k]) { same = false; break; }
    if (same) return;
    inProject = next;
    vtiles.forEach(function (el) { el.classList.toggle("inproj", isInProject(el._it)); });
    renderTree();
    if (sel === PROJECT) redraw(true, true);
  });
}
function refreshProjectSoon() {
  clearTimeout(projTimer);
  projTimer = setTimeout(function () { refreshProject(true); }, 1200);
}

function pushRecents(paths) {
  paths.forEach(function (p) {
    var low = p.toLowerCase();
    recents = recents.filter(function (x) { return x.toLowerCase() !== low; });
    recents.unshift(p);
  });
  if (recents.length > RECENTS_MAX) recents.length = RECENTS_MAX;
  lsSet("mudkit.lib.recents", JSON.stringify(recents));
  renderTree();
}

/* Plusieurs fichiers poses a la suite, dans l'ordre de la grille. */
function doImportMany(items) {
  var bin = libs[items[0].lib] ? base(libs[items[0].lib].root) : "Mudkit";
  var arr = "[" + items.map(function (it) { return "[" + esStr(it.p) + "," + markArgs(it) + "]"; }).join(",") + "]";
  say("Import de " + items.length + " fichiers...");
  pushRecents(items.map(function (it) { return it.p; }).reverse());
  evalScript("mudkitLibImportMany(" + arr + "," + esStr(action) + "," + esStr(bin) + ")")
    .then(function (res) {
      res = String(res);
      if (res.indexOf("err:") === 0) return say("Import echoue : " + res.slice(4), "err");
      var p = res.split("|"), ok = +p[0], total = +p[1];
      var where = action === "bin" ? "dans le chutier " + bin
                : p[2] ? "dans le chutier (aucune sequence active)" : "poses a la suite sur la timeline";
      if (ok === total) say(CHECK + " " + ok + " fichiers " + where, "ok");
      else say(ok + "/" + total + " fichiers " + where + (p[3] ? " - " + p[3] : ""), "err");
      refreshProjectSoon();
    });
}

/* --------------------------------- import ------------------------------ */

/* Chaine pour ExtendScript (ES3) : JSON.stringify n'echappe pas U+2028 /
   U+2029, qui y sont des fins de ligne (erreur de syntaxe, import rate).
   On echappe tout le non-ASCII : les noms avec emoji passent aussi. */
function esStr(v) {
  return JSON.stringify(String(v)).replace(/[^\x00-\x7e]/g, function (c) {
    return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function doImport(it) {
  if (selSet[it.p] && selCount() > 1) return doImportMany(selectedItems());
  var bin = libs[it.lib] ? base(libs[it.lib].root) : "Mudkit";
  say("Import de " + it.n + "...");
  pushRecent(it.p);
  evalScript("mudkitLibImport(" + esStr(it.p) + "," + esStr(action) + "," + esStr(bin) + "," + markArgs(it) + ")")
    .then(function (res) {
      if (res && res.indexOf("inserted") === 0 || res && res.indexOf("imported") === 0) refreshProjectSoon();
      var m = marks[it.p], part = m ? " (passage " + fineClock(m.a) + " > " + fineClock(m.b) + ")" : "";
      if (res === "inserted_sub") say(CHECK + " " + it.n + part + " pose sur la timeline", "ok");
      else if (res === "imported_sub") say(CHECK + " " + it.n + part + " dans le chutier " + bin, "ok");
      else if (res === "inserted_nosub" || res === "imported_nosub") say("Pose en entier : Premiere a refuse le passage.", "err");
      else if (res === "inserted") say(CHECK + " " + it.n + " pose sur la timeline", "ok");
      else if (res === "imported") say(CHECK + " " + it.n + " dans le chutier " + bin, "ok");
      else if (res === "imported_no_seq") say(CHECK + " Importe (aucune sequence active)", "ok");
      else if (res === "mogrt_needs_sequence") say("Un MOGRT exige une sequence active.", "err");
      else if (res === "mogrt_no_bin") say("Les MOGRT vont directement sur la timeline, pas dans un chutier.", "err");
      else if (res && res.indexOf("imported_insert_failed") === 0) say("Importe, insertion impossible : " + res.split(":").slice(1).join(":"), "err");
      else say("Import echoue : " + res, "err");
    });
}

/* --------------------------------- racines ----------------------------- */

/* Les dossiers introuvables au demarrage (disque externe debranche) restent
   dans la liste enregistree : avant, ajouter ou retirer un autre dossier
   pendant ce temps les effacait pour de bon. */
function saveRoots() {
  lsSet("mudkit.lib.roots", JSON.stringify(libs.map(function (l) { return l.root; }).concat(missing)));
}

function mountRoot(r, forceRescan, done) {
  var lib = { root:r, items:[], meta:{}, mh:{} };
  libs.push(lib);                        // tout de suite : l'ordre reste celui enregistre
  watchLib(lib);
  if (forceRescan) return scan(lib, function () { done(lib, false); });
  loadIndex(r, function (cached) {
    if (lib.gone) return;
    if (cached) {
      lib.items = cached.items; lib.meta = cached.meta || {}; lib.mh = cached.mh || {};
      quietRescan(lib, 6000 + 4000 * libs.indexOf(lib));   // fichiers ajoutes depuis
      return done(lib, true);
    }
    scan(lib, function () { done(lib, false); });
  });
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
  missing = missing.filter(function (m) { return m.toLowerCase() !== p.toLowerCase(); });
  say("Scan de " + p + "...");
  mountRoot(p, false, function () { saveRoots(); refreshAfterMount(); });
}

/* Dossier introuvable sur lequel on clique : s'il est revenu, on le monte. */
function retryMissing(r) {
  if (!fs.existsSync(r)) return say("Toujours introuvable : " + r, "err");
  missing = missing.filter(function (m) { return m !== r; });
  say("Scan de " + r + "...");
  mountRoot(r, false, function (lib) {
    saveRoots();
    sel = nodeKey(libs.indexOf(lib), "");
    lsSet("mudkit.lib.sel", sel);
    refreshAfterMount();
  });
}

function selectedLib() { return isNodeKey(sel) ? libOfKey(sel) : -1; }

/* ------------------------------ purge du cache -------------------------- */

/* Vignettes, formes d'onde, sprites et sons convertis grossissaient sans
   limite. Une fois par jour, 2 min apres l'ouverture : au-dela de
   CACHE_MAX, on supprime les plus anciens jusqu'a CACHE_KEEP. Ils seront
   refaits a la demande. Plus les .part abandonnes et les index de dossiers
   qui ne sont plus montes. Tout en asynchrone : le panneau ne gele pas. */
var CACHE_MAX = 3 * 1024 * 1024 * 1024, CACHE_KEEP = 2 * 1024 * 1024 * 1024;

function purgeCache() {
  if (!CACHE) return;
  if (Date.now() - (+ls("mudkit.lib.purge", "0") || 0) < 86400000) return;
  lsSet("mudkit.lib.purge", String(Date.now()));
  var noop = function () {};

  var keep = {};
  libs.forEach(function (l) { keep[indexFile(l.root).toLowerCase()] = 1; });
  missing.forEach(function (r) { keep[indexFile(r).toLowerCase()] = 1; });
  fs.readdir(CACHE, function (err, names) {
    (err ? [] : names).forEach(function (n) {
      var p = CACHE + "\\" + n;
      if (/^idx-.*\.json$/i.test(n) && !keep[p.toLowerCase()]) fs.unlink(p, noop);
      else if (/\.tmp$/i.test(n)) fs.unlink(p, noop);
    });
  });

  var files = [], subs = ["th", "wf", "sp", "pv", "big", "px"], dirsLeft = subs.length;
  subs.forEach(function (sub) {
    var d = CACHE + "\\" + sub;
    fs.readdir(d, function (err, names) {
      names = err ? [] : names;
      var left = names.length;
      if (!left) return dirDone();
      names.forEach(function (n) {
        var p = d + "\\" + n;
        fs.stat(p, function (e, st) {
          if (!e) {
            if (/\.part\./i.test(n) && Date.now() - st.mtimeMs > 3600000) fs.unlink(p, noop);
            else files.push({ p:p, sz:st.size, t:st.mtimeMs });
          }
          if (--left === 0) dirDone();
        });
      });
    });
  });
  function dirDone() {
    if (--dirsLeft) return;
    var total = 0;
    files.forEach(function (f) { total += f.sz; });
    if (total <= CACHE_MAX) return;
    files.sort(function (a, b) { return a.t - b.t; });
    for (var i = 0; i < files.length && total > CACHE_KEEP; i++) {
      fs.unlink(files[i].p, noop);
      total -= files[i].sz;
    }
  }
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

$("#favfilter").addEventListener("click", function () {
  favOnly = !favOnly;
  this.classList.toggle("on", favOnly);
  lsSet("mudkit.lib.favonly", favOnly ? "1" : "0");
  redraw();
});

$("#pick").addEventListener("click", pickFolder);

$("#forget").addEventListener("click", function () {
  if (sel === RECENTS) {                 // "-" sur Recents : on les vide
    recents = []; lsSet("mudkit.lib.recents", "[]");
    sel = ""; lsSet("mudkit.lib.sel", "");
    renderTree(); redraw();
    return say("Recents vides.", "ok");
  }
  if (sel.indexOf(MISSING) === 0) {      // dossier introuvable : on l'oublie
    var r = sel.slice(MISSING.length);
    missing = missing.filter(function (m) { return m !== r; });
    deleteIndex(r);
    sel = ""; lsSet("mudkit.lib.sel", ""); saveRoots();
    return refreshAfterMount();
  }
  var li = selectedLib();
  if (li < 0 || !libs[li]) return say("Selectionne d'abord un dossier racine dans l'arbre.", "err");
  var lib = libs[li];
  lib.gone = true;                       // arrete son scan et ses ecritures d'index
  clearTimeout(lib.rescanTimer);
  if (lib.watcher) { try { lib.watcher.close(); } catch (e) {} }
  deleteIndex(lib.root);
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
    scan(lib, function () { if (++done === n) refreshAfterMount(); });   // scan() enregistre l'index
  });
});

$("#size").addEventListener("input", function (e) {
  tileW = +e.target.value;
  document.documentElement.style.setProperty("--tw", tileW + "px");
  lsSet("mudkit.lib.tilew", String(tileW));
  relayout();
});

/* grille virtuelle : redessin au defilement, nouvelles colonnes quand la
   largeur change (fenetre, separateur, panneau redimensionne) */
$("#grid").addEventListener("scroll", schedulePaint);
if (window.ResizeObserver) new ResizeObserver(function () { relayout(); }).observe($("#grid"));
else window.addEventListener("resize", relayout);

/* filtre par duree */
document.querySelectorAll("#durbar button").forEach(function (b) {
  b.addEventListener("click", function () {
    document.querySelectorAll("#durbar button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    durf = b.dataset.v;
    redraw();
  });
});

/* lecteur */
$("#vol").addEventListener("input", function (e) {
  muted = false;                       // bouger le volume = vouloir entendre
  applyVol();
  lsSet("mudkit.lib.vol", e.target.value);
});
$("#vol").addEventListener("wheel", function (e) {
  e.preventDefault();
  var v = Math.max(0, Math.min(100, (+this.value) + (e.deltaY < 0 ? 5 : -5)));
  this.value = v; muted = false; applyVol();
  lsSet("mudkit.lib.vol", String(v));
});
$("#pmute").addEventListener("click", function () { muted = !muted; applyVol(); });
$("#pplay").addEventListener("click", togglePlay);
$("#pprev").addEventListener("click", prev);
$("#pnext").addEventListener("click", function () { step(1); });
$("#pclose").addEventListener("click", stopAudio);
$("#pmarks").addEventListener("click", function () { clearMarks(cur); });
$("#prep").addEventListener("click", function () {
  setRepeat(REPEAT[(REPEAT.indexOf(repeat) + 1) % REPEAT.length]);
  say(REPEAT_TIP[repeat], "ok");
});
/* Glisser la barre = on entend ou on va. `seeking` empeche timeupdate de
   ramener le curseur sous la souris pendant le geste. */
$("#pseek").addEventListener("input", function () {
  seeking = true;
  this.style.setProperty("--p", (this.value / 10) + "%");
  if (cur) seekFrac(this.value / 1000);
});
$("#pseek").addEventListener("change", function () { seeking = false; syncTime(); });
$("#pprev").innerHTML = ICO.prev;
$("#pnext").innerHTML = ICO.next;
/* Les boutons du lecteur ne prennent pas le focus : sinon Espace, au lieu
   de lecture/pause, re-cliquerait le dernier bouton touche. */
document.querySelectorAll("#player button").forEach(function (b) {
  b.addEventListener("mousedown", function (e) { e.preventDefault(); });
});

$("#vclose").addEventListener("click", closeViewer);
$("#vadd").addEventListener("click", function () { if (viewerItem) doImport(viewerItem); });

/* Clic dans le vide autour du media = retour a la grille, sans passer par la
   croix. Le test "ev.target === this" garantit qu'on ne ferme QUE sur le fond :
   un clic sur la video elle-meme ou sur ses controles de lecture ne remonte
   pas jusqu'ici. Meme comportement que l'overlay de telechargement. */
$("#vbody").addEventListener("click", function (ev) {
  if (ev.target === this) closeViewer();
});

/* splitter */
(function () {
  var dragging = false;
  $("#split").addEventListener("mousedown", function (e) { dragging = true; e.preventDefault(); });
  document.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    var w = Math.max(110, Math.min(window.innerWidth * 0.6, e.clientX));
    $("#side").style.width = w + "px";
    if (!window.ResizeObserver) relayout();
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

/* Clavier : Echap ferme / met en pause, Espace = lecture/pause,
   fleches gauche/droite = -5 s / +5 s. Jamais pendant une saisie de texte. */
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    if ($("#dloverlay").classList.contains("on")) return $("#dloverlay").classList.remove("on");
    if ($("#viewer").classList.contains("on")) return closeViewer();
    if (clearMultiSel()) return;
    return pauseAudio();
  }
  var t = e.target, tag = t && t.tagName;
  if (tag === "TEXTAREA" || (tag === "INPUT" && t.type === "text")) return;
  if ($("#dloverlay").classList.contains("on")) return;
  // visionneuse video ouverte : ses raccourcis d'abord (Espace, J K L, fleches, I O P X...)
  if (vplayer && $("#viewer").classList.contains("on") && vplayer.key(e)) return;
  // I / O : points d'entree / sortie, aussi dans la visionneuse video
  if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[ioIO]$/.test(e.key)) {
    e.preventDefault();
    return setMark(e.key.toLowerCase() === "i" ? "in" : "out");
  }
  if ((e.ctrlKey || e.metaKey) && /^[aA]$/.test(e.key) && !$("#viewer").classList.contains("on")) {
    e.preventDefault();
    return selectAllInView();
  }
  if ($("#dloverlay").classList.contains("on") || $("#viewer").classList.contains("on")) return;
  if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); togglePlay(); }
  // fleches : -5 s / +5 s, y compris sur la barre de position (sinon elle
  // avancerait d'un millieme de la duree) ; le volume garde ses fleches
  else if ((tag !== "INPUT" || t.id === "pseek") && e.key === "ArrowLeft")  { e.preventDefault(); nudge(-5); }
  else if ((tag !== "INPUT" || t.id === "pseek") && e.key === "ArrowRight") { e.preventDefault(); nudge(5); }
});

/* Sans ca, Premiere recoit aussi Espace et les fleches quand le panneau a le
   focus (lecture de la timeline en plus de celle du son). Codes touches
   Windows : 32 Espace, 35/36 Fin/Debut, 37-40 fleches, plus les lettres du
   lecteur video (I O J K L M P X), avec ou sans Maj. */
var KEYS_WANTED = [{ keyCode:65, ctrlKey:true }];
[32, 35, 36, 37, 38, 39, 40, 73, 74, 75, 76, 77, 79, 80, 88].forEach(function (k) {
  KEYS_WANTED.push({ keyCode:k }, { keyCode:k, shiftKey:true });
});
try {
  if (window.__adobe_cep__ && window.__adobe_cep__.registerKeyEventsInterest)
    window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify(KEYS_WANTED));
} catch (e) {}

/* -------------------------------- demarrage ---------------------------- */

if (!nodeReq) {
  say("Node est desactive dans ce panneau - impossible de lire le disque.", "err");
} else {
  var savedRoots = [];
  try { savedRoots = JSON.parse(ls("mudkit.lib.roots", "[]")) || []; } catch (e) {}
  try { (JSON.parse(ls("mudkit.lib.favs", "[]")) || []).forEach(function (p) { favs[p] = 1; }); } catch (e) {}
  try { open = JSON.parse(ls("mudkit.lib.open", "{}")) || {}; } catch (e) { open = {}; }
  sel = ls("mudkit.lib.sel", "");
  // anciennes cles, par position du dossier ("2:Cinematic") : on repart de zero
  if (sel && sel !== RECENTS && sel.indexOf(MISSING) !== 0 && !isNodeKey(sel)) sel = "";
  Object.keys(open).forEach(function (k) { if (!isNodeKey(k)) delete open[k]; });
  try { recents = JSON.parse(ls("mudkit.lib.recents", "[]")) || []; } catch (e) { recents = []; }
  try { marks = JSON.parse(ls("mudkit.lib.marks", "{}")) || {}; } catch (e) { marks = {}; }
  setTimeout(function () { refreshProject(true); }, 3000);
  setInterval(refreshProject, 60000);
  window.addEventListener("focus", function () { refreshProject(); });
  window.addEventListener("mudkit-imported", refreshProjectSoon);   // telechargement importe
  action = ls("mudkit.lib.action", "insert");
  favOnly = ls("mudkit.lib.favonly", "0") === "1";
  tileW = +ls("mudkit.lib.tilew", "116") || 116;

  document.documentElement.style.setProperty("--tw", tileW + "px");
  $("#size").value = tileW;
  $("#vol").value = ls("mudkit.lib.vol", "70");
  applyVol();
  setRepeat(ls("mudkit.lib.repeat", "loop"));
  syncUI();
  $("#side").style.width = (+ls("mudkit.lib.sidew", "168") || 168) + "px";
  $("#favfilter").classList.toggle("on", favOnly);
  document.querySelectorAll("#libact button").forEach(function (b) { b.classList.toggle("on", b.dataset.v === action); });
  mkdirp(CACHE);

  var pending = savedRoots.filter(function (r) { return fs.existsSync(r); });
  missing = savedRoots.filter(function (r) { return !fs.existsSync(r); });
  setTimeout(purgeCache, 120000);
  if (!pending.length) { renderTree(); redraw(); }
  else {
    var left = pending.length;
    pending.forEach(function (r) {
      mountRoot(r, false, function () { if (--left === 0) refreshAfterMount(); });
    });
  }
}

})();
