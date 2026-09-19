import { spawn } from 'child_process';
import { rename, rm, stat } from 'fs/promises';
import { join } from 'path';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { canonicalFormat } from '../utils/audioFormat.js';
import { scanMp4 } from '../utils/mp4Boxes.js';

/**
 * The library holds progressive MP4: one sample table at the end of the file, so a
 * byte-range slice carries no timestamps and MediaSource refuses it. Rather than keeping a
 * second set of segment files around, tracks are normalised **in place** into fragmented
 * MP4 — still playable by the V1 element player, but now appendable to a SourceBuffer.
 *
 * Conversion is always `-c copy` (no re-encode). The original file is only replaced after
 * the remuxed output has been verified, so a failure can never destroy audio.
 */

const AAC_OBJECT_TYPE = {
  // ffprobe profile -> MPEG4 audio object type
  'LC': 2,
  'Main': 1,
  'SSR': 3,
  'LTP': 4,
  'HE-AAC': 5,
  'HE-AAC v2': 29,
};

export function planNormalization(track) {
  const format = canonicalFormat(track);
  if (format !== 'm4a') {
    return {
      supported: false,
      format,
      reason: `Format "${format || 'unknown'}" is not fragmented-container-ready; play it with the V1 player`,
    };
  }
  return { supported: true, format };
}

function run(cmd, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 262_144) stdout = stdout.slice(-262_144);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    const timer = timeoutMs
      ? setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs)
      : null;

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/** Audio object type must match the bitstream or SourceBuffer.appendBuffer() throws. */
export async function probeCodec(filePath) {
  const stdout = await run(config.ffprobePath, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,profile,sample_rate,channels',
    // Fragmented containers leave mdhd.duration at zero, so the real length has to be
    // summed from the fragments — ffprobe already does that for us.
    '-show_entries', 'format=duration',
    '-of', 'json',
    filePath,
  ], { timeoutMs: config.normalizeTimeoutMs });

  const parsed = JSON.parse(stdout);
  const stream = parsed?.streams?.[0];
  const durationSec = Number(parsed?.format?.duration);
  if (!stream) throw new Error('no audio stream found');

  if (String(stream.codec_name).toLowerCase() !== 'aac') {
    return { codecName: String(stream.codec_name), mime: null, durationSec };
  }

  const objectType = AAC_OBJECT_TYPE[String(stream.profile)] ?? 2;
  return {
    codecName: 'aac',
    profile: stream.profile,
    sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
    channels: stream.channels ? Number(stream.channels) : null,
    durationSec,
    mime: `audio/mp4; codecs="mp4a.40.${objectType}"`,
  };
}

/**
 * Total length. Fragmented containers leave mdhd.duration at zero, so the probed value
 * (ffprobe summing the fragments) is normally the only one available.
 */
function resolveDuration(scan, codec) {
  const fromContainer = Number.isFinite(scan.durationSec) ? scan.durationSec : null;
  const probed = Number.isFinite(codec?.durationSec) ? codec.durationSec : null;
  return fromContainer ?? probed;
}

/**
 * Below this average fragment length the container was split at the wrong granularity — an
 * early revision passed -frag_duration in milliseconds and produced one fragment per AAC frame.
 * Such indices are rebuilt instead of served.
 */
const MIN_FRAGMENT_SECONDS = 0.5;
const META_VERSION = 2;

function fingerprintOf(stats) {
  return `${stats.size}-${Math.round(stats.mtimeMs)}`;
}

function metaFromScan(scan, codec, fingerprint) {
  const duration = resolveDuration(scan, codec);

  // The final fragment has no successor to measure against, so close it at the total length.
  const fragments = scan.fragments.map((fragment) => (
    fragment.end === null && fragment.index === scan.fragments.length - 1 && Number.isFinite(duration)
      ? { ...fragment, end: Number(duration.toFixed(3)) }
      : fragment
  ));

  return {
    version: META_VERSION,
    fingerprint,
    fragmented: scan.fragmented,
    fileSize: scan.fileSize,
    timescale: scan.timescale,
    mime: codec.mime,
    codec: codec.codecName,
    durationSec: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
    initEnd: scan.initEnd,
    fragmentCount: scan.fragments.length,
    fragments,
  };
}

/**
 * Ensure a track file is fragmented MP4 and return its playback metadata.
 * `apply: false` reports what would happen without touching disk.
 */
/**
 * Public entry point: never throws. Every caller (startup sweep, download completion,
 * manifest route) reacts the same way — report it and let playback fall back to V1.
 */
export async function normalizeTrack(track, options = {}) {
  try {
    return await runNormalization(track, options);
  } catch (error) {
    logger.warn({ trackId: track?.id, error: error.message }, 'Normalisation aborted');
    return { status: 'failed', reason: error.message };
  }
}

