import { spawn } from 'child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, extname, join } from 'path';
import config from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * MediaSource only accepts *self-describing* fragments (init segment + repeated
 * moof/mdat pairs). The music library is progressive MP4 — one global sample table at
 * the end of the file — so byte-range slicing yields headerless frames that appendBuffer
 * cannot decode. This service remuxes (never re-encodes) a track into fragmented
 * segments once, cached outside the scanned music directory.
 */

// `-c copy` for every entry here, so conversion cost is I/O bound (~1s per few minutes).
const SEGMENTABLE = {
  '.m4a': { container: 'fmp4', mime: 'audio/mp4; codecs="mp4a.40.2"' },
};

/**
 * tracks.format stores the ffprobe container string (e.g. "M4A/isom/iso2"), not an
 * extension, so match on every plausible token before giving up.
 */
function formatCandidates(track) {
  const raw = String(track.format || '').toLowerCase();
  const candidates = raw.split(/[^a-z0-9]+/).filter(Boolean);
  if (track.filepath) {
    candidates.push(extname(track.filepath).slice(1).toLowerCase());
  }
  return candidates;
}

/**
 * @param source track object ({ format, filepath }) or a bare format/extension string
 */
export function planSegments(source) {
  const track = typeof source === 'string' || !source ? { format: source } : source;

  for (const candidate of formatCandidates(track)) {
    const plan = SEGMENTABLE[`.${candidate}`];
    if (plan) return { supported: true, format: `.${candidate}`, ...plan };
  }

  const shown = formatCandidates(track)[0] || 'unknown';
  return {
    supported: false,
    format: shown,
    reason: `Format "${shown}" is not segmentable yet; play it with the V1 player`,
  };
}

export function segmentDirFor(trackId) {
  return join(config.segmentsDir, String(trackId));
}

function manifestPathFor(trackId) {
  return join(segmentDirFor(trackId), 'manifest.json');
}

async function readManifest(trackId) {
  try {
    return JSON.parse(await readFile(manifestPathFor(trackId), 'utf8'));
  } catch {
    return null;
  }
}

const inflight = new Map();

/**
 * Return the segment manifest for a track, converting on first call.
 *
 * { version, trackId, source, fingerprint, duration, segmentDuration, mime, container,
 *   initFile, segments: [{ index, file, start, end, duration }], createdAt }
 */
export async function getManifest(track, { force = false } = {}) {
  const plan = planSegments(track);
  if (!plan.supported) {
    throw Object.assign(new Error(plan.reason), { code: 'UNSUPPORTED_FORMAT' });
  }

  const sourcePath = join(config.musicDir, track.filepath);
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat) {
    throw Object.assign(new Error('Audio file not found on disk'), { code: 'SOURCE_MISSING' });
  }

  // Any edit to the underlying file invalidates cached segments.
  const fingerprint = `${sourceStat.size}-${Math.round(sourceStat.mtimeMs)}`;

  if (!force) {
    const cached = await readManifest(track.id);
    if (cached && cached.fingerprint === fingerprint) return cached;
  }

  const pending = inflight.get(track.id);
  if (pending) return pending;

  const job = convert({ track, plan, sourcePath, fingerprint })
    .finally(() => inflight.delete(track.id));

  inflight.set(track.id, job);
  return job;
}

async function convert({ track, plan, sourcePath, fingerprint }) {
  const dir = segmentDirFor(track.id);
  const tmpDir = `${dir}.tmp-${process.pid}-${Date.now()}`;
  const startedAt = Date.now();

  await mkdir(config.segmentsDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    await runFfmpeg({ sourcePath, tmpDir, plan });

    if (!existsSync(join(tmpDir, 'init.mp4'))) {
      throw new Error('ffmpeg produced no init segment');
    }

    const segments = await parsePlaylist(tmpDir);
    if (segments.length === 0) {
      throw new Error('ffmpeg produced no media segments');
    }

    const manifest = {
      version: 1,
      trackId: track.id,
      source: track.filepath,
      fingerprint,
      duration: Number(track.duration) || segments[segments.length - 1].end,
      segmentDuration: config.segmentDuration,
      mime: plan.mime,
      container: plan.container,
      initFile: 'init.mp4',
      segments,
      createdAt: new Date().toISOString(),
    };

    await writeFile(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Publish atomically so clients never observe a half-converted track.
    await rm(dir, { recursive: true, force: true });
    await rename(tmpDir, dir);

    logger.info(
      { trackId: track.id, segments: segments.length, tookMs: Date.now() - startedAt },
      'Track segmented for V2 player',
    );

    return manifest;
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    logger.error({ trackId: track.id, error: error.message }, 'Segmentation failed');
    throw error;
  }
}

function runFfmpeg({ sourcePath, tmpDir }) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    '-vn',
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', String(config.segmentDuration),
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments',
    join(tmpDir, 'stream.m3u8'),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${config.segmentTimeoutMs}ms`));
    }, config.segmentTimeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/**
 * ffmpeg writes `init.mp4` plus `streamN.m4s` next to the playlist. EXTINF gives exact
 * per-segment durations, which is what lets the player seek without guessing byte offsets.
 */
async function parsePlaylist(tmpDir) {
  const text = await readFile(join(tmpDir, 'stream.m3u8'), 'utf8');
  const lines = text.split(/\r?\n/);
  const segments = [];
  let clock = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF:')) continue;

    const duration = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
    const file = lines.slice(i + 1).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (!Number.isFinite(duration) || !file) continue;

    // Playlist entries may carry a directory prefix; keep only the basename we serve.
    const name = file.split('/').pop();
    segments.push({
      index: segments.length,
      file: name,
      duration: Number(duration.toFixed(3)),
      start: Number(clock.toFixed(3)),
      end: Number((clock + duration).toFixed(3)),
    });
    clock += duration;
  }

  return segments;
}

async function requireManifest(trackId) {
  const manifest = await readManifest(trackId);
  if (!manifest) {
    throw Object.assign(new Error('Track has not been segmented yet'), { code: 'NOT_SEGMENTED' });
  }
  return manifest;
}

export async function getInitFile(trackId) {
  const manifest = await requireManifest(trackId);
  return { manifest, path: join(segmentDirFor(trackId), manifest.initFile) };
}

export async function getSegmentFile(trackId, index) {
  const manifest = await requireManifest(trackId);
  const segment = manifest.segments[Number(index)];
  if (!segment) {
    throw Object.assign(new Error(`Segment ${index} does not exist`), { code: 'SEGMENT_OUT_OF_RANGE' });
  }
  return { manifest, segment, path: join(segmentDirFor(trackId), segment.file) };
}

export async function listSegmentFiles(trackId) {
  const dir = segmentDirFor(trackId);
  const names = await readdir(dir).catch(() => []);
  return names.filter((name) => name !== 'manifest.json' && name !== 'stream.m3u8');
}

export async function dropSegments(trackId) {
  await rm(segmentDirFor(trackId), { recursive: true, force: true });
}

export default {
  planSegments,
  getManifest,
  getInitFile,
  getSegmentFile,
  listSegmentFiles,
  dropSegments,
  segmentDirFor,
};
