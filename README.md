# Mudkit 💧

Ta boîte à outils perso, inspirée de Gobou (Mudkip). Interface web moderne
dans une fenêtre native (pywebview + WebView2), backend 100 % Python local.

## Lancer

Raccourci **Mudkit** sur le Bureau ou dans le menu Démarrer (touche Windows →
« Mudkit »). Le raccourci lance le moteur Python signé du dossier `.venv` —
compatible avec le Contrôle intelligent des applications de Windows 11, qui
bloque les exe maison non signés. `Mudkit.bat` reste utilisable en secours.

## Installer sur un autre PC / faire une release

Le zip des [releases GitHub](https://github.com/Rayou444/Mudkit/releases) est
autonome : Python portable, `bin/` et panneau Premiere signé inclus. On
l'extrait, puis double-clic sur `INSTALLER Mudkit.bat` → installe dans
`%USERPROFILE%\Mudkit` (+ raccourcis + panneau). L'app et le panneau
cherchent `python\` (install) puis `.venv\` (ce PC de dev) : aucun chemin en
dur.

### Faire une release

1. Monter `__version__` dans `mudkit/__init__.py` (seule source de la
   version), écrire `packaging/notes/vX.Y.Z.md`, commit + push.
2. Si `requirements.txt` a changé : incrémenter `packaging/runtime.txt`.
3. Construire et publier (re-signe aussi le panneau) :

```
powershell -ExecutionPolicy Bypass -File packaging\build.ps1 -Publish
```

Trois fichiers par release :
- `Mudkit-vX.Y.Z.zip` : l'installation complète.
- `Mudkit-update-vX.Y.Z.zip` : le code seul et le panneau, environ 1 Mo.
- `Mudkit-Premiere-vX.Y.Z.zxp` : le panneau seul.

Le Python embarqué est installé depuis `requirements.txt`, aux versions
exactes du `.venv` (`pip freeze` sert de contraintes).

### Mises à jour automatiques (`mudkit/updater.py`)

- **Un seul bouton, un seul clic, pour les deux outils.** Le même zip met à
  jour l'appli et le panneau, quel que soit l'outil d'où part le clic.
- L'appli vérifie `releases/latest` au lancement puis toutes les 6 h. Le
  bouton « Mettre à jour » (pastille de la barre de gauche, notification,
  Paramètres) télécharge `Mudkit-update-*.zip`, vérifie son empreinte SHA-256
  fournie par GitHub, écrase le panneau puis le code, et **redémarre l'appli
  tout seul**, après la fin des tâches en cours (`Api._restart_when_idle`).
- Le panneau Premiere fait pareil avec son bouton vert « Mettre à jour » :
  il lance `python -E -s -m mudkit.updater apply` (lignes JSON sur stdout),
  puis se recharge seul (`$.evalFile` de `host.jsx` + `location.reload()`),
  sans redémarrer Premiere.
- Chaque outil détecte que l'autre a déjà installé une version :
  `updater.installed_version()` lit la version sur le disque. L'appli
  propose alors « Redémarrer », le panneau « Recharger » (lecture locale
  chaque minute).
- Le panneau est copié en premier : si Premiere en verrouille un fichier, la
  mise à jour s'arrête avant de toucher l'appli.
- **Retour arrière** : chaque fichier remplacé est d'abord sauvegardé dans
  `%LOCALAPPDATA%\Mudkit\update-backup` (manifeste `en-cours.json`), chaque
  écriture passe par un temporaire renommé. Une erreur restaure aussitôt la
  version d'avant ; une coupure (PC éteint) est rattrapée au démarrage
  suivant par `updater.recover()`, appelé tout en haut de `main.py` (copié
  en dernier pour cette raison).
- Ne sont jamais touchés : `python\`, `bin\`, `config.json`, `cookies.txt`.
- Si `update.json` demande un runtime plus récent que
  `python\mudkit-runtime.txt`, l'appli renvoie vers l'installateur complet.
- Désactivé sur le PC de dev (dossier `.git`).

## Modules

| Module | Ce que ça fait |
|---|---|
| ⬇ Téléchargeur | YouTube, TikTok, Insta, Twitter/X, Twitch… en haute qualité (jusqu'à 4K/8K) ou audio seul (mp3, flac, wav...). File d'attente : les liens s'enchaînent automatiquement, et plusieurs liens collés d'un coup partent tous en file. Cookies lus depuis le navigateur choisi dans Paramètres (Firefox conseillé) ou un `cookies.txt`. Basé sur yt-dlp, mis à jour tout seul chaque jour. |
| ✨ Upscaler IA | Agrandit les images x2/x3/x4 en local sur ton GPU (Vulkan). 8 modèles dont les 5 du projet [Upscayl](https://github.com/upscayl/upscayl) (Standard, UltraSharp, Remacri, Art numérique, Lite). Comparateur avant/après, sortie png/jpg/webp. |
| 🔁 Convertisseur | Images (png, jpg, webp, ico...), audio (mp3, flac, wav...) et vidéo (mp4, mkv, webm, gif...), en lot, avec progression réelle. |
| 🗜 Compresseur | Fait tenir une vidéo sous une taille cible (Discord 10 Mo, WhatsApp 16 Mo, e-mail 25 Mo, 50 Mo ou libre) — encodage x264 deux passes, définition réduite automatiquement si besoin. |
| ✂ Détourage | Supprime l'arrière-plan (BiRefNet / IS-Net), PNG transparent. Même pipeline que rembg mais en onnxruntime direct (`core/cutout.py`, sortie identique au pixel près) : ~290 Mo de dépendances en moins. Modèles dans `~/.rembg/models`. |

Le téléchargeur garde un **historique** (`%LOCALAPPDATA%\Mudkit\history.json`)
et ne saute plus une vidéo dont le titre existe déjà : « titre (2) ». Une
**playlist** est rangée dans son propre sous-dossier, au nom de la playlist.

Le téléchargeur permet aussi de ne prendre qu'un **passage** d'une vidéo
(slider début/fin après analyse) : seul le morceau choisi est téléchargé.

Les binaires (ffmpeg, Real-ESRGAN) sont embarqués dans `bin/` : s'il en
manque un, l'accueil propose de l'installer en un clic.

## Panneau Premiere Pro

Extension CEP `com.mudkit.premiere` (source dans `premiere_ext/src/`), ouverte
depuis **Fenêtre → Extensions → Mudkit**. Pensée pour remplacer la *User
Library* de Mister Horse (dont le plan gratuit plafonne à 500 éléments). Une
seule page : le **gestionnaire de médias** s'ouvre directement ; le
téléchargeur est derrière le bouton **⬇** en haut à droite.

**Gestionnaire (`library.js`)** — calqué sur l'ergonomie du panneau Animation
Composer (arborescence à gauche, grille à droite), sans limite d'éléments :

- **Arborescence persistante à gauche.** Chaque dossier ajouté avec `＋` devient
  une **catégorie de premier niveau** (équivalent d'un « pack ») ; plusieurs
  dossiers peuvent être montés en même temps. Sélectionner un nœud affiche
  **tout son sous-arbre**, pas seulement ses enfants directs.
- **Glisser-déposer** vers la timeline : `event.dataTransfer.setData(
  'com.adobe.cep.dnd.file.0', chemin)` sur `dragstart`. Double-clic = import
  direct en secours ([régression Adobe connue](https://github.com/Adobe-CEP/CEP-Resources/issues/483)).
- **Favoris ★** sur chaque vignette (persistés) + bouton ★ en haut de la
  barre latérale pour ne montrer que les favoris.
- **Tout se déclenche au clic, jamais au survol.** Clic sur une image/vidéo =
  visionneuse. La tuile sélectionnée garde un cadre bleu. Seule exception au
  survol : le **scrub** des vignettes vidéo, qui ne lance aucune lecture (c'est
  le geste signature d'Animation Composer).
- **Pour un son, on clique sur la forme d'onde et la lecture démarre à cet
  endroit** : la position horizontale du clic donne une fraction de 0 à 1,
  appliquée à la durée. Cliquer ailleurs sur la tuile (la ligne du nom)
  bascule lecture / pause (la position est gardée). `currentTime` n'étant
  réglable qu'une fois la durée connue, le calage se fait sur `loadedmetadata`
  quand les métadonnées ne sont pas encore chargées. `.dur` et `.pos` sont en
  `pointer-events:none` pour que le clic traverse jusqu'au visuel. Le 2e clic
  d'un double-clic (`event.detail > 1`) est ignoré : double-clic = import, sans
  basculer la lecture au passage.
- **Lecteur** (barre au-dessus de la barre du bas, visible dès qu'un son est
  lancé) : précédent / lecture-pause / suivant, barre de position cliquable et
  glissable, temps écoulé / durée, volume (molette sur le slider) et muet, ✕
  pour arrêter. **Fin du son** au choix, mémorisé : *boucle* (défaut),
  *enchaîner* le son suivant de la grille, ou *s'arrêter*. Le son en cours est
  gardé à part de la grille : chercher, changer de dossier, filtrer les favoris
  ou ouvrir une image **ne coupe plus la musique** ; ouvrir une vidéo la met en
  pause. Clavier : `Espace` lecture/pause, `←` / `→` ±5 s, `Échap` pause
  (`registerKeyEventsInterest` évite que Premiere reçoive aussi ces touches).
  La conversion pour l'écoute (aif, wma…) passe devant les vignettes dans la
  file ffmpeg et s'écrit dans un `.part.mp3` renommé à la fin, pour ne jamais
  mettre en cache un mp3 tronqué.
- **Pas de filtre par type** : retiré à la demande, l'arbre suffit à cadrer.
- **La visionneuse se ferme en cliquant dans le vide** autour du média, sans
  passer par la croix. Le test `ev.target === this` sur `.vbody` garantit qu'on
  ne ferme que sur le fond : un clic sur la vidéo ou sur ses contrôles de
  lecture ne remonte pas jusqu'au gestionnaire. Même comportement que l'overlay
  de téléchargement. `Échap` ferme aussi.
- **MOGRT** : posés sur la timeline via `sequence.importMGT(path, time,
  vidTrackOffset, audTrackOffset)`. Il n'existe pas d'équivalent « déposer dans
  un chutier » pour un MOGRT, donc l'action *chutier* renvoie une erreur claire
  et il faut une séquence active.
- **Slider de taille des vignettes** en bas à gauche (pilote `--tw`), et
  **splitter** redimensionnable entre l'arbre et la grille.
- Recherche : elle traverse **toutes** les racines montées, en ignorant la
  sélection courante.
- Scan récursif (12 niveaux) mis en cache par racine dans
  `%LOCALAPPDATA%\Mudkit\lib-cache\idx-*.json` — réouverture instantanée,
  `⟳` rescanne la racine sélectionnée (ou toutes si rien n'est sélectionné).
  Le scan avance par tranches de 1 500 fichiers (un dossier de 40 000 sons ne
  gèle plus le panneau), s'annule dossier par dossier (`lib.scanId`), et
  l'index est lu / écrit en asynchrone, via un temporaire renommé.
- **Grille virtuelle** : seules les tuiles visibles (+ 2 rangées) existent
  dans la page, placées en absolu dans `.vbox` (`layout()`, `paint()`,
  `place()`). Colonnes recalculées par `ResizeObserver` et par le slider.
  La sélection et le son en cours sont retrouvés par chemin quand une tuile
  est recréée.
- **Filtre par durée** (`< 1 s`, `1 à 5 s`, `5 à 30 s`, `> 30 s`) au-dessus de
  la grille. Les durées inconnues sont mesurées en tâche de fond (ffprobe,
  `opts.bg`, abandonnées si le filtre change) puis gardées dans l'index.
- **Récents** en tête de l'arbre : les 60 derniers fichiers posés (double-clic,
  `+`) ou glissés. `−` sur Récents les vide.
- **Points d'entrée / sortie** : `I` / `O` pendant l'écoute (ou dans la
  visionneuse vidéo) → `marks[chemin] = {a, b, d}`, gardés dans le stockage
  du panneau. L'import passe `in, out` à `mudkitLibImport`, qui crée un
  sous-plan (`createSubClip`, ticks) et le pose. Bande `.mk` sur la vignette.
  Le glisser-déposer pose toujours le fichier entier (seul un chemin passe).
- **Multi-sélection** : Ctrl+clic, Maj+clic, Ctrl+A, Échap (`selSet`).
  Double-clic / `+` → `mudkitLibImportMany([[chemin, in, out], …])`, qui pose
  les fichiers les uns après les autres (sinon chaque insertion au même
  endroit inversait l'ordre). Le glisser passe `com.adobe.cep.dnd.file.0..N`.
- **« Dans ce projet »** : `mudkitProjectMedia()` renvoie les chemins des
  médias du projet ouvert (au démarrage, au retour du focus, après un import,
  chaque minute). Badge `.ip` sur la vignette et dossier virtuel `@project`.
- **Sous-titres** (case dans la fenêtre de téléchargement) : `premiere_dl.py
  --subs` récupère les sous-titres du site (sinon automatiques) en `.srt`,
  recalés par `cut_srt` pour un passage ; `mudkitImport(chemin, action, srt)`
  les importe et crée une piste de légendes (`createCaptionTrack`).
- `host.jsx` est testé hors de Premiere contre une maquette de l'API
  (projet, chutiers, séquence, pistes) : `node premiere_ext/tests/host_mock.test.js`.
- Dossiers repérés **par chemin** (clés `racine|chemin`), plus par position.
  Un dossier introuvable au démarrage (disque débranché) reste enregistré et
  grisé dans l'arbre ; un clic le remonte s'il est revenu, `−` l'oublie.
- **Nouveaux fichiers visibles tout seuls** : rescan silencieux quelques
  secondes après l'ouverture (`quietRescan`), puis à chaque changement
  signalé par `fs.watch` récursif sur chaque dossier monté. Le scan construit
  sa liste à part et ne remplace l'ancienne qu'à la fin.
- Vignettes : écrites dans un `.part` puis renommées ; une vignette ratée est
  retenue dans l'index (`nothumb`, clé chemin + date + taille) et n'est plus
  retentée à chaque défilement. Images de plus de 400 Ko et GIF : miniature
  320 px en cache au lieu du fichier original.
- MOGRT posé sur la première piste vidéo libre à la tête de lecture
  (`mudkitFreeVideoTrack`), plus toujours sur V1. `host.jsx` garde les
  éléments déjà retrouvés (`MUDKIT_ITEMS`, clé projet + chemin).
- **Purge du cache** une fois par jour : au-delà de 3 Go, les plus anciens
  fichiers sont supprimés jusqu'à 2 Go, avec les `.part` et les index de
  dossiers retirés.
- File ffmpeg : 8 jobs max, chaque job tué après 2 min, un job abandonné
  prévient son demandeur (`SKIPPED`).
- yt-dlp se met à jour tout seul, au plus une fois par jour, depuis l'appli
  ou le panneau (`python -m mudkit.updater ytdlp`), jamais pendant un
  téléchargement ni sur le PC de dev.
- Aperçus ffmpeg générés à la demande et cachés : forme d'onde (audio), poster
  (vidéo), et **sprite de 24 images** scrubé à la souris au survol (clips
  ≤ 45 s : `fps`+`tile` ; au-delà : 24 seeks `-ss` avant `-i` puis `hstack`,
  pour ne pas décoder tout le fichier).
- Les formats que Chromium ne lit pas (aif, wma, tiff, heic…) sont convertis à
  la volée pour l'aperçu ; le fichier d'origine reste celui qui est glissé.
- Le manifest ajoute `--allow-file-access-from-files` : sans ça Chromium bloque
  les vignettes et médias `file://`.

### Habillage : suivre Premiere, pas de glyphes Unicode

Deux règles à ne pas casser :

1. **Toutes les icônes sont des SVG inline en `currentColor`** (table `ICO` dans
   `library.js`, markup direct dans `index.html`). Des caractères comme `▢`
   (U+25A2), `＋` (U+FF0B), `⟳` (U+27F3) ou `⬇` (U+2B07) ne sont pas couverts par
   Segoe UI : Chromium affiche alors un **carré vide** (« tofu »). En SVG c'est
   garanti, ça suit le thème et ça reste net à toute taille.
2. **Toute variable CSS déclarée dans `index.html` doit être pilotée par
   `setTheme()` dans `panel.js`.** Les valeurs du `:root` ne sont que des
   secours. La refonte avait introduit `--side`, `--row-h`, `--row-s`, `--faint`
   sans les câbler : la moitié du panneau restait figée et ne suivait plus la
   luminosité réglée dans Premiere. `setTheme()` dérive désormais toute la
   palette de `appSkinInfo.panelBackgroundColor`, et inverse le sens des nuances
   en thème clair. `applyTheme()` reprend aussi `baseFontFamily` et
   `baseFontSize` de l'hôte (`--font`, `--fs`), donc le panneau utilise la même
   police qu'Adobe.

### Réutilisation des aperçus Mister Horse

Rétro-ingénierie de leur convention (observée sur la bibliothèque réelle, pas
sur leur code) : Mister Horse dépose ses aperçus dans un dossier
`_Mister Horse Previews` placé **dans** le dossier ajouté à sa User Library, et
qui reproduit toute l'arborescence en dessous. Nom = `<nom complet du fichier
source>` + `.webp` / `.jpg` / `.png` :

| source | aperçu | dimensions |
|---|---|---|
| mp3, wav | `.png` | 320×180 — forme d'onde |
| jpg, png, gif, mogrt | `.webp` / `.jpg` | 320×180 — image fixe |
| **mp4** | `.webp` | **320×(N×180)** — sprite **vertical** de N images |
| mov, wmv | `.webp` | webp animé |

Deux conséquences, toutes les deux implémentées :

1. **Ces fichiers ne sont PAS des médias.** Sans le filtre, le scan avalait
   **5 141 faux items**. `scan()` détecte les dossiers `_Mister Horse Previews`
   et route leur contenu vers `lib.mh` au lieu de `lib.items`.
2. **On les réutilise comme vignettes.** `mhPreview()` fait un lookup O(1), et
   `useMH()` mesure l'image chargée pour décider image fixe vs sprite vertical
   (scrub avec `attachVSprite()`, aucun ffmpeg nécessaire).

Mesuré sur la bibliothèque réelle (43 425 items) : **1 537 / 1 538 vidéos
(99,9 %)** et **810 / 844 images (96 %)** obtiennent un aperçu instantané —
justement les plus coûteux à produire. Côté audio en revanche seulement
22 / 41 043, donc les formes d'onde restent à notre charge : d'où `MAXJOBS = 8`,
les jobs de vignette en tête de file, et leur abandon dès que la tuile quitte
le DOM (`job.el.isConnected`).

Le fichier `settings.dat` de Mister Horse est chiffré ; il n'est **pas** lu ni
déchiffré, et rien de leur code n'est repris.

### Performances mesurées (43 425 items, vraie bibliothèque)

| Phase | Temps |
|---|---|
| Scan complet (2 299 dossiers) | 830 ms |
| Index JSON en cache | 13,1 Mo — parse 32 ms |
| `buildTree()` | 33 ms → **mis en cache**, sinon rejoué à chaque clic |
| Recherche sur 43 k items | 14 ms |

⚠️ **Piège de concurrence** : `scan()` ne doit **pas** incrémenter le token
global. Monter deux racines en parallèle ferait avorter le premier scan et
`refreshAfterMount()` ne serait jamais appelé (panneau figé). Le token n'avance
que dans `invalidate()`, sur rescan/démontage.

**Téléchargeur (overlay ⬇)** — colle un lien, téléchargé par le moteur Mudkit
(`premiere_dl.py`), converti en H.264/AAC si Premiere ne lit pas le codec, puis
importé dans le chutier « Mudkit » et posé sur la timeline (`panel.js`).

Après **chaque** modification de `premiere_ext/src/`, relancer la signature :

```
powershell -ExecutionPolicy Bypass -File C:\Users\Rayan\Mudkit\premiere_ext\deployer.ps1
```

puis rouvrir le panneau dans Premiere (la signature couvre les fichiers, une
modif non re-signée fait refuser l'extension).

⚠️ **Taille par défaut du panneau** : elle est déclarée dans
`CSXS/manifest.xml` (`<Size>` 760×780, `<MinSize>` 300×340). Mais Premiere
**mémorise la taille dans l'espace de travail** : le manifest ne s'applique
qu'à un panneau qui n'a pas encore d'entrée enregistrée. Si le panneau
continue de s'ouvrir petit, redimensionner une fois puis
**Fenêtre → Espaces de travail → Enregistrer les modifications de cet espace
de travail**.

## Architecture

- `main.py` — ouvre la fenêtre native (pywebview) sur l'interface web locale.
- `mudkit/ui/` — interface (HTML/CSS/JS), thème « Crème & Gobou » (crème
  par défaut, sombre en option). Pour ouvrir `app.js` dans un navigateur
  sans pywebview, il y a un mode simulation. Un aperçu se lance avec
  `python -m http.server`, puis on ouvre `/mudkit/ui/index.html?apercu`
  (ou le fichier directement). Sans `?apercu`, la page attend le moteur :
  la simulation ne se déclenche plus toute seule dans la vraie appli.
  - Grands titres et mot géant en contour : attribut `data-wm` des
    `.page-head`.
  - Pilule-image dans les titres d'accueil : `.hero-pill`.
  - Les sélections utilisent la pilule « encre » (`--ink`).
  - Tout ce qui avance utilise `--grad`, le dégradé bleu → orange.
  - Polices système uniquement, donc rien à embarquer.
- `mudkit/api.py` — pont JS ↔ Python : chaque méthode publique de `Api` est
  appelable côté JS via `window.pywebview.api.*` ; les tâches longues
  poussent des événements via `window.mudkitEvent({...})`.
  - Un plantage imprévu dans une tâche émet quand même son événement de fin
    (`crash=`) : l'interface ne reste jamais bloquée.
  - Côté JS, `api()` renvoie `null` sur échec au lieu de lever une exception.
- `mudkit/core/` — logique pure (downloader, upscaler, converter,
  compressor, cutout), sans UI.
- `mudkit/logs.py` — journal `%LOCALAPPDATA%\Mudkit\logs\mudkit.log`.
  - Sous pythonw, `stdout` et `stderr` valent `None` : ils sont redirigés
    vers le journal. Sinon tqdm & co plantaient.
  - Les erreurs JS remontent via `log_js`.
  - `report()` fabrique le texte du bouton « Copier le rapport ».
- `mudkit/history.py`, `mudkit/updater.py`, `mudkit/notify.py` —
  historique des téléchargements, mises à jour auto, notification Windows
  (NotifyIcon WinForms + clignotement, seulement si la fenêtre est en
  arrière-plan).
- `mudkit/dnsfix.py` — résolveur de secours DNS-over-HTTPS (le DNS de la box
  est instable) ; activé au démarrage, aucun réglage système modifié.

## Ajouter une fonctionnalité

1. La logique dans `mudkit/core/mon_module.py` (fonctions pures, callbacks
   `progress` / `is_cancelled`).
2. Les méthodes de pont dans `mudkit/api.py` (démarrage en thread + events).
3. Une section `<section id="page-xx" class="page">` dans `ui/index.html`,
   un bouton nav, et le câblage dans `ui/app.js`.

## Mettre à jour yt-dlp

Bouton « Mettre à jour » sur l'accueil (ligne yt-dlp). En ligne de commande :

```
.venv\Scripts\python -c "import sys; sys.path.insert(0, r'C:\Users\Rayan\Mudkit'); from mudkit import dnsfix; dnsfix.activate_if_needed(); sys.argv=['pip','install','-U','yt-dlp']; from pip._internal.cli.main import main; sys.exit(main())"
```

## Note

Le téléchargeur est prévu pour un usage perso (tes propres contenus, contenus
libres de droits). Respecte les conditions d'utilisation de YouTube et le
droit d'auteur.
