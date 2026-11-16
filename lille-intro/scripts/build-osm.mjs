// Télécharge (API OSM officielle, par tuiles) et convertit les bâtiments + routes
// du centre de Lille en un JSON compact : public/data/lille-osm.json
// Usage : npm run osm            (télécharge puis convertit)
//         npm run osm -- --cache <dir>   (réutilise un cache de fichiers .osm)
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = [3.0633, 50.6372];
const BBOX = { w: 3.04, s: 50.622, e: 3.09, n: 50.652 };
const STEP = 0.005;
const args = process.argv.slice(2);
const cacheDir = path.resolve(args.includes('--cache') ? args[args.indexOf('--cache') + 1] : '.osm-cache');
const outFile = path.resolve('public/data/lille-osm.json');
fs.mkdirSync(cacheDir, { recursive: true });

const r3 = (x) => Math.round(x * 1000) / 1000;
const tiles = [];
for (let i = 0; r3(BBOX.w + i * STEP) < BBOX.e; i++)
  for (let j = 0; r3(BBOX.s + j * STEP) < BBOX.n; j++) tiles.push([i, j]);

async function download() {
  for (const [i, j] of tiles) {
    const f = path.join(cacheDir, `t_${i}_${j}.osm`);
    if (fs.existsSync(f) && fs.statSync(f).size > 100) continue;
    const lo = r3(BBOX.w + i * STEP), la = r3(BBOX.s + j * STEP);
    const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${lo},${la},${r3(lo + STEP)},${r3(la + STEP)}`;
    for (let k = 0; k < 3; k++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'lille-intro-builder/1.0' } });
        const txt = await res.text();
        if (txt.includes('<osm')) { fs.writeFileSync(f, txt); console.log('OK', f); break; }
      } catch (e) { console.warn('retry', url, e.message); }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

const nodes = new Map();
const ways = new Map();
const relations = new Map();
const towers = new Map();
const attr = (s, k) => { const m = s.match(new RegExp(`\\s${k}="([^"]*)"`)); return m ? m[1] : undefined; };
const decode = (s) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const parseTags = (body) => { const t = {}; for (const m of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\s*\/>/g)) t[decode(m[1])] = decode(m[2]); return t; };

function parseFile(xml) {
  for (const m of xml.matchAll(/<node ([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const id = attr(' ' + m[1], 'id'), lat = attr(' ' + m[1], 'lat'), lon = attr(' ' + m[1], 'lon');
    if (id && lat) nodes.set(id, [+lon, +lat]);
    if (m[3]) { const t = parseTags(m[3]); if (t.man_made === 'tower' && num(t.height) > 40) towers.set(id, [+lon, +lat, num(t.height)]); }
  }
  for (const m of xml.matchAll(/<way ([^>]*)>([\s\S]*?)<\/way>/g)) {
    const id = attr(' ' + m[1], 'id');
    if (ways.has(id)) continue;
    ways.set(id, { nds: [...m[2].matchAll(/<nd ref="(\d+)"/g)].map((x) => x[1]), tags: parseTags(m[2]) });
  }
  for (const m of xml.matchAll(/<relation ([^>]*)>([\s\S]*?)<\/relation>/g)) {
    const id = attr(' ' + m[1], 'id');
    if (relations.has(id)) continue;
    const members = [...m[2].matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"/g)].map((x) => ({ ref: x[1], role: x[2] }));
    relations.set(id, { members, tags: parseTags(m[2]) });
  }
}

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
const num = (v) => { if (v == null) return NaN; const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };

// Hauteurs réelles des repères (absentes ou incomplètes dans OSM)
const NAME_HEIGHTS = { 'Beffroi de Lille': 104, 'Cathédrale Notre-Dame-de-la-Treille': 46 };

function heightOf(tags, id) {
  let h = NAME_HEIGHTS[tags.name] ?? num(tags.height);
  const lv = num(tags['building:levels']);
  const roofH = num(tags['roof:height']);
  if (!(h > 0)) {
    if (lv > 0) h = lv * 3.3 + (roofH > 0 ? roofH : 2.5);
    else {
      const b = tags.building;
      if (['church', 'cathedral'].includes(b)) h = 28;
      else if (['garage', 'garages', 'shed', 'roof', 'kiosk', 'hut'].includes(b)) h = 3.5;
      else h = 10 + hash(id) * 8; // centre ancien : R+2 à R+4
    }
  }
  let mh = num(tags.min_height);
  if (!(mh > 0)) { const ml = num(tags['building:min_level']); mh = ml > 0 ? ml * 3.3 : 0; }
  return [Math.round(h * 10) / 10, Math.round(mh * 10) / 10];
}

const enc = (ll) => [Math.round((ll[0] - ORIGIN[0]) * 1e6), Math.round((ll[1] - ORIGIN[1]) * 1e6)];
function coords(nds) {
  const out = [];
  for (const id of nds) { const n = nodes.get(id); if (!n) return null; out.push(...enc(n)); }
  return out;
}

const ROAD_CLASSES = { motorway: 0, trunk: 0, primary: 1, secondary: 1, tertiary: 2, motorway_link: 2, trunk_link: 2, primary_link: 2, secondary_link: 2, residential: 3, unclassified: 3, living_street: 3, pedestrian: 4, service: 5 };

await (args.includes('--no-download') ? Promise.resolve() : download());
for (const f of fs.readdirSync(cacheDir).filter((f) => f.endsWith('.osm'))) parseFile(fs.readFileSync(path.join(cacheDir, f), 'utf8'));

const buildings = [];
const used = new Set();
for (const [id, w] of ways) {
  const t = w.tags;
  if ((t.building || t['building:part']) && w.nds.length >= 4 && w.nds[0] === w.nds.at(-1)) {
    if (t.building === 'no') continue;
    const c = coords(w.nds.slice(0, -1));
    if (!c) continue;
    const [h, mh] = heightOf(t, id);
    if (h <= mh) continue;
    buildings.push([h, mh, c, t.name ? 1 : 0]);
    used.add(id);
  }
}
for (const [id, r] of relations) {
  if (!r.tags.building && !r.tags['building:part']) continue;
  const [h, mh] = heightOf(r.tags, id);
  for (const m of r.members) {
    if (m.role !== 'outer' || used.has(m.ref)) continue;
    const w = ways.get(m.ref);
    if (!w || w.nds[0] !== w.nds.at(-1)) continue;
    const c = coords(w.nds.slice(0, -1));
    if (c) buildings.push([h, mh, c, 1]);
  }
}
// Tours ponctuelles (ex. Beffroi de la Chambre de commerce, 76 m) : prisme 9 x 9 m
for (const [, [lon, lat, h]] of towers) {
  const dx = 4.5 / (111320 * Math.cos((lat * Math.PI) / 180)), dy = 4.5 / 110574;
  buildings.push([h, 0, [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy]].flatMap(enc), 1]);
}
const roads = [];
for (const [, w] of ways) {
  const cls = ROAD_CLASSES[w.tags.highway];
  if (cls === undefined || w.tags.area === 'yes') continue;
  const c = coords(w.nds);
  if (c && c.length >= 4) roads.push([cls, c]);
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ origin: ORIGIN, bbox: BBOX, buildings, roads }));
console.log(`buildings: ${buildings.length}, roads: ${roads.length}, ${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB -> ${outFile}`);
