// Habillage « bande-annonce » dessiné en Canvas 2D (identique en aperçu et à l'export).
import type { Mode } from './IntroEngine';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const window01 = (t: number, a: number, b: number, fade = 0.5) => smooth(a, a + fade, t) * (1 - smooth(b - fade, b, t));

interface Chyron { a: number; b: number; title: string; sub: string }
const CHYRONS: Chyron[] = [
  { a: 8.4, b: 11.2, title: 'MÉTROPOLE EUROPÉENNE DE LILLE', sub: "Hauts-de-France · 1,2 million d'habitants" },
  { a: 11.5, b: 13.9, title: "BEFFROI DE L'HÔTEL DE VILLE", sub: '104 m · Patrimoine mondial de l’UNESCO' },
  { a: 14.1, b: 16.3, title: 'VIEUX-LILLE', sub: 'Quartier historique · façades flamandes du XVIIᵉ siècle' },
  { a: 16.5, b: 18.2, title: "GRAND'PLACE", sub: 'Place du Général-de-Gaulle' },
  { a: 18.4, b: 20.5, title: 'VIEILLE BOURSE', sub: '1652–1653 · Julien Destrée' },
];

const CREDITS: Record<Mode, string> = {
  google: 'Google · Données cartographiques © Google',
  'ion-google': 'Google · Données cartographiques © Google · Cesium ion',
  'ion-osm': '© OpenStreetMap contributors · Cesium ion · Esri, Maxar · NASA Black Marble',
  osm: '© OpenStreetMap contributors · Esri, Maxar, Earthstar Geographics · NASA Black Marble',
};

export function drawOverlay(ctx: CanvasRenderingContext2D, t: number, w: number, h: number, mode: Mode): void {
  const s = w / 1920;
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  // Ouverture au noir
  const fadeIn = 1 - smooth(0, 1.0, t);
  if (fadeIn > 0) {
    ctx.fillStyle = `rgba(0,0,0,${fadeIn})`;
    ctx.fillRect(0, 0, w, h);
  }

  // Bandes cinéma (s'ouvrent à l'arrivée au sol)
  const bar = h * 0.07 * (1 - 0.6 * smooth(18.6, 20, t));
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, bar);
  ctx.fillRect(0, h - bar, w, bar);

  // Titre principal
  const a = window01(t, 0.7, 3.9, 0.8);
  if (a > 0) {
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f4ead8';
    ctx.shadowColor = 'rgba(255,190,120,0.55)';
    ctx.shadowBlur = 30 * s;
    ctx.font = `300 ${150 * s}px Georgia, 'Times New Roman', serif`;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${46 * s}px`;
    ctx.fillText('LILLE', w / 2 + 23 * s, h * 0.44 - (1 - a) * 12 * s);
    ctx.shadowBlur = 0;
    ctx.font = `400 ${24 * s}px 'Helvetica Neue', Arial, sans-serif`;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${10 * s}px`;
    ctx.fillStyle = 'rgba(244,234,216,0.85)';
    ctx.fillText('HAUTS-DE-FRANCE  ·  50.6372° N  ·  3.0633° E', w / 2 + 5 * s, h * 0.56);
    ctx.globalAlpha = 1;
  }

  // Chyrons de lieux (dégradé sombre pour la lisibilité)
  const anyChyron = Math.max(...CHYRONS.map((c) => window01(t, c.a, c.b, 0.45)));
  if (anyChyron > 0) {
    ctx.save();
    ctx.translate(0, h);
    ctx.scale(2.6, 1);
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, 380 * s);
    grd.addColorStop(0, `rgba(0,0,0,${0.6 * anyChyron})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, -380 * s, 380 * s, 380 * s);
    ctx.restore();
  }
  for (const c of CHYRONS) {
    const al = window01(t, c.a, c.b, 0.45);
    if (al <= 0) continue;
    const x = 110 * s, y = h - bar - 120 * s;
    const slide = (1 - al) * 18 * s;
    ctx.globalAlpha = al;
    ctx.fillStyle = '#e8a25a';
    ctx.fillRect(x, y - 4 * s, 4 * s, 78 * s);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 12 * s;
    ctx.fillStyle = '#f6efe3';
    ctx.font = `600 ${40 * s}px 'Helvetica Neue', Arial, sans-serif`;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${6 * s}px`;
    ctx.fillText(c.title, x + 26 * s + slide, y + 32 * s);
    ctx.font = `400 ${22 * s}px 'Helvetica Neue', Arial, sans-serif`;
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${2 * s}px`;
    ctx.fillStyle = 'rgba(246,239,227,0.8)';
    ctx.fillText(c.sub, x + 26 * s + slide, y + 66 * s);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // Attributions (obligatoires)
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.font = `400 ${15 * s}px Arial, sans-serif`;
  (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(CREDITS[mode], w - 24 * s, h - Math.max(bar, 0) - 10 * s);
  ctx.restore();
}
