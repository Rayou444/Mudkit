/* Cote Premiere Pro (ExtendScript) : import dans un chutier
   + insertion / ecrasement sur la timeline au curseur.
   Fichier volontairement en ASCII pur (ExtendScript et les accents = ennuis). */

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

var MUDKIT_AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff|wma|mka)$/i;
var MUDKIT_MOGRT_RE = /\.mogrt$/i;

/* Un MOGRT ne s'importe pas comme un media : il passe par
   sequence.importMGT(path, time, vidTrackOffset, audTrackOffset), qui le pose
   directement sur la timeline et renvoie un TrackItem. Il n'existe pas
   d'equivalent "poser dans un chutier". */
function mudkitPlaceMogrt(path, action) {
  if (action === "bin") return "mogrt_no_bin";
  var seq = app.project.activeSequence;
  if (!seq) return "mogrt_needs_sequence";
  var t = seq.getPlayerPosition();
  var item = null;
  try {
    item = seq.importMGT(path, t.ticks, 0, 0);
  } catch (e1) {
    try {
      item = seq.importMGT(path, t, 0, 0);
    } catch (e2) {
      return "imported_insert_failed:" + e2.toString();
    }
  }
  if (!item) return "imported_insert_failed:importMGT n'a rien renvoye";
  return "inserted";
}

/* Coeur commun : importe le fichier dans "bin" puis applique l'action.
   action : "insert" | "overwrite" | "bin" */
function mudkitPlace(path, action, bin) {
  if (MUDKIT_MOGRT_RE.test(path)) return mudkitPlaceMogrt(path, action);
  var item = mudkitFindItem(bin, path) ||
             mudkitFindItem(app.project.rootItem, path);
  if (!item) {
    app.project.importFiles([path], true, bin, false);
    item = mudkitFindItem(bin, path) ||
           mudkitFindItem(app.project.rootItem, path);
  }
  if (!item) return "err:import introuvable dans le projet";

  if (action === "bin") return "imported";

  var seq = app.project.activeSequence;
  if (!seq) return "imported_no_seq";

  var isAudio = MUDKIT_AUDIO_RE.test(path);
  var t = seq.getPlayerPosition();
  var track = isAudio ? seq.audioTracks[0] : seq.videoTracks[0];
  var fn = (action === "overwrite") ? "overwriteClip" : "insertClip";
  try {
    track[fn](item, t);
  } catch (e1) {
    try {
      track[fn](item, t.seconds);
    } catch (e2) {
      return "imported_insert_failed:" + e2.toString();
    }
  }
  return "inserted";
}

/* Onglet Telechargement : tout va dans le chutier "Mudkit". */
function mudkitImport(path, action) {
  try {
    return mudkitPlace(path, action, mudkitBin());
  } catch (e) {
    return "err:" + e.toString();
  }
}

/* Onglet Bibliotheque : chutier nomme d'apres le dossier de la bibliotheque. */
function mudkitLibImport(path, action, binName) {
  try {
    if (!binName) binName = "Mudkit";
    binName = String(binName).replace(/[\\\/:*?"<>|]/g, "_");
    return mudkitPlace(path, action, mudkitBinNamed(binName));
  } catch (e) {
    return "err:" + e.toString();
  }
}
