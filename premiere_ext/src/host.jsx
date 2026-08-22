/* Cote Premiere Pro (ExtendScript) : import dans le chutier "Mudkit"
   + insertion / ecrasement sur la timeline au curseur. */

function mudkitBin() {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var it = root.children[i];
    if (it.type === ProjectItemType.BIN && it.name === "Mudkit") return it;
  }
  return root.createBin("Mudkit");
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

/* action : "insert" | "overwrite" | "bin" */
function mudkitImport(path, action) {
  try {
    var bin = mudkitBin();
    app.project.importFiles([path], true, bin, false);
    var item = mudkitFindItem(bin, path) ||
               mudkitFindItem(app.project.rootItem, path);
    if (!item) return "err:import introuvable dans le projet";

    if (action === "bin") return "imported";

    var seq = app.project.activeSequence;
    if (!seq) return "imported_no_seq";

    var isAudio = /\.(mp3|wav|m4a|flac|ogg|opus)$/i.test(path);
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
  } catch (e) {
    return "err:" + e.toString();
  }
}
