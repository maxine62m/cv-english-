// Données OpenStreetMap réelles de Lille (public/data/lille-osm.json, générées par `npm run osm`) :
//  - bâtiments extrudés (mode secours, sans clé)
//  - chaussées éclairées (modes sans photogrammétrie)
//  - réverbères (tous les modes) : points + halos en mètres
import * as Cesium from 'cesium';
import { createExtrudedNightMaterial } from './nightShader';

interface OsmData {
  origin: [number, number];
  buildings: [h: number, minH: number, coords: number[], named: number][];
  roads: [cls: number, coords: number[]][];
}

export interface CityOptions {
  buildings: boolean;
  roads: 'none' | 'flat' | 'terrain';
  groundHeight: number;
  eyeToEnu: Cesium.Matrix4;
}

const ROAD_WIDTH = [20, 14, 11, 8, 7, 4.5];
const ROAD_ALPHA = [0.34, 0.32, 0.28, 0.22, 0.24, 0.12];
const LIGHT_SPACING = [34, 27, 27, 30, 20, 45];

function decode(origin: [number, number], c: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.length; i += 2) {
    const lon = origin[0] + c[i] / 1e6, lat = origin[1] + c[i + 1] / 1e6;
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - lon) < 1e-8 && Math.abs(out[n - 1] - lat) < 1e-8) continue;
    out.push(lon, lat);
  }
  return out;
}

function haloTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,236,200,1)');
  grd.addColorStop(0.08, 'rgba(255,200,120,0.95)');
  grd.addColorStop(0.3, 'rgba(255,150,60,0.35)');
  grd.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return c;
}

export class OsmCity {
  buildings?: Cesium.Primitive;
  roads?: Cesium.Primitive | Cesium.GroundPrimitive;
  points = new Cesium.PointPrimitiveCollection();
  halos = new Cesium.BillboardCollection();
  material?: Cesium.Material;
  private scene: Cesium.Scene;

  constructor(scene: Cesium.Scene) {
    this.scene = scene;
  }

  static async load(scene: Cesium.Scene, opts: CityOptions): Promise<OsmCity> {
    const res = await fetch('/data/lille-osm.json');
    if (!res.ok) throw new Error('lille-osm.json introuvable (lancer `npm run osm`)');
    const data = (await res.json()) as OsmData;
    const city = new OsmCity(scene);
    const g = opts.groundHeight;

    if (opts.buildings) {
      const vertexFormat = Cesium.MaterialAppearance.MaterialSupport.BASIC.vertexFormat;
      const instances: Cesium.GeometryInstance[] = [];
      for (const [h, mh, c] of data.buildings) {
        const flat = decode(data.origin, c);
        if (flat.length < 6) continue;
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
              height: g + h,
              extrudedHeight: g + mh,
              closeBottom: false,
              vertexFormat,
            }),
          }),
        );
      }
      city.material = createExtrudedNightMaterial(opts.eyeToEnu);
      city.buildings = scene.primitives.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.MaterialAppearance({
            material: city.material,
            materialSupport: Cesium.MaterialAppearance.MaterialSupport.BASIC,
            flat: true,
            faceForward: false,
            closed: false,
          }),
          asynchronous: true,
          releaseGeometryInstances: true,
          compressVertices: false,
        }),
      );
    }

    if (opts.roads !== 'none') {
      const instances = data.roads.map(([cls, c]) =>
        new Cesium.GeometryInstance({
          geometry: new Cesium.CorridorGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray(decode(data.origin, c)),
            width: ROAD_WIDTH[cls],
            height: opts.roads === 'flat' ? g + 0.25 : undefined,
            cornerType: Cesium.CornerType.ROUNDED,
            vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(new Cesium.Color(1.0, 0.6, 0.27, ROAD_ALPHA[cls])),
          },
        }),
      );
      city.roads =
        opts.roads === 'flat'
          ? scene.primitives.add(
              new Cesium.Primitive({
                geometryInstances: instances,
                appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
                asynchronous: true,
              }),
            )
          : scene.primitives.add(
              new Cesium.GroundPrimitive({
                geometryInstances: instances,
                appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
                classificationType: Cesium.ClassificationType.TERRAIN,
                asynchronous: true,
              }),
            );
    }

    // Réverbères le long des voies, en quinconce
    const halo = haloTexture().toDataURL(); // même URL → une seule entrée dans l'atlas de textures
    const pointColor = new Cesium.Color(1.0, 0.78, 0.48, 1.0);
    let k = 0;
    for (const [cls, c] of data.roads) {
      const flat = decode(data.origin, c);
      const pts = Cesium.Cartesian3.fromDegreesArray(flat);
      const spacing = LIGHT_SPACING[cls];
      let carry = spacing * 0.5;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const seg = Cesium.Cartesian3.distance(a, b);
        if (seg < 1e-3) continue;
        let s = carry;
        while (s < seg) {
          const f = s / seg;
          const lon = flat[2 * i] + (flat[2 * i + 2] - flat[2 * i]) * f;
          const lat = flat[2 * i + 1] + (flat[2 * i + 3] - flat[2 * i + 1]) * f;
          // décalage latéral alterné (trottoirs)
          const side = (k++ % 2 === 0 ? 1 : -1) * (ROAD_WIDTH[cls] * 0.45);
          const dx = flat[2 * i + 2] - flat[2 * i], dy = flat[2 * i + 3] - flat[2 * i + 1];
          const len = Math.hypot(dx * 0.634, dy) || 1;
          const ox = (-dy / len) * side / 70600, oy = ((dx * 0.634) / len) * side / 111000;
          const pos = Cesium.Cartesian3.fromDegrees(lon + ox, lat + oy, g + 6.5);
          city.points.add({
            position: pos,
            color: pointColor,
            pixelSize: 2.6,
            scaleByDistance: new Cesium.NearFarScalar(60, 2.6, 9000, 0.55),
          });
          if (cls <= 4) {
            city.halos.add({
              position: pos,
              image: halo,
              sizeInMeters: true,
              width: 15,
              height: 15,
              color: new Cesium.Color(1, 1, 1, 0.75),
              translucencyByDistance: new Cesium.NearFarScalar(400, 1.0, 2500, 0.0),
            });
          }
          s += spacing;
        }
        carry = s - seg;
      }
    }
    scene.primitives.add(city.halos);
    scene.primitives.add(city.points);
    return city;
  }

  get ready(): boolean {
    const okB = !this.buildings || this.buildings.ready;
    const okR = !this.roads || this.roads.ready;
    return okB && okR;
  }

  /** Ajustements par image selon l'altitude caméra. */
  update(eyeToEnu: Cesium.Matrix4, hAgl: number): void {
    if (this.material) Cesium.Matrix4.toArray(eyeToEnu, this.material.uniforms.u_eyeToEnu);
    this.halos.show = hAgl < 2600;
    void this.scene;
  }
}
