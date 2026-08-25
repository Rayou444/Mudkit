# Mudkit 💧

Ta boîte à outils perso, inspirée de Gobou (Mudkip). Interface web moderne
dans une fenêtre native (pywebview + WebView2), backend 100 % Python local.

## Lancer

Double-clique sur **Mudkit.exe** (ou le raccourci **Mudkit** sur le Bureau /
menu Démarrer). `Mudkit.exe` est un lanceur : il doit rester dans ce dossier.
`Mudkit.bat` reste utilisable en secours.

## Modules

| Module | Ce que ça fait |
|---|---|
| ⬇ Téléchargeur | YouTube, TikTok, Insta, Twitter/X, Twitch… en haute qualité (jusqu'à 4K/8K) ou audio seul (mp3, flac, wav...). File d'attente : les liens s'enchaînent automatiquement. Basé sur yt-dlp. |
| ✨ Upscaler IA | Agrandit les images x2/x3/x4 en local sur ton GPU (Vulkan). 8 modèles dont les 5 du projet [Upscayl](https://github.com/upscayl/upscayl) (Standard, UltraSharp, Remacri, Art numérique, Lite). Comparateur avant/après, sortie png/jpg/webp. |
| 🔁 Convertisseur | Images (png, jpg, webp, ico...), audio (mp3, flac, wav...) et vidéo (mp4, mkv, webm, gif...), en lot, avec progression réelle. |
| 🗜 Compresseur | Fait tenir une vidéo sous une taille cible (10/25/50/100 Mo ou libre) — encodage x264 deux passes, définition réduite automatiquement si besoin. |

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
  bascule simplement lecture / stop. `currentTime` n'étant réglable qu'une fois
  la durée connue, le calage se fait sur `loadedmetadata` quand les métadonnées
  ne sont pas encore chargées. `.dur` et `.pos` sont en `pointer-events:none`
  pour que le clic traverse jusqu'au visuel.
- **Pas de filtre par type** : retiré à la demande, l'arbre suffit à cadrer.
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
- Aperçus ffmpeg générés à la demande et cachés : forme d'onde (audio, lue au
  **survol**), poster (vidéo), et **sprite de 24 images** scrubé à la souris
  au survol (clips ≤ 45 s : `fps`+`tile` ; au-delà : 24 seeks `-ss` avant `-i`
  puis `hstack`, pour ne pas décoder tout le fichier). Clic = visionneuse.
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
22 / 41 043, donc les formes d'onde restent à notre charge : d'où `MAXJOBS = 4`.

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
- `mudkit/ui/` — interface (HTML/CSS/JS), thème océan/Gobou. `app.js` a un
  mode simulation quand il est ouvert dans un navigateur sans pywebview.
- `mudkit/api.py` — pont JS ↔ Python : chaque méthode publique de `Api` est
  appelable côté JS via `window.pywebview.api.*` ; les tâches longues
  poussent des événements via `window.mudkitEvent({...})`.
- `mudkit/core/` — logique pure (downloader, upscaler, converter), sans UI.
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
