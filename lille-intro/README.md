# Lille — Intro vidéo 3D cinématique (React + Vite + CesiumJS)

Séquence de 20 s, 1920×1080, 30 i/s : mer de nuages → traversée de la couche → Lille illuminée la nuit →
plongée sur le centre → survol du Vieux-Lille (Beffroi de l'Hôtel de Ville en ligne de mire) →
entrée par la rue Esquermoise sur la Grand'Place → arrivée au niveau de la rue face à la Vieille Bourse.

## Lancer

```bash
cd lille-intro
npm install
cp .env.example .env      # facultatif : ajouter une clé (voir plus bas)
npm run dev               # http://localhost:5173
```

Aperçu : lecture / pause (barre espace), scrubbing image par image, qualité d'aperçu, préchargement des tuiles.

## Exporter le MP4 (1920×1080, 30 i/s, H.264)

- **Dans le navigateur** : bouton « Exporter MP4 1080p30 » (Chrome / Edge, WebCodecs). Chaque image est rendue
  après chargement complet des tuiles → vidéo fluide quel que soit le PC. Le fichier se télécharge.
- **En ligne de commande** :
  ```bash
  npx playwright install chromium   # une seule fois
  npm run export -- --headed        # out/lille-intro.mp4 — --headed = GPU réel, ~10x plus rapide
  npm run export                    # headless (rendu logiciel, lent mais sans écran)
  npm run export -- --method ffmpeg # encode avec ffmpeg (libx264 CRF 16) au lieu de WebCodecs
  npm run export -- --stills 0,150,300,450,599   # captures JPEG de contrôle
  ```

## Clés API (`.env`)

Le projet choisit automatiquement la meilleure source disponible :

| Priorité | Variable | Rendu |
|---|---|---|
| 1 | `VITE_GOOGLE_MAPS_API_KEY` | Google Photorealistic 3D Tiles (photogrammétrie réelle de Lille) |
| 2 | `VITE_CESIUM_ION_TOKEN` | Google 3D Tiles via ion (asset 2275207) sinon Cesium OSM Buildings + World Terrain |
| 3 | aucune | **Secours** : 23 000 bâtiments OpenStreetMap réels extrudés (fichier local), rues, réverbères |

**Clé Google (recommandé)** : https://console.cloud.google.com → créer un projet → activer la facturation →
« API et services » → activer **Map Tiles API** → « Identifiants » → « Créer une clé API ».
Restreindre la clé à la Map Tiles API et au référent `http://localhost:5173/*`. Puis dans `.env` :
`VITE_GOOGLE_MAPS_API_KEY=AIza...`

**Jeton Cesium ion** : https://ion.cesium.com/signup → « Access Tokens » → copier le jeton par défaut →
`VITE_CESIUM_ION_TOKEN=eyJ...`. Pour Google via ion : « Asset Depot » → ajouter « Google Photorealistic 3D Tiles ».

Redémarrer `npm run dev` après modification du `.env`.

## Architecture

```
src/config.ts               vidéo, coordonnées (Grand'Place, Vieille Bourse, beffrois, Vieux-Lille), clés
src/engine/cameraPath.ts    images-clés + interpolation cubique monotone (trajectoire continue, sans cut)
src/engine/IntroEngine.ts   viewer Cesium, choix de la source, caméra, roulis, tremblements, rendu image par image
src/engine/nightShader.ts   éclairage nocturne procédural (fenêtres, vitrines, sodium) pour 3D Tiles et OSM
src/engine/postfx.ts        nuages volumétriques raymarchés, brume, DoF, flou de vitesse, étalonnage, grain
src/engine/osmCity.ts       bâtiments / rues / réverbères OSM
src/engine/overlay.ts       titres, chyrons des lieux, bandes cinéma, attributions
src/engine/exporter.ts      export MP4 WebCodecs + mp4-muxer
scripts/export.mjs          export CLI (Playwright + WebCodecs ou ffmpeg)
scripts/build-osm.mjs       régénère public/data/lille-osm.json depuis l'API OpenStreetMap
```

Ajuster la trajectoire : modifier `KEYS` dans `src/engine/cameraPath.ts` (temps, position caméra, point visé, focale).

## Attributions

Google (si utilisé) · © OpenStreetMap contributors (ODbL) · Esri World Imagery (Esri, Maxar, Earthstar Geographics) · NASA Black Marble. Les attributions
sont incrustées dans la vidéo exportée ; ne pas les retirer (conditions d'utilisation Google / OSM).
