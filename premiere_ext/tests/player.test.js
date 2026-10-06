// Lecteur video partage (mudkit/ui/player.js) : copie du panneau identique,
// ASCII, et calculs de temps / planches.  Lancer : node premiere_ext/tests/player.test.js
const fs = require("fs"), path = require("path"), assert = require("assert");
const ROOT = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(ROOT, "mudkit", "ui", "player.js"));
const copy = fs.readFileSync(path.join(ROOT, "premiere_ext", "src", "player.js"));
assert.ok(src.equals(copy), "premiere_ext/src/player.js differe de mudkit/ui/player.js (relancer deployer.ps1)");
assert.ok(!/[^\x00-\x7e\r\n\t]/.test(src.toString("utf8")), "player.js doit rester en ASCII");
for (const f of ["library.js", "host.jsx"]) {
  const t = fs.readFileSync(path.join(ROOT, "premiere_ext", "src", f), "utf8");
  assert.ok(!/[^\x00-\x7e\r\n\t]/.test(t), f + " doit rester en ASCII");
}

const P = require(path.join(ROOT, "mudkit", "ui", "player.js"));
assert.strictEqual(P.fmt(83.46), "1:23.4");
assert.strictEqual(P.fmt(3725.05), "1:02:05.0");
assert.strictEqual(P.fmt(83.46, 25, true), "00:01:23:11");
assert.strictEqual(P.parse("1:23.5"), 83.5);
assert.strictEqual(P.parse("83,5"), 83.5);
assert.strictEqual(P.parse("1:02:03"), 3723);
assert.strictEqual(P.parse("00:01:23:12", 25), 83.48);
for (const bad of ["", "abc", "1:75", "2:", "1:2:3:4:5"]) assert.strictEqual(P.parse(bad), null, bad);

// planche YouTube 5x5 de 160x90, une image toutes les ~2 s, 5 planches (213 s)
const sb = { sheets: ["a", "b", "c", "d", "e"], w: 160, h: 90, rows: 5, cols: 5, fps: 0.507 };
let r = P.storyboard(sb, 0, 213);
assert.deepStrictEqual([r.url, r.x, r.y, r.sw, r.sh], ["a", 0, 0, 800, 450]);
r = P.storyboard(sb, 60, 213);            // image 30 -> planche 2, case 5 (2e ligne)
assert.deepStrictEqual([r.url, r.x, r.y], ["b", 0, 90]);
r = P.storyboard(sb, 212, 213);           // derniere planche incomplete : 8 images
assert.deepStrictEqual([r.url, r.sw, r.sh], ["e", 800, 180]);
assert.strictEqual(P.storyboard(null, 3, 10), null);

console.log("player.js : OK");
