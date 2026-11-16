// Export MP4 H.264 1920x1080 @30 i/s, image par image (déterministe, tuiles chargées
// avant chaque image) via WebCodecs + mp4-muxer. Aucun serveur requis.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { VIDEO } from '../config';
import type { IntroEngine } from './IntroEngine';

const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.420028'];

export async function pickH264Codec(): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of CODECS) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: VIDEO.width, height: VIDEO.height, bitrate: 24e6, framerate: VIDEO.fps });
      if (r.supported) return codec;
    } catch {
      /* suivant */
    }
  }
  return null;
}

export interface ExportOptions {
  onProgress?: (frame: number, total: number) => void;
  signal?: AbortSignal;
  /** Délai max d'attente des tuiles par image (ms). */
  tileTimeoutMs?: number;
  startFrame?: number;
  endFrame?: number;
}

export function createFrameCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = VIDEO.width;
  canvas.height = VIDEO.height;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: false })! };
}

export async function renderFrame(engine: IntroEngine, ctx: CanvasRenderingContext2D, frame: number, tileTimeoutMs = 30000) {
  await engine.renderSettled(frame / VIDEO.fps, tileTimeoutMs);
  engine.composeInto(ctx);
}

export async function exportMp4(engine: IntroEngine, opts: ExportOptions = {}): Promise<Blob> {
  const codec = await pickH264Codec();
  if (!codec) throw new Error('WebCodecs H.264 indisponible dans ce navigateur (utilisez Chrome/Edge, ou `npm run export`).');
  const total = Math.round(VIDEO.duration * VIDEO.fps);
  const first = opts.startFrame ?? 0;
  const last = Math.min(total, opts.endFrame ?? total);
  const { canvas, ctx } = createFrameCanvas();

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: VIDEO.width, height: VIDEO.height, frameRate: VIDEO.fps },
    fastStart: 'in-memory',
  });
  let encodeError: unknown;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encodeError = e),
  });
  encoder.configure({ codec, width: VIDEO.width, height: VIDEO.height, bitrate: 24e6, framerate: VIDEO.fps, avc: { format: 'avc' } });

  engine.stopLoop();
  engine.pause();
  engine.setResolutionScale(1);
  try {
    for (let i = first; i < last; i++) {
      if (opts.signal?.aborted) throw new DOMException('Export annulé', 'AbortError');
      if (encodeError) throw encodeError;
      await renderFrame(engine, ctx, i, opts.tileTimeoutMs);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(((i - first) * 1e6) / VIDEO.fps), duration: Math.round(1e6 / VIDEO.fps) });
      encoder.encode(vf, { keyFrame: (i - first) % VIDEO.fps === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
      opts.onProgress?.(i - first + 1, last - first);
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    engine.startLoop();
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
