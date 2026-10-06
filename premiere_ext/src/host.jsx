/* Cote Premiere Pro (ExtendScript) : import dans un chutier
   + insertion / ecrasement sur la timeline au curseur.
   Fichier volontairement en ASCII pur (ExtendScript et les accents = ennuis).
   ES3 : pas de Array.indexOf, pas de JSON garanti -> listes passees en
   litteraux de tableau, resultats renvoyes en texte. */

function mudkitBinNamed(name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var it = root.children[i];
    if (it.type === ProjectItemType.BIN && it.name === name) return it;
  }
  return root.createBin(name);
}

function mudkitBin() {
  return mudkitBinNamed("Mudkit");
}

function mudkitCleanBinName(name) {
  if (!name) name = "Mudkit";
  return String(name).replace(/[\\\/:*?"<>|]/g, "_");
}

function mudkitFindItem(root, mediaPath) {
  var lower = mediaPath.toLowerCase();
  for (var i = 0; i < root.children.numItems; i++) {
    var it = root.children[i];
    try {
      if (it.type === ProjectItemType.BIN) {
        var found = mudkitFindItem(it, mediaPath);
        if (found) return found;
      } else if (it.getMediaPath &&
                 String(it.getMediaPath()).toLowerCase() === lower) {
        return it;
      }
    } catch (e) {}
  }
  return null;
}

/* Fichiers deja retrouves dans le projet : sur un gros projet, relire tout
   l'arbre (un getMediaPath par element) a chaque import prenait du temps.
   Cle = projet + chemin ; un element supprime depuis est detecte et oublie. */
var MUDKIT_ITEMS = {};
function mudkitItemKey(mediaPath) {
  var doc = "";
  try { doc = app.project.documentID; } catch (e) {}
  return doc + "|" + mediaPath.toLowerCase();
}
function mudkitCached(mediaPath) {
  var key = mudkitItemKey(mediaPath), it = MUDKIT_ITEMS[key];
  if (!it) return null;
  try {
    if (String(it.getMediaPath()).toLowerCase() === mediaPath.toLowerCase()) return it;
  } catch (e) {}
  delete MUDKIT_ITEMS[key];
  return null;
}
function mudkitRemember(mediaPath, it) {
  if (it) MUDKIT_ITEMS[mudkitItemKey(mediaPath)] = it;
  return it;
}

/* Le fichier dans le projet (deja present, ou importe dans "bin"). */
function mudkitGetItem(path, bin) {
  var item = mudkitCached(path) ||
             mudkitRemember(path, mudkitFindItem(bin, path) ||
                                  mudkitFindItem(app.project.rootItem, path));
  if (!item) {
    app.project.importFiles([path], true, bin, false);
    // un fichier tout juste importe est dans le chutier : pas besoin de
    // relire tout le projet dans le cas normal
    item = mudkitRemember(path, mudkitFindItem(bin, path) ||
                                mudkitFindItem(app.project.rootItem, path));
  }
  return item;
}

var MUDKIT_AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff|wma|mka)$/i;
var MUDKIT_MOGRT_RE = /\.mogrt$/i;
var MUDKIT_TICKS = 254016000000;   // ticks Premiere par seconde

function mudkitTime(seconds) {
  var t = new Time();
  t.seconds = seconds;
  return t;
}
function mudkitClock(s) {
  s = Math.round(s);
  var m = Math.floor(s / 60), r = s % 60;
  return m + "m" + (r < 10 ? "0" : "") + r;
}

/* Points d'entree / sortie choisis dans le panneau : on cree un sous-plan
   (le fichier d'origine garde ses propres points), range a cote de lui. */
function mudkitSubclip(item, inSec, outSec, isAudio) {
  var name = item.name + " [" + mudkitClock(inSec) + "-" + mudkitClock(outSec) + "]";
  var take = isAudio ? 0 : 1, sub = null;
  try {
    sub = item.createSubClip(name, String(Math.round(inSec * MUDKIT_TICKS)),
                             String(Math.round(outSec * MUDKIT_TICKS)), 0, take, 1);
  } catch (e1) {
    sub = item.createSubClip(name, mudkitTime(inSec), mudkitTime(outSec), 0, take, 1);
  }
  return sub;
}

function mudkitDuration(item) {
  try { return item.getOutPoint().seconds - item.getInPoint().seconds; } catch (e) { return 0; }
}

/* Pose sur la 1re piste (A1 pour un son, V1 sinon) a l'instant t. */
function mudkitPut(seq, item, isAudio, action, t) {
  var track = isAudio ? seq.audioTracks[0] : seq.videoTracks[0];
  var fn = (action === "overwrite") ? "overwriteClip" : "insertClip";
  try {
    track[fn](item, t);
  } catch (e1) {
    track[fn](item, t.seconds);
  }
}

/* Premiere piste video libre a l'instant t (pour un MOGRT). */
function mudkitFreeVideoTrack(seq, t) {
  var at = t.seconds, n = seq.videoTracks.numTracks;
  for (var i = 0; i < n; i++) {
    var clips = seq.videoTracks[i].clips, busy = false;
    for (var j = 0; j < clips.numItems; j++) {
      var c = clips[j];
      if (c.start.seconds <= at && c.end.seconds > at) { busy = true; break; }
    }
    if (!busy) return i;
  }
  return n;
}

/* Un MOGRT ne s'importe pas comme un media : il passe par
   sequence.importMGT(path, time, vidTrackOffset, audTrackOffset), qui le pose
   directement sur la timeline et renvoie un TrackItem. Il n'existe pas
   d'equivalent "poser dans un chutier". */
function mudkitPlaceMogrt(path, action, t) {
  if (action === "bin") return "mogrt_no_bin";
  var seq = app.project.activeSequence;
  if (!seq) return "mogrt_needs_sequence";
  if (!t) t = seq.getPlayerPosition();
  /* Premiere piste video LIBRE a la tete de lecture : avant, toujours V1,
     par-dessus le rush. Toutes prises : la piste au-dessus de la derniere
     (Premiere l'ajoute) ; refusee : V1 comme avant. */
  var vt = mudkitFreeVideoTrack(seq, t);
  var item = null, offsets = vt > 0 ? [vt, 0] : [0];
  for (var k = 0; k < offsets.length && !item; k++) {
    try {
      item = seq.importMGT(path, t.ticks, offsets[k], 0);
    } catch (e1) {
      try {
        item = seq.importMGT(path, t, offsets[k], 0);
      } catch (e2) {
        if (k === offsets.length - 1) return "imported_insert_failed:" + e2.toString();
      }
    }
  }
  if (!item) return "imported_insert_failed:importMGT n'a rien renvoye";
  return "inserted";
}

/* Coeur commun : importe le fichier dans "bin" puis applique l'action.
   action : "insert" | "overwrite" | "bin". inSec / outSec : passage choisi
   dans le panneau (facultatif). */
function mudkitPlace(path, action, bin, inSec, outSec) {
  if (MUDKIT_MOGRT_RE.test(path)) return mudkitPlaceMogrt(path, action);
  var isAudio = MUDKIT_AUDIO_RE.test(path);
  var item = mudkitGetItem(path, bin);
  if (!item) return "err:import introuvable dans le projet";

  var sub = "";
  if (inSec != null && outSec != null && outSec > inSec) {
    try {
      var s = mudkitSubclip(item, inSec, outSec, isAudio);
      if (s) { item = s; sub = "_sub"; }
    } catch (e0) { sub = "_nosub"; }   // passage refuse : le fichier entier
  }
  if (action === "bin") return "imported" + sub;

  var seq = app.project.activeSequence;
  if (!seq) return "imported_no_seq";
  try {
    mudkitPut(seq, item, isAudio, action, seq.getPlayerPosition());
  } catch (e2) {
    return "imported_insert_failed:" + e2.toString();
  }
  return "inserted" + sub;
}

/* Sous-titres (.srt) telecharges avec la video : importes dans le chutier
   puis, si la video vient d'etre posee, ajoutes en piste de legendes a la
   meme position (Premiere 2022 et +). */
function mudkitAddCaptions(srt, bin, t) {
  app.project.importFiles([srt], true, bin, false);
  var item = mudkitFindItem(bin, srt);
  if (!item) return "subs_missing";
  if (!t) return "subs_bin";
  var seq = app.project.activeSequence;
  if (!seq || !seq.createCaptionTrack) return "subs_bin";
  try {
    var fmt = (typeof Sequence !== "undefined" && Sequence.CAPTION_FORMAT_SUBTITLE !== undefined)
      ? Sequence.CAPTION_FORMAT_SUBTITLE : undefined;
    if (fmt === undefined) seq.createCaptionTrack(item, t.seconds);
    else seq.createCaptionTrack(item, t.seconds, fmt);
    return "subs_track";
  } catch (e) {
    return "subs_bin";
  }
}

/* Onglet Telechargement : tout va dans le chutier "Mudkit". */
function mudkitImport(path, action, subs) {
  try {
    var bin = mudkitBin(), seq = app.project.activeSequence;
    var t = seq ? seq.getPlayerPosition() : null;
    var res = mudkitPlace(path, action, bin);
    if (subs) res += "|" + mudkitAddCaptions(subs, bin, res.indexOf("inserted") === 0 ? t : null);
    return res;
  } catch (e) {
    return "err:" + e.toString();
  }
}

/* Onglet Bibliotheque : chutier nomme d'apres le dossier de la bibliotheque. */
function mudkitLibImport(path, action, binName, inSec, outSec) {
  try {
    return mudkitPlace(path, action, mudkitBinNamed(mudkitCleanBinName(binName)), inSec, outSec);
  } catch (e) {
    return "err:" + e.toString();
  }
}

/* Plusieurs fichiers d'un coup (multi-selection) : poses LES UNS APRES LES
   AUTRES a partir de la tete de lecture, dans l'ordre de la grille. Poses
   un par un au meme endroit, chacun aurait pousse le precedent : ordre
   inverse. items = [[chemin, in, out], ...].
   Renvoie "poses|total|noseq|1re erreur". */
function mudkitLibImportMany(items, action, binName) {
  try {
    var bin = mudkitBinNamed(mudkitCleanBinName(binName));
    var seq = app.project.activeSequence;
    var t = seq ? seq.getPlayerPosition() : null, ok = 0, err = "";
    for (var i = 0; i < items.length; i++) {
      var path = items[i][0], inSec = items[i][1], outSec = items[i][2];
      try {
        if (MUDKIT_MOGRT_RE.test(path)) {
          var r = mudkitPlaceMogrt(path, action, t);
          if (r === "inserted") ok++; else if (!err) err = r;
          continue;
        }
        var isAudio = MUDKIT_AUDIO_RE.test(path);
        var item = mudkitGetItem(path, bin);
        if (!item) { if (!err) err = "introuvable : " + path; continue; }
        if (inSec != null && outSec != null && outSec > inSec) {
          try { var s = mudkitSubclip(item, inSec, outSec, isAudio); if (s) item = s; } catch (e0) {}
        }
        if (action === "bin" || !seq) { ok++; continue; }
        mudkitPut(seq, item, isAudio, action, t);
        t = mudkitTime(t.seconds + mudkitDuration(item));
        ok++;
      } catch (e1) {
        if (!err) err = e1.toString();
      }
    }
    return ok + "|" + items.length + "|" + (seq || action === "bin" ? "" : "noseq") + "|" + err;
  } catch (e) {
    return "err:" + e.toString();
  }
}

/* Chemins de tous les medias du projet ouvert, un par ligne : le panneau
   en tire le badge "deja dans ce projet". */
function mudkitProjectMedia() {
  var out = [];
  function walk(root) {
    for (var i = 0; i < root.children.numItems; i++) {
      var it = root.children[i];
      try {
        if (it.type === ProjectItemType.BIN) walk(it);
        else if (it.getMediaPath) {
          var p = String(it.getMediaPath());
          if (p) out.push(p);
        }
      } catch (e) {}
    }
  }
  try {
    if (!app.project || !app.project.rootItem) return "";
    walk(app.project.rootItem);
  } catch (e) {
    return "err:" + e.toString();
  }
  return out.join("\n");
}
