#!/usr/bin/env node
// Export MP4 1920x1080 @30 i/s en ligne de commande.
// Lance Vite, ouvre la page dans Chromium (Playwright), rend chaque image après
// chargement complet des tuiles, puis encode :
//   - WebCodecs H.264 dans le navigateur (par défaut si disponible), ou
//   - ffmpeg (libx264, CRF 16) à partir d'images JPEG.
//
// Exemples :
//   npm run export                              → out/lille-intro.mp4
//   npm run export -- --headed                  → utilise le GPU (fenêtre visible), bien plus rapide
//   npm run export -- --method ffmpeg           → force ffmpeg
//   npm run export -- --stills 0,150,300,450,599  → captures JPEG uniquement (contrôle visuel)
//   npm run export -- --start 0 --end 90        → n'exporte que les 3 premières secondes
//   npm run export -- --tile-timeout 60000      → attente max des tuiles par image (ms, défaut 30000)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const out = path.resolve(root, opt('out', 'out/lille-intro.mp4'));
const method = opt('method', 'auto');
const headed = !!opt('headed', false);
const start = +opt('start', 0);
const end = +opt('end', 600);
const stills = opt('stills', null);
const port = +opt('port', 5199);
const tileTimeout = +opt('tile-timeout', 30000); // ms max d'attente des tuiles par image

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright manquant : npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const { createServer } = await import('vite');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'warn' });
await server.listen();
const url = `http://127.0.0.1:${port}/?export=1`;

const args = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
// Respecte un proxy d'entreprise éventuel (HTTPS_PROXY)
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const proxy = proxyUrl ? { server: proxyUrl, bypass: '127.0.0.1,localhost' } : undefined;
let browser;
try {
  browser = await chromium.launch({ headless: !headed, args, proxy });
} catch (e) {
  const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  if (!fs.existsSync(exe)) throw e;
  browser = await chromium.launch({ headless: !headed, args, proxy, executablePath: exe });
}
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log(`[page ${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[page error]', e.message));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
page.on('requestfailed', (r) => console.log('[http] échec', r.url(), r.failure()?.errorText));

const cleanup = async () => { await browser.close().catch(() => {}); await server.close().catch(() => {}); };
try {
  console.log('Chargement de', url);
  await page.goto(url);
  await page.waitForFunction(() => !!window.__lille, null, { timeout: 180000, polling: 500 });
  const mode = await page.evaluate(() => window.__lille.engine.mode);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'inconnu';
  });
  console.log(`Mode : ${mode} · GPU : ${renderer}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  if (stills) {
    const frames = String(stills).split(',').map(Number);
    for (const f of frames) {
      const t0 = Date.now();
      const data = await page.evaluate(([i, tt]) => window.__lille.renderFrameJpeg(i, tt), [f, tileTimeout]);
      const file = path.join(path.dirname(out), `still_${String(f).padStart(3, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
      console.log(`image ${f} (${(f / 30).toFixed(2)} s) → ${file} [${((Date.now() - t0) / 1000).toFixed(1)} s]`);
    }
  } else {
    const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']).status === 0;
    const canWC = await page.evaluate(() => window.__lille.canEncodeH264());
    const use = method === 'auto' ? (canWC ? 'webcodecs' : 'ffmpeg') : method;
    if (use === 'ffmpeg' && !hasFfmpeg) throw new Error('ffmpeg introuvable (installez-le ou définissez FFMPEG_PATH).');
    console.log(`Encodage : ${use} · images ${start} → ${end}`);
    const t0 = Date.now();
    if (use === 'webcodecs') {
      const timer = setInterval(async () => {
        const p = await page.evaluate(() => window.__lille.progress).catch(() => null);
        if (p) process.stdout.write(`\r  ${p.frame}/${p.total} images · ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
      }, 2000);
      const size = await page.evaluate(([s, e, tt]) => window.__lille.exportMp4(s, e, tt), [start, end, tileTimeout]);
      clearInterval(timer);
      const fd = fs.openSync(out, 'w');
      for (let off = 0; off < size; off += 4 << 20) {
        const b64 = await page.evaluate(([o, l]) => window.__lille.readChunk(o, l), [off, 4 << 20]);
        fs.writeSync(fd, Buffer.from(b64, 'base64'));
      }
      fs.closeSync(fd);
    } else {
      const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
      const done = new Promise((r) => ff.on('close', r));
      for (let i = start; i < end; i++) {
        const data = await page.evaluate(([f, tt]) => window.__lille.renderFrameJpeg(f, tt), [i, tileTimeout]);
        if (!ff.stdin.write(Buffer.from(data.split(',')[1], 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
        process.stdout.write(`\r  ${i + 1 - start}/${end - start} images · ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
      }
      ff.stdin.end();
      await done;
    }
    console.log(`\nVidéo écrite : ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} Mo) en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
} finally {
  await cleanup();
}
