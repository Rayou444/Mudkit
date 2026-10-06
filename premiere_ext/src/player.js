/* MkPlayer : le lecteur video de Mudkit (appli + panneau Premiere).

   Source unique : mudkit/ui/player.js. Le panneau en garde une copie
   identique (premiere_ext/src/player.js) que deployer.ps1 et build.ps1
   recopient ; un test verifie qu'elles ne divergent pas.
   ASCII seulement (le panneau CEP n'aime pas les accents) : les textes
   affiches ont leurs accents en echappements \u.

   - barre de temps : image au survol (planche de vignettes), zone deja
     chargee, passage debut / fin reglable a la souris, au clavier ou en
     tapant les temps ;
   - temps au dixieme, ou en timecode (clic sur le temps) ;
   - image par image, J / K / L, vitesse, boucle, volume ;
   - son sur une piste a part si besoin (flux YouTube : image et son
     separes), tenu cale sur l'image.

   var p = new MkPlayer(conteneur, { src, audioSrc, duration, fps, range,
             a, b, thumbs(t), volume, muted, loop, autoplay, onRange(a, b),
             onVolume(v, muted), onError(err), onReady() });
   p.key(evenement) -> true si la touche a servi. */
(function (root) {
"use strict";

var CSS = [
".mkp{position:relative;display:flex;flex-direction:column;background:#0c0c0c;color:#e6e6e6;",
"  border-radius:var(--mkp-radius,6px);overflow:hidden;outline:none;min-width:0;min-height:0;",
"  -webkit-user-select:none;user-select:none;font-size:var(--mkp-fs,12px)}",
".mkp:focus-visible{box-shadow:0 0 0 2px var(--mkp-accent,#F28A36)}",
".mkp-stage{position:relative;flex:1 1 auto;min-height:0;background:#000;cursor:pointer;overflow:hidden}",
".mkp.fixed .mkp-stage{flex:0 0 auto;aspect-ratio:16/9}",
".mkp-v{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:block;background:#000}",
".mkp-poster{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:none}",
".mkp.noplay .mkp-poster{display:block}",
".mkp-big{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;",
"  background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;pointer-events:none;",
"  opacity:0;transition:opacity .15s}",
".mkp-big svg{width:20px;height:20px;margin-left:3px;fill:#fff}",
".mkp.paused .mkp-big{opacity:1}",
".mkp.wait .mkp-big,.mkp.noplay .mkp-big{opacity:0}",
".mkp-spin{position:absolute;left:50%;top:50%;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;",
"  border:3px solid rgba(255,255,255,.22);border-top-color:#fff;animation:mkp-r .8s linear infinite;display:none}",
".mkp.wait .mkp-spin{display:block}",
"@keyframes mkp-r{to{transform:rotate(360deg)}}",
".mkp-msg{position:absolute;left:10px;right:10px;top:50%;transform:translateY(-50%);text-align:center;",
"  line-height:1.6;color:#d8d8d8;text-shadow:0 1px 3px #000;pointer-events:none;display:none}",
".mkp.hasmsg .mkp-msg{display:block}",
".mkp.hasmsg .mkp-big{opacity:0}",
".mkp-bar{position:relative;flex:0 0 auto;height:18px;margin:4px 10px 0;cursor:pointer;touch-action:none}",
".mkp-track{position:absolute;left:0;right:0;top:7px;height:4px;border-radius:2px;background:rgba(255,255,255,.17);",
"  transition:top .08s,height .08s}",
".mkp-bar:hover .mkp-track,.mkp.drag .mkp-track{top:6px;height:6px}",
".mkp-buf,.mkp-prog,.mkp-sel{position:absolute;top:0;bottom:0;left:0;border-radius:2px}",
".mkp-buf{background:rgba(255,255,255,.2)}",
".mkp-prog{background:var(--mkp-accent,#F28A36)}",
".mkp-sel{top:-4px;bottom:-4px;background:var(--mkp-range,rgba(229,163,46,.32));display:none;border-radius:1px}",
".mkp.ranged .mkp-sel{display:block}",
".mkp-head{position:absolute;top:4px;width:10px;height:10px;margin-left:-5px;border-radius:50%;background:#fff;",
"  box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none}",
".mkp-h{position:absolute;top:0;width:14px;height:18px;margin-left:-7px;cursor:ew-resize;display:none;z-index:2}",
".mkp-h:after{content:'';position:absolute;left:5px;top:0;width:4px;height:18px;border-radius:2px;",
"  background:var(--mkp-range-edge,#E5A32E);box-shadow:0 0 0 1px rgba(0,0,0,.5)}",
".mkp.ranged .mkp-h{display:block}",
".mkp-tip{position:absolute;bottom:22px;left:0;transform:translateX(-50%);pointer-events:none;display:none;",
"  background:rgba(12,12,12,.94);border:1px solid rgba(255,255,255,.14);border-radius:4px;padding:3px;",
"  text-align:center;white-space:nowrap;z-index:4;font-variant-numeric:tabular-nums}",
".mkp-tipimg{width:160px;height:90px;background-repeat:no-repeat;background-color:#000;margin-bottom:2px;display:none}",
".mkp-ctl,.mkp-range{flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:1px 2px;padding:2px 6px 4px}",
".mkp-range{display:none;border-top:1px solid rgba(255,255,255,.07);padding-top:4px}",
".mkp.withrange .mkp-range{display:flex}",
".mkp-btn{background:none;border:0;color:inherit;font:inherit;padding:3px 5px;min-height:22px;border-radius:3px;",
"  cursor:pointer;display:inline-flex;align-items:center;gap:4px;line-height:1;white-space:nowrap}",
".mkp-btn:hover{background:rgba(255,255,255,.1)}",
".mkp-btn:disabled{opacity:.35;cursor:default;background:none}",
".mkp-btn.on{color:var(--mkp-accent,#F28A36)}",
".mkp-btn svg{width:14px;height:14px;flex:0 0 auto}",
".mkp-time{font-variant-numeric:tabular-nums;padding:0 5px;cursor:pointer;color:#cfcfcf;white-space:nowrap}",
".mkp-grow{flex:1 1 auto}",
".mkp-vol{width:64px;height:12px;margin:0 2px;accent-color:var(--mkp-accent,#F28A36);cursor:pointer}",
".mkp-range input{width:6.2em;background:#1b1b1b;border:1px solid #363636;color:#eee;border-radius:3px;",
"  padding:3px 4px;font:inherit;font-variant-numeric:tabular-nums;text-align:center;outline:none}",
".mkp-range input:focus{border-color:var(--mkp-accent,#F28A36)}",
".mkp-range input.bad{border-color:#EB5757;color:#FF8A8A}",
".mkp-arrow{color:#8a8a8a;padding:0 1px}",
".mkp-len{color:var(--mkp-range-edge,#E5A32E);padding:0 4px;white-space:nowrap;font-variant-numeric:tabular-nums}",
".mkp.compact .mkp-vol{width:48px}",
".mkp.compact .mkp-lbl{display:none}"
].join("\n");

var SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
var ICON = {
  play:  '<svg viewBox="0 0 16 16"><path d="M5 3l8 5-8 5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z" fill="currentColor"/></svg>',
  big:   '<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>',
  fprev: SVG + '<path d="M4 3.5v9"/><path d="M12.5 3.5L6.5 8l6 4.5z" fill="currentColor" stroke="none"/></svg>',
  fnext: SVG + '<path d="M12 3.5v9"/><path d="M3.5 3.5l6 4.5-6 4.5z" fill="currentColor" stroke="none"/></svg>',
  loop:  SVG + '<path d="M2.8 7.4v-.9a2 2 0 0 1 2-2h7.6M10.6 2.6l1.9 1.9-1.9 1.9M13.2 8.6v.9a2 2 0 0 1-2 2H3.6M5.4 13.4l-1.9-1.9 1.9-1.9"/></svg>',
  vol:   SVG + '<path d="M2.4 6h2.5l3.3-2.8v9.6L4.9 10H2.4z" fill="currentColor" stroke="none"/><path d="M10.5 5.7a3.3 3.3 0 0 1 0 4.6M12.3 3.9a5.9 5.9 0 0 1 0 8.2"/></svg>',
  mute:  SVG + '<path d="M2.4 6h2.5l3.3-2.8v9.6L4.9 10H2.4z" fill="currentColor" stroke="none"/><path d="M10.3 6.1l3.6 3.8M13.9 6.1l-3.6 3.8"/></svg>',
  min:   SVG + '<path d="M6 3H3.5v10H6"/><path d="M9 8h4.5M11.5 6l2 2-2 2"/></svg>',
  mout:  SVG + '<path d="M10 3h2.5v10H10"/><path d="M7 8H2.5M4.5 6l-2 2 2 2"/></svg>',
  psel:  SVG + '<path d="M2.5 3.5v9M13.5 3.5v9"/><path d="M6 5l5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
  clr:   SVG + '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>'
};

var T = {   /* textes (accents echappes) */
  play: "Lecture / pause (Espace ou K)",
  fprev: "Image pr\u00E9c\u00E9dente (fl\u00E8che gauche, Maj : 1 s)",
  fnext: "Image suivante (fl\u00E8che droite, Maj : 1 s)",
  time: "Clic : dixi\u00E8mes de seconde / timecode",
  rate: "Vitesse de lecture (L acc\u00E9l\u00E8re, K arr\u00EAte)",
  loop: "Lecture en boucle",
  mute: "Couper le son (M)",
  vol: "Volume (fl\u00E8ches haut / bas)",
  mark_in: "D\u00E9but du passage ici (I)",
  mark_out: "Fin du passage ici (O)",
  ta: "D\u00E9but du passage : tape un temps (1:23.5) puis Entr\u00E9e",
  tb: "Fin du passage : tape un temps (1:45) puis Entr\u00E9e",
  psel: "\u00C9couter le passage en boucle (P)",
  clr: "Effacer le passage (X)",
  reset: "Tout prendre (X)",
  lbl_in: "D\u00E9but", lbl_out: "Fin", lbl_psel: "Passage",
  handle_a: "D\u00E9but du passage (glisse)", handle_b: "Fin du passage (glisse)",
  err: "Lecture impossible ici."
};

var cssDone = false;
function injectCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  var s = document.createElement("style");
  s.id = "mkp-css";
  s.textContent = CSS;
  (document.head || document.documentElement).appendChild(s);
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* 83.46 -> "1:23.4" (dixiemes), ou "00:01:23:11" en timecode */
function fmt(t, fps, tc) {
  if (!isFinite(t) || t < 0) t = 0;
  if (tc && fps > 0) {
    var r = Math.round(fps), n = Math.floor(t * fps + 1e-6);
    var ff = n % r, s = Math.floor(n / r);
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60) + ":" + pad(ff);
  }
  var d = Math.floor(t * 10 + 1e-6), ds = d % 10, sec = Math.floor(d / 10);
  var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, ss = sec % 60;
  return (h ? h + ":" + pad(m) : m) + ":" + pad(ss) + "." + ds;
}
function pad(n) { return (n < 10 ? "0" : "") + n; }

/* "1:23.5", "83,5", "1:02:03", "00:01:23:12" (timecode, images) -> secondes */
function parse(s, fps) {
  s = String(s == null ? "" : s).trim().replace(",", ".").replace(/\s+/g, "");
  if (!s) return null;
  var parts = s.split(":"), frames = 0;
  if (parts.length > 4) return null;
  if (parts.length === 4) {
    var f = parts.pop();
    if (!/^\d+$/.test(f)) return null;
    frames = +f / (fps > 0 ? fps : 25);
  }
  var t = 0;
  for (var i = 0; i < parts.length; i++) {
    var last = i === parts.length - 1;
    if (!(last ? /^\d+(\.\d*)?$|^\.\d+$/ : /^\d+$/).test(parts[i])) return null;
    if (i > 0 && +parts[i] >= 60) return null;
    t = t * 60 + parseFloat(parts[i]);
  }
  return t + frames;
}

function MkPlayer(host, o) {
  injectCss();
  o = o || {};
  var self = this;
  this.o = o;
  this.fps = o.fps > 0 ? o.fps : 0;
  this.tc = false;
  this.dur = o.duration > 0 ? o.duration : 0;
  this.range = !!o.range;                // affiche la ligne "passage"
  this.always = o.range === "always";   // le passage existe toujours (debut..fin)
  this.a = o.a != null ? +o.a : null;
  this.b = o.b != null ? +o.b : null;
  if (this.always && this.a == null && this.dur) { this.a = 0; this.b = this.dur; }
  this.loopSel = false;
  this.rates = [1, 1.5, 2, 4, 0.5];
  this.vol = o.volume != null ? clamp(+o.volume, 0, 1) : 1;
  this.muted = !!o.muted;
  this.dead = false;
  this._raf = 0;
  this._off = [];

  var r = this.el = document.createElement("div");
  r.className = "mkp paused" + (this.range ? " withrange" : "") + (o.fixed ? " fixed" : "") +
                (o.compact ? " compact" : "");
  r.tabIndex = 0;
  r.innerHTML =
    '<div class="mkp-stage"><img class="mkp-poster" alt=""><video class="mkp-v" playsinline preload="auto"></video>' +
    '<div class="mkp-big">' + ICON.big + '</div><div class="mkp-spin"></div><div class="mkp-msg"></div></div>' +
    '<div class="mkp-bar"><div class="mkp-track"><i class="mkp-buf"></i><i class="mkp-sel"></i><i class="mkp-prog"></i></div>' +
    '<i class="mkp-head"></i><b class="mkp-h mkp-ha"></b><b class="mkp-h mkp-hb"></b>' +
    '<div class="mkp-tip"><div class="mkp-tipimg"></div><span></span></div></div>' +
    '<div class="mkp-ctl">' +
      '<button class="mkp-btn mkp-play"></button>' +
      '<button class="mkp-btn mkp-fprev">' + ICON.fprev + '</button>' +
      '<button class="mkp-btn mkp-fnext">' + ICON.fnext + '</button>' +
      '<span class="mkp-time"></span><span class="mkp-grow"></span>' +
      '<button class="mkp-btn mkp-rate">1x</button>' +
      '<button class="mkp-btn mkp-loop">' + ICON.loop + '</button>' +
      '<button class="mkp-btn mkp-mute"></button>' +
      '<input class="mkp-vol" type="range" min="0" max="100">' +
    '</div>' +
    '<div class="mkp-range">' +
      '<button class="mkp-btn mkp-in">' + ICON.min + '<span class="mkp-lbl">' + T.lbl_in + '</span></button>' +
      '<input class="mkp-ta" type="text" spellcheck="false">' +
      '<span class="mkp-arrow">&rarr;</span>' +
      '<input class="mkp-tb" type="text" spellcheck="false">' +
      '<button class="mkp-btn mkp-out"><span class="mkp-lbl">' + T.lbl_out + '</span>' + ICON.mout + '</button>' +
      '<span class="mkp-len"></span><span class="mkp-grow"></span>' +
      '<button class="mkp-btn mkp-psel">' + ICON.psel + '<span class="mkp-lbl">' + T.lbl_psel + '</span></button>' +
      '<button class="mkp-btn mkp-clr">' + ICON.clr + '</button>' +
    '</div>';
  host.appendChild(r);

  function q(c) { return r.querySelector(c); }
  var v = this.v = q(".mkp-v");
  this.$ = { stage:q(".mkp-stage"), poster:q(".mkp-poster"), msg:q(".mkp-msg"), bar:q(".mkp-bar"),
             buf:q(".mkp-buf"), prog:q(".mkp-prog"), sel:q(".mkp-sel"), head:q(".mkp-head"),
             ha:q(".mkp-ha"), hb:q(".mkp-hb"), tip:q(".mkp-tip"), tipimg:q(".mkp-tipimg"),
             tiptxt:q(".mkp-tip span"), play:q(".mkp-play"), time:q(".mkp-time"), rate:q(".mkp-rate"),
             loop:q(".mkp-loop"), mute:q(".mkp-mute"), vol:q(".mkp-vol"), ta:q(".mkp-ta"), tb:q(".mkp-tb"),
             len:q(".mkp-len"), psel:q(".mkp-psel"), clr:q(".mkp-clr"), min:q(".mkp-in"), mout:q(".mkp-out") };
  var $ = this.$;
  $.play.title = T.play; q(".mkp-fprev").title = T.fprev; q(".mkp-fnext").title = T.fnext;
  $.time.title = T.time; $.rate.title = T.rate; $.loop.title = T.loop; $.mute.title = T.mute;
  $.vol.title = T.vol; $.min.title = T.mark_in; $.mout.title = T.mark_out; $.ta.title = T.ta;
  $.tb.title = T.tb; $.psel.title = T.psel; $.clr.title = this.always ? T.reset : T.clr;
  $.ha.title = T.handle_a; $.hb.title = T.handle_b;
  if (o.poster) $.poster.src = o.poster;

  v.loop = o.loop !== false;
  $.loop.classList.toggle("on", v.loop);
  $.vol.value = Math.round(this.vol * 100);

  /* ---- evenements de la video ---- */
  function on(t, ev, fn) { t.addEventListener(ev, fn); self._off.push([t, ev, fn]); }
  on(v, "loadedmetadata", function () {
    if (isFinite(v.duration) && v.duration > 0) self.dur = v.duration;
    if (self.always && self.a == null) { self.a = 0; self.b = self.dur; }
    if (self.b != null && self.b > self.dur && self.dur) self.b = self.dur;
    if (self._seekTo != null) { var t = self._seekTo; self._seekTo = null; self.seek(t); }
    r.classList.remove("noplay");
    self.paint(); self.paintRange();
    if (o.onReady) o.onReady(self);
  });
  on(v, "durationchange", function () { if (isFinite(v.duration) && v.duration > 0) { self.dur = v.duration; self.paint(); self.paintRange(); } });
  on(v, "play", function () { r.classList.remove("paused"); self.btns(); self.loopRaf(); if (self.au) self.au.play().catch(function () {}); });
  on(v, "pause", function () { r.classList.add("paused"); self.btns(); self.paint(); if (self.au) self.au.pause(); });
  on(v, "ended", function () { r.classList.add("paused"); self.btns(); if (self.au) self.au.pause(); });
  on(v, "waiting", function () { self.waitSoon(true); if (self.au) self.au.pause(); });
  on(v, "seeking", function () { self.waitSoon(true); self.syncAudio(true); });
  on(v, "seeked", function () { self.waitSoon(false); self.paint(); });
  on(v, "playing", function () { self.waitSoon(false); self.syncAudio(true); if (self.au) self.au.play().catch(function () {}); });
  on(v, "canplay", function () { self.waitSoon(false); });
  on(v, "progress", function () { self.paintBuf(); });
  on(v, "timeupdate", function () { if (v.paused) self.paint(); self.syncAudio(false); });
  on(v, "ratechange", function () { if (self.au) self.au.playbackRate = v.playbackRate; self.btns(); });
  on(v, "error", function () {
    self.waitSoon(false);
    if (o.onError && o.onError(v.error, self)) return;
    self.msg(T.err);
  });

  /* ---- clic sur l'image : lecture / pause (sans remonter : la visionneuse
     du panneau se ferme sur un clic dans le vide) ---- */
  on($.stage, "click", function (e) { e.stopPropagation(); if (!r.classList.contains("hasmsg")) self.toggle(); r.focus(); });
  on($.play, "click", function () { self.toggle(); });
  on(q(".mkp-fprev"), "click", function (e) { if (e.shiftKey) self.frame(0, -1); else self.frame(-1); });
  on(q(".mkp-fnext"), "click", function (e) { if (e.shiftKey) self.frame(0, 1); else self.frame(1); });
  on($.time, "click", function () { if (self.fps) { self.tc = !self.tc; self.paint(); self.paintRange(); } });
  on($.rate, "click", function () {
    var i = self.rates.indexOf(v.playbackRate);
    self.setRate(self.rates[(i + 1) % self.rates.length]);
  });
  on($.loop, "click", function () { v.loop = !v.loop; $.loop.classList.toggle("on", v.loop); });
  on($.mute, "click", function () { self.setVolume(self.vol, !self.muted); });
  on($.vol, "input", function () { self.setVolume((+$.vol.value) / 100, false); });
  on($.min, "click", function () { self.mark("a"); });
  on($.mout, "click", function () { self.mark("b"); });
  on($.psel, "click", function () { self.playRange(); });
  on($.clr, "click", function () { self.clearRange(); });
  [["ta", "a"], ["tb", "b"]].forEach(function (p) {
    var inp = $[p[0]];
    on(inp, "keydown", function (e) {
      e.stopPropagation();   // les touches tapees ne pilotent pas le lecteur
      if (e.key === "Enter") { self.typed(inp, p[1]); inp.select(); }
      else if (e.key === "Escape") { inp.classList.remove("bad"); self.paintRange(); inp.blur(); }
    });
    on(inp, "change", function () { self.typed(inp, p[1]); });
    on(inp, "blur", function () { if (!inp.classList.contains("bad")) self.paintRange(); });
  });

  /* ---- barre de temps : survol, clic / glisse, poignees du passage ---- */
  var drag = null, wasPlaying = false, lastSeek = 0, pendingT = null;
  function timeAt(x) {
    var rc = $.bar.getBoundingClientRect();
    return clamp((x - rc.left) / Math.max(1, rc.width), 0, 1) * (self.dur || 0);
  }
  function seekSoft(t) {
    // pendant un glisse : au plus un saut toutes les 90 ms (flux distants)
    pendingT = t;
    var now = Date.now();
    if (now - lastSeek < 90) return;
    lastSeek = now; pendingT = null;
    self.seek(t);
  }
  on($.bar, "pointerdown", function (e) {
    if (!self.dur || e.button !== 0) return;
    e.preventDefault(); r.focus();
    var t = timeAt(e.clientX);
    if (e.target === $.ha || e.target === $.hb) drag = e.target === $.ha ? "a" : "b";
    else {
      drag = "seek";
      // cliquer hors du passage met fin a son ecoute en boucle
      if (self.loopSel && (t < self.a || t > self.b)) { self.loopSel = false; self.btns(); }
      wasPlaying = !v.paused;
      if (wasPlaying) v.pause();
      self.seek(t);
    }
    r.classList.add("drag");
    try { $.bar.setPointerCapture(e.pointerId); } catch (er) {}
  });
  on($.bar, "pointermove", function (e) {
    if (!self.dur) return;
    var t = timeAt(e.clientX);
    self.tip(e.clientX, t);
    if (!drag) return;
    if (drag === "seek") { self._shown = t; self.paint(t); seekSoft(t); return; }
    self.setMark(drag, t, true);
    seekSoft(drag === "a" ? self.a : self.b);
  });
  function endDrag() {
    if (!drag) return;
    var d = drag; drag = null;
    r.classList.remove("drag");
    if (pendingT != null) { self.seek(pendingT); pendingT = null; }
    if (d === "seek") { self._shown = null; if (wasPlaying) self.play(); }
    else self.rangeChanged();
  }
  on($.bar, "pointerup", endDrag);
  on($.bar, "pointercancel", endDrag);
  on($.bar, "pointerleave", function () { if (!drag) $.tip.style.display = "none"; });

  /* raccourcis quand le lecteur a le focus (clic dessus, Tab) */
  on(r, "keydown", function (e) { self.key(e); });

  /* son sur une piste separee (flux YouTube) */
  if (o.audioSrc) this.attachAudio(o.audioSrc);
  this.setVolume(this.vol, this.muted, true);
  r.classList.add("noplay");
  if (o.src) this.load(o.src, o.audioSrc, o.start);
  this.btns(); this.paint(); this.paintRange();
}

var P = MkPlayer.prototype;

P.load = function (src, audioSrc, start) {
  this.msg("");
  if (audioSrc !== undefined) this.attachAudio(audioSrc);
  this._seekTo = start > 0 ? start : null;
  this.v.src = src;
  if (this.o.autoplay) this.play();
};

/* Remplace la source en gardant la position (version convertie, etc.) */
P.swap = function (src) {
  var t = this.v.currentTime || 0, playing = !this.v.paused;
  this.msg("");
  this._seekTo = t;
  this.v.src = src;
  if (playing || this.o.autoplay) this.play();
};

P.attachAudio = function (src) {
  if (this.au) { try { this.au.pause(); } catch (e) {} this.au.removeAttribute("src"); this.au = null; }
  if (!src) { this.v.muted = this.muted; return; }
  var au = this.au = new Audio();
  au.preload = "auto";
  au.src = src;
  au.volume = this.vol; au.muted = this.muted;
  this.v.muted = true;
};

P.syncAudio = function (force) {
  var au = this.au, v = this.v;
  if (!au || !isFinite(v.currentTime)) return;
  if (force || Math.abs(au.currentTime - v.currentTime) > 0.25) {
    try { au.currentTime = v.currentTime; } catch (e) {}
  }
};

P.play = function () {
  var p = this.v.play();
  if (p && p.catch) p.catch(function () {});
};
P.pause = function () { try { this.v.pause(); } catch (e) {} };
P.toggle = function () {
  if (this.loopSel && this.b != null && this.v.currentTime >= this.b - 0.02) this.seek(this.a || 0);
  if (this.v.paused) this.play(); else this.pause();
};
P.seek = function (t) {
  if (!this.dur && !isFinite(this.v.duration)) { this._seekTo = t; return; }
  t = clamp(t, 0, Math.max(0, (this.dur || this.v.duration) - 0.001));
  try { this.v.currentTime = t; } catch (e) {}
  this.paint(t);
};
P.time = function () { return this.v.currentTime || 0; };

P.setRate = function (rt) {
  this.v.playbackRate = rt;
  if (this.au) this.au.playbackRate = rt;
  this.btns();
};

/* f images, ou s secondes ; met en pause (image par image) */
P.frame = function (f, s) {
  this.pause();
  var step = 1 / (this.fps || 30);
  this.seek((this.v.currentTime || 0) + (f || 0) * step + (s || 0));
};

P.setVolume = function (vol, muted, silent) {
  this.vol = clamp(vol, 0, 1); this.muted = !!muted;
  var t = this.au || this.v;
  t.volume = this.vol; t.muted = this.muted;
  if (this.au) this.v.muted = true;
  this.$.vol.value = Math.round(this.vol * 100);
  this.$.mute.innerHTML = (this.muted || !this.vol) ? ICON.mute : ICON.vol;
  if (!silent && this.o.onVolume) this.o.onVolume(this.vol, this.muted);
};

/* ---- passage ---- */

P.mark = function (which) {
  var t = this.v.currentTime || 0;
  this.setMark(which, t, false);
  this.rangeChanged();
};
P.setMark = function (which, t, live) {
  var d = this.dur || 0, gap = Math.min(0.1, d / 2);
  if (this.a == null) { this.a = 0; this.b = d; }
  if (which === "a") {
    this.a = clamp(t, 0, d);
    if (this.b <= this.a + gap) this.b = live ? Math.min(d, this.a + gap) : d;
    if (live && this.b <= this.a) this.a = Math.max(0, this.b - gap);
  } else {
    this.b = clamp(t, 0, d);
    if (this.b <= this.a + gap) this.a = live ? Math.max(0, this.b - gap) : 0;
    if (live && this.b <= this.a) this.b = Math.min(d, this.a + gap);
  }
  this.paintRange();
};
P.setRange = function (a, b) {
  if (a == null) { this.a = this.b = null; }
  else { this.a = +a; this.b = b == null ? this.dur : +b; }
  this.paintRange();
};
P.getRange = function () {
  if (this.a == null) return null;
  return { a: this.a, b: this.b, full: this.a <= 0.05 && (!this.dur || this.b >= this.dur - 0.05) };
};
P.clearRange = function () {
  this.loopSel = false;
  if (this.always) { this.a = 0; this.b = this.dur; } else { this.a = this.b = null; }
  this.paintRange();
  this.rangeChanged();
};
P.rangeChanged = function () {
  if (this.o.onRange) this.o.onRange(this.a, this.b, this);
};
/* Ecoute du passage, en boucle tant qu'on ne le quitte pas */
P.playRange = function () {
  if (this.a == null) return;
  this.loopSel = true;
  this.seek(this.a);
  this.play();
  this.btns();
};
P.typed = function (inp, which) {
  var t = parse(inp.value, this.fps);
  var d = this.dur || 0;
  if (t == null || t < 0 || (d && t > d + 0.05)) { inp.classList.add("bad"); return; }
  inp.classList.remove("bad");
  if (this.a == null) { this.a = 0; this.b = d; }
  if (which === "a") { if (t >= this.b) { inp.classList.add("bad"); return; } this.a = t; }
  else { if (t <= this.a) { inp.classList.add("bad"); return; } this.b = Math.min(t, d || t); }
  this.paintRange();
  this.seek(which === "a" ? this.a : Math.max(this.a, this.b - 2));
  this.rangeChanged();
};

/* ---- affichage ---- */

P.btns = function () {
  var v = this.v;
  this.$.play.innerHTML = v.paused ? ICON.play : ICON.pause;
  this.$.rate.textContent = (v.playbackRate || 1) + "x";
  this.$.rate.classList.toggle("on", v.playbackRate !== 1);
  this.$.psel.classList.toggle("on", this.loopSel);
};
P.paint = function (shown) {
  var v = this.v, d = this.dur || 0;
  var t = shown != null ? shown : (this._shown != null ? this._shown : (v.currentTime || 0));
  var pct = d ? clamp(t / d, 0, 1) * 100 : 0;
  this.$.prog.style.width = pct + "%";
  this.$.head.style.left = pct + "%";
  this.$.time.textContent = fmt(t, this.fps, this.tc) + " / " + (d ? fmt(d, this.fps, this.tc) : "-:--");
};
P.paintBuf = function () {
  var v = this.v, d = this.dur, b = v.buffered, t = v.currentTime || 0, end = 0;
  if (!d || !b) return;
  for (var i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > end) end = b.end(i);
  this.$.buf.style.width = clamp(end / d, 0, 1) * 100 + "%";
};
P.paintRange = function () {
  var $ = this.$, d = this.dur, on = this.a != null && d > 0;
  this.el.classList.toggle("ranged", on && this.range);
  $.psel.disabled = !on; $.clr.disabled = !on || (this.always && this.getRange().full);
  if (!on) {
    if (document.activeElement !== $.ta) $.ta.value = "";
    if (document.activeElement !== $.tb) $.tb.value = "";
    $.ta.placeholder = fmt(0, this.fps, this.tc); $.tb.placeholder = d ? fmt(d, this.fps, this.tc) : "";
    $.len.textContent = "";
    return;
  }
  var pa = this.a / d * 100, pb = this.b / d * 100;
  $.sel.style.left = pa + "%"; $.sel.style.width = Math.max(0, pb - pa) + "%";
  $.ha.style.left = pa + "%"; $.hb.style.left = pb + "%";
  if (document.activeElement !== $.ta || !$.ta.classList.contains("bad")) $.ta.value = fmt(this.a, this.fps, this.tc);
  if (document.activeElement !== $.tb || !$.tb.classList.contains("bad")) $.tb.value = fmt(this.b, this.fps, this.tc);
  $.ta.classList.remove("bad"); $.tb.classList.remove("bad");
  $.len.textContent = "= " + fmt(this.b - this.a, this.fps, false);
};

/* Bulle au survol : temps + image (planche de vignettes) */
P.tip = function (x, t) {
  var $ = this.$, rc = $.bar.getBoundingClientRect();
  $.tiptxt.textContent = fmt(t, this.fps, this.tc);
  var th = this.o.thumbs ? this.o.thumbs(t, this.dur) : null;
  if (th && th.url) {
    var k = 160 / th.w;
    $.tipimg.style.display = "block";
    $.tipimg.style.height = Math.round(th.h * k) + "px";
    $.tipimg.style.backgroundImage = 'url("' + String(th.url).replace(/"/g, "%22") + '")';
    $.tipimg.style.backgroundSize = Math.round(th.sw * k) + "px " + Math.round(th.sh * k) + "px";
    $.tipimg.style.backgroundPosition = (-Math.round(th.x * k)) + "px " + (-Math.round(th.y * k)) + "px";
  } else $.tipimg.style.display = "none";
  $.tip.style.display = "block";
  var w = $.tip.offsetWidth || 60, px = clamp(x - rc.left, w / 2 - 6, rc.width - w / 2 + 6);
  $.tip.style.left = px + "px";
};

P.msg = function (text) {
  this.$.msg.innerHTML = text || "";
  this.el.classList.toggle("hasmsg", !!text);
};

P.waitSoon = function (on) {
  var self = this;
  clearTimeout(this._wt);
  if (!on) { this.el.classList.remove("wait"); return; }
  this._wt = setTimeout(function () { if (!self.dead) self.el.classList.add("wait"); }, 220);
};

/* Tete de lecture fluide pendant la lecture (timeupdate = 4 fois / s) et
   boucle du passage */
P.loopRaf = function () {
  var self = this;
  cancelAnimationFrame(this._raf);
  (function tick() {
    if (self.dead || self.v.paused) return;
    var t = self.v.currentTime;
    if (self.loopSel && self.b != null && t >= self.b) self.seek(self.a);
    self.paint();
    if ((self._bt = (self._bt || 0) + 1) % 15 === 0) self.paintBuf();
    self._raf = requestAnimationFrame(tick);
  })();
};

/* Raccourcis ; renvoie true si la touche a servi */
P.key = function (e) {
  var k = e.key, v = this.v, tgt = e.target;
  if (tgt && (tgt.tagName === "TEXTAREA" || (tgt.tagName === "INPUT" && tgt.type === "text"))) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  var done = true, lk = (k || "").toLowerCase();
  if (k === " " || k === "Spacebar" || lk === "k") {
    if (lk === "k") { this.setRate(1); this.pause(); } else this.toggle();
  }
  else if (lk === "l") {
    if (v.paused) { this.setRate(1); this.play(); }
    else this.setRate(Math.min(4, (v.playbackRate || 1) * 2));
  }
  else if (lk === "j") this.seek((v.currentTime || 0) - 5);
  else if (k === "ArrowLeft") e.shiftKey ? this.frame(0, -1) : this.frame(-1);
  else if (k === "ArrowRight") e.shiftKey ? this.frame(0, 1) : this.frame(1);
  else if (k === "ArrowUp") this.setVolume(this.vol + 0.1, false);
  else if (k === "ArrowDown") this.setVolume(this.vol - 0.1, false);
  else if (k === "Home") this.seek(0);
  else if (k === "End") this.seek(this.dur);
  else if (lk === "m") this.setVolume(this.vol, !this.muted);
  else if (this.range && lk === "i") { if (e.shiftKey) { if (this.a != null) this.seek(this.a); } else this.mark("a"); }
  else if (this.range && lk === "o") { if (e.shiftKey) { if (this.b != null) this.seek(this.b); } else this.mark("b"); }
  else if (this.range && lk === "p") this.playRange();
  else if (this.range && lk === "x") this.clearRange();
  else done = false;
  if (done) { e.preventDefault(); e.stopPropagation(); }
  return done;
};

P.destroy = function () {
  this.dead = true;
  cancelAnimationFrame(this._raf);
  clearTimeout(this._wt);
  this._off.forEach(function (x) { x[0].removeEventListener(x[1], x[2]); });
  this._off = [];
  try { this.v.pause(); } catch (e) {}
  this.v.removeAttribute("src");
  try { this.v.load(); } catch (e) {}
  if (this.au) { try { this.au.pause(); } catch (e) {} this.au.removeAttribute("src"); this.au = null; }
  if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
};

/* Vignette a l'instant t dans une planche YouTube (format "sb" de yt-dlp :
   { sheets:[url], w, h, rows, cols, fps }), pour l'option thumbs. */
function storyboard(sb, t, dur) {
  if (!sb || !sb.sheets || !sb.sheets.length || !dur) return null;
  var per = sb.rows * sb.cols, total = Math.max(1, Math.ceil(dur * sb.fps));
  var idx = Math.min(total - 1, Math.max(0, Math.floor(t * sb.fps)));
  var sheet = Math.floor(idx / per);
  if (sheet >= sb.sheets.length) return null;
  var i = idx % per;
  // la derniere planche est souvent incomplete (moins de lignes)
  var inSheet = sheet === sb.sheets.length - 1 ? total - sheet * per : per;
  var rows = Math.max(1, Math.min(sb.rows, Math.ceil(inSheet / sb.cols)));
  var cols = rows > 1 ? sb.cols : Math.max(1, Math.min(sb.cols, inSheet));
  return { url: sb.sheets[sheet], w: sb.w, h: sb.h, x: (i % sb.cols) * sb.w,
           y: Math.floor(i / sb.cols) * sb.h, sw: cols * sb.w, sh: rows * sb.h };
}

MkPlayer.fmt = fmt;
MkPlayer.parse = parse;
MkPlayer.storyboard = storyboard;
root.MkPlayer = MkPlayer;
if (typeof module !== "undefined" && module.exports) module.exports = MkPlayer;
})(typeof window !== "undefined" ? window : this);
