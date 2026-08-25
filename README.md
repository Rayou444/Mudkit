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
depuis **Fenêtre → Extensions → Mudkit**. Deux onglets :

**Télécharger** — colle un lien, le fichier est téléchargé par le moteur Mudkit
(`premiere_dl.py`), converti en H.264/AAC si Premiere ne sait pas lire le codec,
puis importé dans le chutier « Mudkit » et posé sur la timeline au curseur.

**Bibliothèque** — navigateur de médias locaux, sans limite d'éléments :

- `+` choisit un dossier, scanné récursivement (10 niveaux) ; plusieurs dossiers
  peuvent être mémorisés, on bascule avec la liste déroulante.
- Le résultat du scan est mis en cache dans
  `%LOCALAPPDATA%\Mudkit\lib-cache\idx-*.json` : réouverture instantanée,
  `⟳` pour rescanner.
- Aperçus générés à la demande par le ffmpeg de `bin/` et mis en cache :
  forme d'onde pour l'audio, image de poster pour la vidéo, et un **sprite de
  24 images** que la souris scrube au survol de la vignette (clips ≤ 45 s :
  `fps`+`tile` ; au-delà : 24 seeks `-ss` avant `-i` puis `hstack`, pour ne pas
  décoder le fichier entier).
- Clic = écoute / visionne · `+` ou double-clic = importe dans Premiere selon
  l'action choisie en bas (insérer / écraser / chutier). Le chutier prend le nom
  du dossier de la bibliothèque.
- Les formats que Chromium ne lit pas (aif, wma, tiff, heic…) sont convertis à
  la volée en aperçu ; le fichier d'origine reste celui qui est importé.

Après **chaque** modification de `premiere_ext/src/`, relancer la signature :

```
powershell -ExecutionPolicy Bypass -File C:\Users\Rayan\Mudkit\premiere_ext\deployer.ps1
```

puis rouvrir le panneau dans Premiere (la signature couvre les fichiers, une
modif non re-signée fait refuser l'extension).

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
