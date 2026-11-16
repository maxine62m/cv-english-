// Moteur de l'intro : globe Cesium, choix de la source 3D (Google / ion / OSM),
// caméra scriptée, effets, rendu image par image pour l'export.
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { DEFAULT_GROUND_ELLIPSOID_HEIGHT, KEYS, LILLE_CENTER, NIGHT_TIME_ISO, VIDEO } from '../config';
import { pathHeading, pathSpeed, samplePath } from './cameraPath';
import { createTilesetNightShader } from './nightShader';
import { OsmCity } from './osmCity';
import { createPostFx, type PostFx } from './postfx';
import { drawOverlay } from './overlay';

export type Mode = 'google' | 'ion-google' | 'ion-osm' | 'osm';

export const MODE_LABEL: Record<Mode, string> = {
  google: 'Google Photorealistic 3D Tiles',
  'ion-google': 'Google 3D Tiles via Cesium ion',
  'ion-osm': 'Cesium OSM Buildings + World Terrain (ion)',
  osm: 'Mode secours : bâtiments OpenStreetMap extrudés (sans clé)',
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

const GIBS_BLACK_MARBLE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
const ESRI_IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

export interface EngineStatus {
  message: string;
  warning?: string;
}

export class IntroEngine {
  readonly viewer: Cesium.Viewer;
  readonly scene: Cesium.Scene;
  mode: Mode = 'osm';
  warning?: string;
  time = 0;
  playing = false;
  onFrame?: (t: number) => void;

  private tilesets: Cesium.Cesium3DTileset[] = [];
  private nightShader?: Cesium.CustomShader;
  private city?: OsmCity;
  private fx!: PostFx;
  private blackMarble?: Cesium.ImageryLayer;
  private groundH = 0;
  private worldToEnu = new Cesium.Matrix4();
  private worldToEnuRot = new Cesium.Matrix3();
  private eyeToEnu = new Cesium.Matrix4();
  private raf = 0;
  private resScale = 1;
  private globeSse = 2;
  private tilesetSse = 8;
  private last = 0;
  private looping = false;
  private overlayCanvas?: HTMLCanvasElement;

  private constructor(container: HTMLElement) {
    this.viewer = new Cesium.Viewer(container, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      vrButton: false,
      useDefaultRenderLoop: false,
      useBrowserRecommendedResolution: true,
      msaaSamples: 4,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      contextOptions: { webgl: { preserveDrawingBuffer: true, alpha: false, powerPreference: 'high-performance' } },
    });
    this.scene = this.viewer.scene;
  }

  static async create(container: HTMLElement, onStatus: (s: EngineStatus) => void): Promise<IntroEngine> {
    const e = new IntroEngine(container);
    await e.init(onStatus);
    return e;
  }

  private async init(onStatus: (s: EngineStatus) => void) {
    const { viewer, scene } = this;
    // Nuit d'hiver
    viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(NIGHT_TIME_ISO);
    viewer.clock.shouldAnimate = false;
    scene.highDynamicRange = false;
    scene.rethrowRenderErrors = true;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = true;
    scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.SUNLIGHT;
    // Ciel nocturne et halo urbain dessinés dans postfx.ts (l'atmosphère Cesium reste crépusculaire)
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    scene.light = new Cesium.DirectionalLight({
      direction: Cesium.Cartesian3.normalize(new Cesium.Cartesian3(0.3, -0.4, -0.85), new Cesium.Cartesian3()),
      color: new Cesium.Color(0.55, 0.65, 0.9, 1),
      intensity: 0.35,
    });
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#04060b');
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.tileCacheSize = 1000;
    scene.fog.enabled = true;
    scene.fog.density = 1.5e-4;
    scene.screenSpaceCameraController.enableInputs = false;
    scene.screenSpaceCameraController.enableCollisionDetection = false;
    (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none';

    // Imagerie publique sans clé : satellite Esri assombri (sol nocturne) + lumières NASA Black Marble
    const ground = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: ESRI_IMAGERY,
        maximumLevel: 19,
        credit: 'Esri, Maxar, Earthstar Geographics',
      }),
    );
    ground.brightness = 0.28;
    ground.contrast = 1.15;
    ground.saturation = 0.35;
    ground.gamma = 1.25;
    this.blackMarble = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: GIBS_BLACK_MARBLE,
        maximumLevel: 8,
        credit: 'NASA Black Marble',
      }),
    );
    this.blackMarble.brightness = 1.4;

    const tilesetOptions: Cesium.Cesium3DTileset.ConstructorOptions = {
      maximumScreenSpaceError: 8,
      cacheBytes: 1.5e9,
      maximumCacheOverflowBytes: 1e9,
      skipLevelOfDetail: false,
      preloadWhenHidden: true,
      showCreditsOnScreen: true,
    };

    // 1) Google direct  2) ion (Google puis OSM Buildings)  3) secours OSM local
    if (KEYS.google) {
      onStatus({ message: 'Chargement Google Photorealistic 3D Tiles…' });
      try {
        Cesium.GoogleMaps.defaultApiKey = KEYS.google;
        const ts = await Cesium.createGooglePhotorealistic3DTileset({ key: KEYS.google }, tilesetOptions);
        this.addPhotoTileset(ts);
        this.mode = 'google';
      } catch (err) {
        this.warning = `Clé Google refusée ou API non activée (${(err as Error).message}). Bascule sur le mode suivant.`;
      }
    }
    if (this.tilesets.length === 0 && KEYS.ion) {
      Cesium.Ion.defaultAccessToken = KEYS.ion;
      try {
        onStatus({ message: 'Cesium ion : Google 3D Tiles (asset 2275207)…' });
        const ts = await Cesium.Cesium3DTileset.fromIonAssetId(2275207, tilesetOptions);
        this.addPhotoTileset(ts);
        this.mode = 'ion-google';
      } catch {
        try {
          onStatus({ message: 'Cesium ion : World Terrain + OSM Buildings…' });
          viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
          const osm = await Cesium.createOsmBuildingsAsync(tilesetOptions);
          this.nightShader = createTilesetNightShader(this.eyeToEnu, false);
          osm.customShader = this.nightShader;
          scene.primitives.add(osm);
          this.tilesets.push(osm);
          this.mode = 'ion-osm';
        } catch (err) {
          viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
          this.warning = `Jeton Cesium ion invalide (${(err as Error).message}). Mode secours OSM.`;
        }
      }
    }
    if (this.tilesets.length === 0) this.mode = 'osm';

    onStatus({ message: 'Mesure de l’altitude du sol…', warning: this.warning });
    this.groundH = await this.measureGround();
    this.setupEnu();

    onStatus({ message: 'Chargement des bâtiments et rues OpenStreetMap de Lille…', warning: this.warning });
    this.city = await OsmCity.load(scene, {
      buildings: this.mode === 'osm',
      roads: this.mode === 'osm' ? 'flat' : this.mode === 'ion-osm' ? 'terrain' : 'none',
      groundHeight: this.groundH,
      eyeToEnu: this.eyeToEnu,
    });

    this.fx = createPostFx(scene);
    this.setTime(0);
    onStatus({ message: 'Prêt', warning: this.warning });
  }

  private addPhotoTileset(ts: Cesium.Cesium3DTileset) {
    this.nightShader = createTilesetNightShader(this.eyeToEnu, true);
    ts.customShader = this.nightShader;
    this.scene.primitives.add(ts);
    this.tilesets.push(ts);
    // La photogrammétrie couvre le sol : on masque le globe (évite le z-fighting)
    this.scene.globe.show = false;
  }

  private async measureGround(): Promise<number> {
    const probes = [
      [3.0628, 50.6365],
      [3.0626, 50.6369],
      [3.0636, 50.63645],
    ].map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
    if (this.mode === 'osm') return 0;
    if (this.mode === 'ion-osm') {
      const r = await withTimeout(
        Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, probes).catch(() => undefined),
        15000,
        undefined,
      );
      const hs = (r ?? []).map((c) => c.height).filter((h) => Number.isFinite(h));
      return hs.length ? Math.min(...hs) : DEFAULT_GROUND_ELLIPSOID_HEIGHT;
    }
    // Google : on vise la Grand'Place pour charger les tuiles puis on échantillonne
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(3.0632, 50.6367, 400),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const r = await withTimeout(
      this.scene.sampleHeightMostDetailed(probes).catch(() => undefined),
      20000,
      undefined,
    );
    const hs = (r ?? []).map((c) => c?.height).filter((h): h is number => h !== undefined && Number.isFinite(h) && h > 0 && h < 150);
    return hs.length ? Math.min(...hs) : DEFAULT_GROUND_ELLIPSOID_HEIGHT;
  }

  private setupEnu() {
    const origin = Cesium.Cartesian3.fromDegrees(LILLE_CENTER.lon, LILLE_CENTER.lat, this.groundH);
    const enuToWorld = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    Cesium.Matrix4.inverseTransformation(enuToWorld, this.worldToEnu);
    Cesium.Matrix4.getMatrix3(this.worldToEnu, this.worldToEnuRot);
  }

  get groundHeight() {
    return this.groundH;
  }

  /** Place la caméra et tous les paramètres d'effets au temps t (secondes). */
  setTime(t: number) {
    this.time = Math.min(Math.max(t, 0), VIDEO.duration);
    t = this.time;
    const { camera } = this.scene;
    const s = samplePath(t);
    const pos = Cesium.Cartesian3.fromDegrees(s.cam[0], s.cam[1], s.cam[2] + this.groundH);
    const tgt = Cesium.Cartesian3.fromDegrees(s.look[0], s.look[1], s.look[2] + this.groundH);
    const dirW = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(tgt, pos, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
    const inv = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4());
    const d = Cesium.Matrix4.multiplyByPointAsVector(inv, dirW, new Cesium.Cartesian3());

    const sp = pathSpeed(t);
    // Effet de vitesse : fort pendant la descente (4-13 s) et le plongeon final
    const speedFx = Math.min(1, Math.max(0, (sp.apparent - 0.22) / 1.25)) * (1 - smooth(13.2, 15.2, t)) +
      0.35 * smooth(17.6, 18.4, t) * (1 - smooth(19.2, 19.9, t));
    // Tremblement caméra (turbulences dans les nuages + vitesse), déterministe
    const turb = smooth(4.6, 5.6, t) * (1 - smooth(7.2, 8.4, t));
    const shakeAmp = 0.0016 * speedFx + 0.004 * turb;
    const sh1 = Math.sin(t * 13.1) * 0.6 + Math.sin(t * 29.7 + 1.3) * 0.4;
    const sh2 = Math.sin(t * 17.3 + 2.1) * 0.6 + Math.sin(t * 23.9 + 0.4) * 0.4;
    // Roulis de virage proportionnel à la vitesse de lacet
    let dh = pathHeading(t + 0.2) - pathHeading(t - 0.2);
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const bank = Math.max(-0.12, Math.min(0.12, -dh * 0.9)) * smooth(0.5, 2, t) * (1 - smooth(18.8, 20, t));

    camera.setView({
      destination: pos,
      orientation: {
        heading: Math.atan2(d.x, d.y) + sh1 * shakeAmp,
        pitch: Math.asin(Math.max(-1, Math.min(1, d.z))) + sh2 * shakeAmp,
        roll: bank + sh2 * shakeAmp * 0.5,
      },
    });
    const fr = camera.frustum as Cesium.PerspectiveFrustum;
    fr.fov = Cesium.Math.toRadians(s.fovDeg + 6 * speedFx);
    fr.near = s.cam[2] < 60 ? 0.4 : 1.0;

    // Uniformes partagés (repère local)
    Cesium.Matrix4.multiply(this.worldToEnu, camera.inverseViewMatrix, this.eyeToEnu);
    this.nightShader?.setUniform('u_eyeToEnu', this.eyeToEnu);
    this.city?.update(this.eyeToEnu, s.cam[2]);

    if (this.fx) {
      const f = this.fx.frame;
      Cesium.Matrix3.clone(this.worldToEnuRot, f.worldToEnu);
      Cesium.Matrix4.multiplyByPoint(this.worldToEnu, pos, f.camEnu);
      const cu = this.fx.clouds.uniforms;
      cu.u_time = t;
      const lu = this.fx.lens.uniforms;
      lu.u_speed = speedFx;
      lu.u_time = t;
      lu.u_shake = new Cesium.Cartesian2(sh1 * 0.0012 * turb, sh2 * 0.0012 * turb);
      lu.u_exposure = 1.1 + 0.15 * smooth(8, 10, t);
      const co = this.fx.composite.uniforms;
      co.u_focus = Cesium.Cartesian3.distance(pos, tgt);
      co.u_dof = 0.9 * smooth(13, 15, t);
      co.u_starDim = 0.25 + 0.6 * smooth(1500, 6000, s.cam[2]);
    }
    // Lumières de la métropole au-delà des données OSM ; s'efface près du sol (résolution ~500 m)
    if (this.blackMarble) this.blackMarble.alpha = 0.95 * smooth(1300, 4200, s.cam[2]) + 0.35 * smooth(150, 600, s.cam[2]) * (1 - smooth(1300, 4200, s.cam[2]));
  }

  private tilesReady(): boolean {
    const globeOk = !this.scene.globe.show || this.scene.globe.tilesLoaded;
    return globeOk && this.tilesets.every((ts) => ts.tilesLoaded) && (!this.city || this.city.ready);
  }

  /** Rend l'image du temps t après chargement complet des tuiles (export). */
  async renderSettled(t: number, timeoutMs = 30000): Promise<void> {
    const start = performance.now();
    let stable = 0;
    // Passes de chargement rapides : basse résolution, sans post-traitement.
    // Le SSE est réduit dans la même proportion → mêmes niveaux de détail qu'en pleine résolution.
    this.setLowCost(true);
    try {
      while (performance.now() - start < timeoutMs) {
        this.setTime(t);
        this.viewer.render();
        stable = this.tilesReady() ? stable + 1 : 0;
        if (stable >= 3) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      this.setLowCost(false);
    }
    if (stable < 3)
      console.warn(
        `t=${t.toFixed(2)} : tuiles incomplètes après ${timeoutMs} ms`,
        JSON.stringify({ globe: !this.scene.globe.show || this.scene.globe.tilesLoaded, tilesets: this.tilesets.map((ts) => ts.tilesLoaded), city: this.city?.ready }),
      );
    this.setTime(t);
    this.viewer.render();
  }

  /** Compose rendu 3D + habillage dans un canvas 2D à la taille finale. */
  composeInto(ctx: CanvasRenderingContext2D, w = VIDEO.width, h = VIDEO.height) {
    ctx.drawImage(this.viewer.canvas, 0, 0, w, h);
    if (!this.overlayCanvas) {
      this.overlayCanvas = document.createElement('canvas');
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
    }
    const o = this.overlayCanvas.getContext('2d')!;
    drawOverlay(o, this.time, w, h, this.mode);
    ctx.drawImage(this.overlayCanvas, 0, 0);
  }

  setResolutionScale(s: number) {
    this.resScale = s;
    this.viewer.resolutionScale = s;
    this.applySse(1);
  }

  setTileQuality(sse: number) {
    this.tilesetSse = sse;
    this.applySse(1);
  }

  private applySse(k: number) {
    // SSE en pixels du canvas : en aperçu basse résolution, Cesium charge naturellement moins de détails
    this.scene.globe.maximumScreenSpaceError = this.globeSse * k;
    for (const ts of this.tilesets) ts.maximumScreenSpaceError = this.tilesetSse * k;
  }

  private setLowCost(on: boolean) {
    const LOW = 0.25;
    const stages = this.scene.postProcessStages;
    for (let i = 0; i < stages.length; i++) stages.get(i).enabled = !on;
    stages.bloom.enabled = !on;
    stages.fxaa.enabled = !on;
    if (on) {
      this.viewer.resolutionScale = LOW;
      this.scene.globe.maximumScreenSpaceError = this.globeSse * LOW;
      for (const ts of this.tilesets) ts.maximumScreenSpaceError = this.tilesetSse * LOW;
    } else {
      this.viewer.resolutionScale = this.resScale;
      this.applySse(1);
    }
  }

  // ---------- Lecture temps réel ----------
  startLoop() {
    if (this.looping) return;
    this.looping = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.looping) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.playing) {
        let t = this.time + dt;
        if (t >= VIDEO.duration) {
          t = VIDEO.duration;
          this.playing = false;
        }
        this.setTime(t);
      } else {
        this.setTime(this.time);
      }
      this.viewer.render();
      this.onFrame?.(this.time);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stopLoop() {
    this.looping = false;
    cancelAnimationFrame(this.raf);
  }

  play() {
    if (this.time >= VIDEO.duration - 1e-3) this.time = 0;
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  destroy() {
    this.stopLoop();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