async function runNormalization(track, { apply = true, fragmentDurationMs = config.fragmentDurationMs } = {}) {
  const plan = planNormalization(track);
  if (!plan.supported) {
    return { status: 'skipped', reason: plan.reason };
  }

  const filePath = join(config.musicDir, track.filepath);
  const before = await stat(filePath).catch(() => null);
  if (!before) return { status: 'missing', reason: 'file not found' };

  const scan = await scanMp4(filePath);
  const codec = await probeCodec(filePath);

  if (!codec.mime) {
    return {
      status: 'skipped',
      reason: `audio codec "${codec.codecName}" has no verified MSE media type`,
    };
  }

  const fragmented = scan.fragmented && scan.fragments.length > 0;
  const durationSec = resolveDuration(scan, codec) || 0;
  // "Already fragmented" is not enough: files written before the -frag_duration units fix are
  // technically fragmented but split per frame, so compare against the requested granularity.
  const overFragmented = durationSec > MIN_FRAGMENT_SECONDS * 2
    && durationSec / scan.fragments.length < MIN_FRAGMENT_SECONDS;

  if (fragmented && !overFragmented) {
    const meta = metaFromScan(scan, codec, fingerprintOf(before));
    // The file is in shape but the row may not be: a rebuilt database, a file copied in by hand,
    // or a META_VERSION bump. `getPlayMeta` repairs that lazily on the first manifest request, so
    // it is not an error — but a tool that writes rows has to say it wrote them, otherwise a run
    // that changed the database reports "nothing to do".
    if (metaIsCurrent(track, meta)) return { status: 'fragmented', meta };
    if (apply) await persist(track, meta);
    return {
      status: 'metadata',
      meta,
      reason: track.mse_meta ? 'stored metadata out of date' : 'no stored metadata',
    };
  }

  if (!apply) {
    return {
      status: 'would-normalize',
      reason: fragmented ? 'fragments far below the requested length' : 'progressive container',
    };
  }

  // ffmpeg's mp4 muxer reads -frag_duration in microseconds; feeding it milliseconds yields
  // frame-sized fragments (thousands per track) instead of the requested prefetch chunks.
  const fragmentMicroseconds = Math.max(100_000, Math.round(fragmentDurationMs * 1000));
  const expectedFragments = Math.max(
    1,
    Math.ceil((resolveDuration(scan, codec) || 0) / (fragmentDurationMs / 1000)),
  );

  const tmpPath = `${filePath}.frag-${process.pid}-${Date.now()}.m4a`;
  try {
    await run(config.ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', filePath,
      // Audio only: fragmented containers cannot carry an attached_pic stream, and this app
      // reads artwork from tracks.youtube_thumbnail instead of the file.
      '-map', '0:a:0',
      '-c', 'copy',
      // +faststart is deliberately absent: with +empty_moov the init header is already first,
      // and faststart would only add a rewrite pass over the whole file.
      '-movflags', '+empty_moov+default_base_moof',
      '-frag_duration', String(fragmentMicroseconds),
      tmpPath,
    ], { timeoutMs: config.normalizeTimeoutMs });

    const verifyScan = await scanMp4(tmpPath);
    if (!verifyScan.fragmented || verifyScan.fragments.length === 0) {
      throw new Error('remuxed file is not fragmented');
    }
    // Guards the unit mix-up above: an absurd fragment count would bloat mse_meta and make
    // range-based prefetch pointless.
    if (verifyScan.fragments.length > expectedFragments * 8) {
      throw new Error(
        `fragmented into ${verifyScan.fragments.length} pieces, expected about ${expectedFragments}`,
      );
    }

    const verifyCodec = await probeCodec(tmpPath);
    if (!verifyCodec.mime) throw new Error('remuxed file lost a usable audio codec');

    // A remux that silently drops or repeats audio is the failure mode worth catching here,
    // so compare lengths before replacing anything (ffprobe sums fragment durations).
    const expected = Number(track.duration) || resolveDuration(scan, codec);
    const actual = resolveDuration(verifyScan, verifyCodec);
    if (Number.isFinite(expected) && Number.isFinite(actual)) {
      const drift = Math.abs(actual - expected);
      if (drift > Math.max(1, expected * 0.01)) {
        throw new Error(`duration changed after remux: ${actual.toFixed(3)}s vs ${expected.toFixed(3)}s`);
      }
    }

    // Same directory, so this rename is atomic on any filesystem we support.
    await rename(tmpPath, filePath);

    const after = await stat(filePath);
    const meta = metaFromScan(verifyScan, verifyCodec, fingerprintOf(after));
    await persist(track, meta);

    logger.info(
      { trackId: track.id, fragments: meta.fragmentCount, durationSec: meta.durationSec },
      'Normalised track to fragmented MP4',
    );

    return { status: 'normalized', meta };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    logger.error({ trackId: track.id, error: error.message }, 'In-place normalisation failed');
    return { status: 'failed', reason: error.message };
  }
}

