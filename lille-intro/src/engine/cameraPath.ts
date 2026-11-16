// Trajectoire caméra continue : images-clés + interpolation cubique monotone
// (Fritsch–Carlson) par canal → C1, sans dépassement (pas de plongée sous le sol).
import { PLACES } from '../config';

export interface Key {
  t: number;
  cam: [lon: number, lat: number, hAgl: number];
  look: [lon: number, lat: number, hAgl: number];
  fov: number; // champ horizontal en degrés
}

const VB = PLACES.vieilleBourse;
const BH = PLACES.beffroiHdV;

/**
 * Trajet NO → SE : mer de nuages au-dessus de la Flandre, traversée de la couche,
 * plongée sur Lille, survol du Vieux-Lille (beffroi de l'Hôtel de Ville en ligne de mire),
 * entrée par la rue Esquermoise sur la Grand'Place, arrêt face à la Vieille Bourse.
 */
export const KEYS: Key[] = [
  { t: 0.0, cam: [2.935, 50.735, 8200], look: [3.2, 50.56, 0], fov: 62 },
  { t: 4.0, cam: [2.966, 50.712, 6200], look: [3.12, 50.6, 0], fov: 64 },
  { t: 6.0, cam: [2.996, 50.69, 3500], look: [3.075, 50.63, 0], fov: 68 },
  { t: 8.0, cam: [3.019, 50.672, 1850], look: [3.066, 50.636, 0], fov: 66 },
  { t: 10.5, cam: [3.041, 50.6555, 720], look: [3.063, 50.6385, 0], fov: 72 },
  { t: 13.0, cam: [3.0548, 50.6443, 210], look: [BH.lon, BH.lat, 60], fov: 66 },
  { t: 15.0, cam: [3.0592, 50.6409, 115], look: [3.0638, 50.6372, 10], fov: 62 },
  { t: 17.0, cam: [3.0616, 50.6385, 58], look: [VB.lon - 0.0002, VB.lat, 12], fov: 60 },
  { t: 18.6, cam: [3.06275, 50.63735, 14], look: [VB.lon - 0.0003, VB.lat, 10], fov: 58 },
  // Arrivée au sud-ouest de la colonne de la Déesse, face à la façade ouest de la Vieille Bourse
  { t: 20.0, cam: [3.06352, 50.63668, 1.8], look: [VB.lon - 0.00033, VB.lat, 9], fov: 58 },
];

function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  // départ et arrivée en douceur (vitesse nulle aux extrémités → ease-in/out)
  m[0] = 0.35 * d[0];
  m[n - 1] = 0;
  return m;
}

class Channel {
  private xs: number[];
  private ys: number[];
  private m: number[];
  constructor(xs: number[], ys: number[]) {
    this.xs = xs;
    this.ys = ys;
    this.m = monotoneTangents(xs, ys);
  }
  at(x: number): number {
    const { xs, ys, m } = this;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const s = (x - xs[i]) / h;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h * m[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * h * m[i + 1];
  }
}

const ts = KEYS.map((k) => k.t);
const ch = (f: (k: Key) => number) => new Channel(ts, KEYS.map(f));
const camLon = ch((k) => k.cam[0]);
const camLat = ch((k) => k.cam[1]);
const camLogH = ch((k) => Math.log(k.cam[2] + 2));
const lookLon = ch((k) => k.look[0]);
const lookLat = ch((k) => k.look[1]);
const lookH = ch((k) => k.look[2]);
const fov = ch((k) => k.fov);

export interface PathSample {
  cam: [number, number, number];
  look: [number, number, number];
  fovDeg: number;
}

export function samplePath(t: number): PathSample {
  return {
    cam: [camLon.at(t), camLat.at(t), Math.exp(camLogH.at(t)) - 2],
    look: [lookLon.at(t), lookLat.at(t), lookH.at(t)],
    fovDeg: fov.at(t),
  };
}

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((50.64 * Math.PI) / 180);

/** Vitesse caméra (m/s) et « vitesse apparente » normalisée par l'altitude (pour les effets). */
export function pathSpeed(t: number): { mps: number; apparent: number } {
  const dt = 1 / 60;
  const a = samplePath(Math.max(0, t - dt)).cam;
  const b = samplePath(Math.min(20, t + dt)).cam;
  const dx = (b[0] - a[0]) * M_PER_DEG_LON, dy = (b[1] - a[1]) * M_PER_DEG_LAT, dz = b[2] - a[2];
  const span = Math.min(20, t + dt) - Math.max(0, t - dt);
  const mps = Math.hypot(dx, dy, dz) / span;
  const h = samplePath(t).cam[2];
  return { mps, apparent: mps / (h + 60) };
}

/** Lacet de la trajectoire (rad), pour le roulis de virage. */
export function pathHeading(t: number): number {
  const a = samplePath(Math.max(0, t - 0.05)).cam, b = samplePath(Math.min(20, t + 0.05)).cam;
  return Math.atan2((b[0] - a[0]) * M_PER_DEG_LON, (b[1] - a[1]) * M_PER_DEG_LAT);
}
