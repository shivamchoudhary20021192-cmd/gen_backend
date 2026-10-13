import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../../core/logger';

const run = promisify(execFile);

/**
 * A still frame out of a video, so a video behaves like an image everywhere
 * downstream.
 *
 * The media library, the banner form and the storefront all want a picture
 * before they want a video: a grid tile, a preview, a poster to paint while the
 * file streams. Pulling one frame here means the rest of the pipeline — sharp
 * metadata, the LQIP, the whole variant ladder — works on video without
 * knowing video exists.
 *
 * ffmpeg is called as a binary rather than through a wrapper package. It is one
 * command, and a native dependency that has to compile is a worse thing to own
 * than a documented `apt install ffmpeg`.
 *
 * **Every failure here is survivable.** A box without ffmpeg still accepts
 * video uploads; they simply keep the generic icon. Losing a thumbnail is not a
 * reason to lose the upload.
 */

/** ffmpeg and ffprobe can take a while on a long file; they must not hang a request. */
const TIMEOUT_MS = 30_000;

export interface VideoPoster {
  /** A JPEG of one frame, ready for sharp. */
  frame: Buffer;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

let ffmpegAvailable: boolean | null = null;

/** Checked once per process — shelling out on every upload to ask the same question is waste. */
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await run('ffmpeg', ['-version'], { timeout: 5_000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    logger.warn('media.ffmpeg_missing', {
      detail: 'Video uploads will have no poster frame. Install ffmpeg to enable it.',
    });
  }
  return ffmpegAvailable;
}

async function probe(file: string): Promise<{ durationMs: number | null; width: number | null; height: number | null }> {
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'format=duration:stream=width,height',
        '-of', 'json',
        file,
      ],
      { timeout: TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { width?: number; height?: number }[];
    };
    const seconds = Number(parsed.format?.duration ?? NaN);
    const stream = parsed.streams?.[0];
    return {
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
      width: stream?.width ?? null,
      height: stream?.height ?? null,
    };
  } catch (error) {
    logger.warn('media.ffprobe_failed', { error: String(error) });
    return { durationMs: null, width: null, height: null };
  }
}

/**
 * Where to take the frame from.
 *
 * Not frame zero: the first frame of a video is very often black, a fade-in, or
 * a slate, and a grid full of black squares is no better than a grid full of
 * icons. One second in is past all of that on real footage, and on a clip
 * shorter than that, a third of the way through is.
 */
function seekSeconds(durationMs: number | null): number {
  if (!durationMs || durationMs <= 0) return 1;
  if (durationMs < 2000) return Math.max(0, durationMs / 3000);
  return 1;
}

export async function extractPoster(buffer: Buffer, extension: string): Promise<VideoPoster | null> {
  if (!(await hasFfmpeg())) return null;

  // ffmpeg needs to seek, and it cannot seek a pipe. A temp file is the price.
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'veylor-poster-'));
    const input = path.join(dir, `source.${extension || 'mp4'}`);
    const output = path.join(dir, 'frame.jpg');
    await writeFile(input, buffer);

    const meta = await probe(input);

    await run(
      'ffmpeg',
      [
        // -ss before -i seeks by keyframe, which is near-instant even on a
        // long file. After -i it decodes everything up to that point.
        '-ss', String(seekSeconds(meta.durationMs)),
        '-i', input,
        '-frames:v', '1',
        '-q:v', '3',
        '-y',
        output,
      ],
      { timeout: TIMEOUT_MS },
    );

    const { readFile } = await import('node:fs/promises');
    const frame = await readFile(output);
    if (frame.length === 0) return null;

    return { frame, durationMs: meta.durationMs, width: meta.width, height: meta.height };
  } catch (error) {
    logger.warn('media.poster_extraction_failed', { error: String(error) });
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