/**
 * Does the row already hold exactly the metadata this scan produced? The fingerprint is
 * size+mtime, so a replaced or re-downloaded file fails it, and a META_VERSION bump refreshes
 * every row once instead of leaving stale byte ranges in the manifest.
 */
function metaIsCurrent(track, meta) {
  if (!track?.mse_meta) return false;
  try {
    const stored = JSON.parse(track.mse_meta);
    return stored.version === META_VERSION
      && stored.fingerprint === meta.fingerprint
      && stored.fragmentCount === meta.fragmentCount;
  } catch {
    return false; // unreadable json — rewrite it
  }
}

async function persist(track, meta) {
  if (!track?.id) return;
  const { trackQueries } = await import('../db/database.js');
  trackQueries.update(track.id, { mse_meta: JSON.stringify(meta) });
}

/** Metadata for playback; normalises when the file changed or was never indexed. */
export async function getPlayMeta(track) {
  if (track.mse_meta) {
    try {
      const meta = JSON.parse(track.mse_meta);
      const stats = await stat(join(config.musicDir, track.filepath)).catch(() => null);
      const averageFragmentSec = meta?.fragmentCount ? (meta.durationSec || 0) / meta.fragmentCount : 0;
      const usable = meta?.version === META_VERSION
        && meta.fragments?.length > 0
        && averageFragmentSec >= MIN_FRAGMENT_SECONDS;

      if (usable && stats && meta.fingerprint === fingerprintOf(stats)) {
        return meta;
      }
    } catch {
      // fall through and rebuild
    }
  }

  const result = await normalizeTrack(track);
  if (result.meta) return result.meta;

  throw Object.assign(new Error(result.reason || 'track cannot be fragmented'), {
    code: result.status === 'skipped' ? 'UNSUPPORTED_FORMAT' : 'NORMALIZE_FAILED',
  });
}

/** Response body for GET /audio/:id/manifest. */
export function buildManifest(track, meta) {
  return {
    version: 1,
    trackId: track.id,
    url: `/audio/${track.id}`,
    mime: meta.mime,
    codec: meta.codec,
    durationSec: meta.durationSec ?? (Number(track.duration) || null),
    initEnd: meta.initEnd,
    fragmentCount: meta.fragmentCount,
    fragments: meta.fragments,
  };
}

/**
 * Normalise the whole library (startup path). Concurrency stays low: each conversion is a
 * full file rewrite, and the point is to not block playback while it runs.
 */
export async function normalizeLibrary({ apply = true, limit = 100_000, concurrency = 2, onTrack = null, ids = null } = {}) {
  const { trackQueries } = await import('../db/database.js');
  // `ids` narrows the run to the tracks someone named (the CLI's --track); null is the whole library.
  const tracks = ids
    ? ids.map((id) => trackQueries.getById(id)).filter(Boolean)
    : trackQueries.getAll(limit, 0, 'created_at', 'asc').filter(Boolean);
  const summary = { checked: 0, normalized: 0, metadata: 0, fragmented: 0, wouldNormalize: 0, skipped: 0, failed: 0, reasons: {} };
  const blame = (reason) => {
    const key = String(reason || 'unknown reason').slice(0, 160);
    summary.reasons[key] = (summary.reasons[key] || 0) + 1;
  };
  const queue = [...tracks];

  const report = (track, result, index, ms) => {
    if (!onTrack) return;
    try {
      onTrack({ track, result, index, total: tracks.length, ms });
    } catch {
      // A progress printer must never abort a conversion.
    }
  };

  async function worker() {
    while (queue.length > 0) {
      // Position in the queue, not `checked`: with two workers that counter races.
      const index = tracks.length - queue.length;
      const track = queue.shift();
      if (!track) continue;
      summary.checked += 1;
      const startedAt = Date.now();
      let result;
      try {
        result = await normalizeTrack(track, { apply });
      } catch (error) {
        logger.error({ trackId: track.id, error: error.message }, 'Normalisation threw');
        result = { status: 'failed', reason: error.message };
      }

      if (result.status === 'normalized') summary.normalized += 1;
      else if (result.status === 'metadata') summary.metadata += 1;
      else if (result.status === 'fragmented') summary.fragmented += 1;
      else if (result.status === 'would-normalize') summary.wouldNormalize += 1;
      else if (result.status === 'skipped' || result.status === 'missing') {
        summary.skipped += 1;
        blame(result.reason || 'file missing');
      } else {
        summary.failed += 1;
        blame(result.reason);
        logger.warn({ trackId: track.id, reason: result.reason }, 'Normalisation skipped/failed');
      }
      report(track, result, index, Date.now() - startedAt);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return summary;
}

export default { normalizeTrack, normalizeLibrary, getPlayMeta, buildManifest, planNormalization, probeCodec };
