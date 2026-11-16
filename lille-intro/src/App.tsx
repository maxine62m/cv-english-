import { useCallback, useEffect, useRef, useState } from 'react';
import { KEYS, VIDEO } from './config';
import { IntroEngine, MODE_LABEL } from './engine/IntroEngine';
import { downloadBlob, exportMp4, pickH264Codec, createFrameCanvas, renderFrame } from './engine/exporter';
import { drawOverlay } from './engine/overlay';

const params = new URLSearchParams(location.search);
const EXPORT_MODE = params.has('export'); // piloté par scripts/export.mjs

declare global {
  interface Window {
    __lille?: {
      engine: IntroEngine;
      canEncodeH264: () => Promise<boolean>;
      exportMp4: (start?: number, end?: number, tileTimeoutMs?: number) => Promise<number>;
      readChunk: (offset: number, length: number) => Promise<string>;
      renderFrameJpeg: (frame: number, tileTimeoutMs?: number) => Promise<string>;
      progress: { frame: number; total: number };
    };
  }
}

function useFitScale(ref: React.RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setScale(Math.min(r.width / VIDEO.width, r.height / VIDEO.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return scale;
}

export default function App() {
  const frameRef = useRef<HTMLDivElement>(null);
  const cesiumRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<IntroEngine | null>(null);
  const [status, setStatus] = useState('Initialisation…');
  const [warning, setWarning] = useState<string>();
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [quality, setQuality] = useState(0.6);
  const [busy, setBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scale = useFitScale(frameRef);

  useEffect(() => {
    let disposed = false;
    let engine: IntroEngine | undefined;
    IntroEngine.create(cesiumRef.current!, (s) => {
      setStatus(s.message);
      if (s.warning) setWarning(s.warning);
    })
      .then((e) => {
        if (disposed) return e.destroy();
        engine = e;
        engineRef.current = e;
        e.setResolutionScale(EXPORT_MODE ? 1 : 0.6);
        e.onFrame = (t) => {
          setTime(t);
          setPlaying(e.playing);
          const c = overlayRef.current;
          if (c) drawOverlay(c.getContext('2d')!, t, VIDEO.width, VIDEO.height, e.mode);
        };
        if (!EXPORT_MODE) e.startLoop();
        installAutomationApi(e);
        setReady(true);
        if (!EXPORT_MODE) e.play();
      })
      .catch((err) => setStatus(`Erreur : ${err?.message ?? err}`));
    return () => {
      disposed = true;
      engine?.destroy();
    };
  }, []);

  const toggle = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    if (e.playing) e.pause();
    else e.play();
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') {
        ev.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const onExport = async () => {
    const e = engineRef.current;
    if (!e) return;
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      setBusy('Export 0 %');
      const blob = await exportMp4(e, {
        signal: ac.signal,
        onProgress: (f, n) => setBusy(`Export ${Math.round((100 * f) / n)} % (${f}/${n})`),
      });
      downloadBlob(blob, 'lille-intro-1920x1080-30fps.mp4');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') alert((err as Error).message);
    } finally {
      e.setResolutionScale(quality);
      setBusy(null);
    }
  };

  const onPreload = async () => {
    const e = engineRef.current;
    if (!e) return;
    e.pause();
    e.stopLoop();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for (let t = 0; t <= VIDEO.duration && !ac.signal.aborted; t += 0.5) {
        setBusy(`Préchargement ${Math.round((100 * t) / VIDEO.duration)} %`);
        await e.renderSettled(t, 15000);
        setTime(t);
      }
    } finally {
      e.setTime(0);
      e.startLoop();
      setBusy(null);
    }
  };

  const setQ = (q: number) => {
    setQuality(q);
    engineRef.current?.setResolutionScale(q);
  };

  return (
    <div className={`app ${EXPORT_MODE ? 'export' : ''}`}>
      <div className="frame" ref={frameRef}>
        <div className="stage" style={{ transform: `translate(-50%, -50%) scale(${EXPORT_MODE ? 1 : scale})` }}>
          <div ref={cesiumRef} className="cesium" />
          <canvas ref={overlayRef} className="overlay" width={VIDEO.width} height={VIDEO.height} />
          {!ready && <div className="loading">{status}</div>}
        </div>
      </div>
      {!EXPORT_MODE && (
        <div className="controls">
          <button onClick={toggle} disabled={!ready || !!busy}>{playing ? '❚❚ Pause' : '▶ Lecture'}</button>
          <button onClick={() => { engineRef.current?.setTime(0); engineRef.current?.play(); }} disabled={!ready || !!busy}>⟲ Rejouer</button>
          <input
            type="range" min={0} max={VIDEO.duration} step={1 / VIDEO.fps} value={time} disabled={!ready || !!busy}
            onChange={(ev) => { engineRef.current?.pause(); engineRef.current?.setTime(+ev.target.value); }}
          />
          <span className="time">{time.toFixed(2)} s / {VIDEO.duration} s</span>
          <select value={quality} onChange={(ev) => setQ(+ev.target.value)} disabled={!!busy}>
            <option value={0.4}>Aperçu rapide (40 %)</option>
            <option value={0.6}>Aperçu (60 %)</option>
            <option value={1}>Pleine résolution</option>
          </select>
          <button onClick={onPreload} disabled={!ready || !!busy}>Précharger les tuiles</button>
          <button className="primary" onClick={onExport} disabled={!ready || !!busy}>⬇ Exporter MP4 1080p30</button>
          {busy && <><span className="busy">{busy}</span><button onClick={() => abortRef.current?.abort()}>Annuler</button></>}
          <span className={`mode ${engineRef.current?.mode ?? ''}`} title={warning ?? ''}>
            {ready && engineRef.current ? MODE_LABEL[engineRef.current.mode] : status}
            {!KEYS.google && !KEYS.ion && ready && ' — ajoutez une clé dans .env pour le rendu photoréaliste'}
          </span>
          {warning && <span className="warn">⚠ {warning}</span>}
        </div>
      )}
    </div>
  );
}

/** API utilisée par l'export en ligne de commande (Playwright). */
function installAutomationApi(engine: IntroEngine) {
  let mp4: Uint8Array | null = null;
  const progress = { frame: 0, total: VIDEO.duration * VIDEO.fps };
  let frameCanvas: ReturnType<typeof createFrameCanvas> | null = null;
  window.__lille = {
    engine,
    progress,
    canEncodeH264: async () => (await pickH264Codec()) !== null,
    exportMp4: async (start?: number, end?: number, tileTimeoutMs?: number) => {
      const blob = await exportMp4(engine, {
        startFrame: start,
        endFrame: end,
        tileTimeoutMs,
        onProgress: (f, n) => { progress.frame = f; progress.total = n; },
      });
      mp4 = new Uint8Array(await blob.arrayBuffer());
      return mp4.byteLength;
    },
    readChunk: async (offset, length) => {
      if (!mp4) return '';
      const sub = mp4.subarray(offset, offset + length);
      let s = '';
      for (let i = 0; i < sub.length; i += 0x8000) s += String.fromCharCode(...sub.subarray(i, i + 0x8000));
      return btoa(s);
    },
    renderFrameJpeg: async (frame, tileTimeoutMs) => {
      frameCanvas ??= createFrameCanvas();
      engine.stopLoop();
      engine.setResolutionScale(1);
      await renderFrame(engine, frameCanvas.ctx, frame, tileTimeoutMs);
      progress.frame = frame + 1;
      return frameCanvas.canvas.toDataURL('image/jpeg', 0.95);
    },
  };
}
