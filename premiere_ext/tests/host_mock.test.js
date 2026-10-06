// Teste host.jsx hors de Premiere, contre une maquette de son API ExtendScript
// (projet, chutiers, sequence, pistes).  Lancer : node premiere_ext/tests/host_mock.test.js
const fs = require("fs"), vm = require("vm");
const SRC = fs.readFileSync(require("path").join(__dirname, "..", "src", "host.jsx"), "utf8");

function Time() { this.seconds = 0; }
Object.defineProperty(Time.prototype, "ticks", { get() { return String(Math.round(this.seconds * 254016000000)); } });
const T = (s) => { const t = new Time(); t.seconds = s; return t; };
const DUR = { "C:/s/a.wav": 3, "C:/s/b.wav": 5, "C:/s/v.mp4": 7, "C:/s/v.fr.srt": 7 };
const log = [];

function coll(arr) { const c = { get numItems() { return arr.length; } }; return new Proxy(c, { get: (o, k) => (k in o ? o[k] : arr[+k]) }); }
function bin(name) {
  const kids = [];
  return { type: 2, name, kids, children: coll(kids),
    createBin(n) { const b = bin(n); kids.push(b); return b; } };
}
function clip(path, a = 0, b = DUR[path]) {
  return { type: 1, name: path.split("/").pop(), getMediaPath: () => path,
    getInPoint: () => T(a), getOutPoint: () => T(b),
    createSubClip(name, s, e, hard, v, au) {
      log.push(["subclip", name, s, e, v, au]);
      const toS = (x) => (typeof x === "string" ? +x / 254016000000 : x.seconds);
      return clip(path, toS(s), toS(e));
    } };
}
function track(name, busy) {
  const clips = busy ? [{ start: T(busy[0]), end: T(busy[1]) }] : [];
  return { clips: coll(clips),
    insertClip(item, t) { log.push(["insert", name, item.name, +t.seconds.toFixed(3)]); },
    overwriteClip(item, t) { log.push(["overwrite", name, item.name, +t.seconds.toFixed(3)]); } };
}
const root = bin("root");
const vtracks = [track("V1", [0, 60]), track("V2")], atracks = [track("A1")];
const seq = {
  getPlayerPosition: () => T(10),
  videoTracks: Object.assign(coll(vtracks), { get numTracks() { return vtracks.length; } }),
  audioTracks: coll(atracks),
  importMGT(p, ticks, v, a) { log.push(["mogrt", p, v]); return {}; },
  createCaptionTrack(item, sec, fmt) { log.push(["captions", item.name, sec, fmt]); },
};
const ctx = {
  Time, ProjectItemType: { BIN: 2, CLIP: 1 }, Sequence: { CAPTION_FORMAT_SUBTITLE: 2 },
  app: { project: { documentID: "doc1", rootItem: root, activeSequence: seq,
    importFiles(paths, s, b) { paths.forEach((p) => b.kids.push(clip(p))); log.push(["import", paths.join(",")]); } } },
};
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const run = (code) => { log.length = 0; const r = vm.runInContext(code, ctx); return [r, log.slice()]; };

const assert = require("assert");
let r;

r = run(`mudkitLibImport("C:/s/a.wav", "insert", "Sons", 1, 2.5)`);
assert.strictEqual(r[0], "inserted_sub");
assert.deepStrictEqual(r[1][1].slice(0, 4), ["subclip", "a.wav [0m01-0m03]", "254016000000", "635040000000"]);
assert.strictEqual(r[1][1][4], 0, "un son : sous-plan sans video");
assert.deepStrictEqual(r[1][2], ["insert", "A1", "a.wav", 10]);

r = run(`mudkitLibImportMany([["C:/s/a.wav"],["C:/s/b.wav",1,3],["C:/s/v.mp4"]], "insert", "Sons")`);
assert.strictEqual(r[0], "3|3||");
assert.deepStrictEqual(r[1].filter((x) => x[0] === "insert").map((x) => x[3]), [10, 13, 15],
                       "poses a la suite : 10 s, puis +3 s (a.wav), puis +2 s (passage de b.wav)");

r = run(`mudkitLibImport("C:/s/titre.mogrt", "insert", "Sons")`);
assert.deepStrictEqual(r, ["inserted", [["mogrt", "C:/s/titre.mogrt", 1]]], "MOGRT sur V2 : V1 est occupee");

r = run(`mudkitProjectMedia()`);
assert.deepStrictEqual(r[0].split(String.fromCharCode(10)), ["C:/s/a.wav", "C:/s/b.wav", "C:/s/v.mp4"]);

r = run(`mudkitImport("C:/s/v.mp4", "insert", "C:/s/v.fr.srt")`);
assert.strictEqual(r[0], "inserted|subs_track");
assert.deepStrictEqual(r[1].find((x) => x[0] === "captions"), ["captions", "v.fr.srt", 10, 2]);

r = run(`mudkitLibImport("C:/s/a.wav", "bin", "Sons")`);
assert.deepStrictEqual(r, ["imported", []], "fichier deja importe : retrouve en cache, pas reimporte");

console.log("host.jsx : 6 scenarios OK");
