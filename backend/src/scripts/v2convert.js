#!/usr/bin/env node
/**
 * v2convert — get the library into the shape the V2 player needs, on purpose and in the foreground.
 *
 * The server deliberately converts nothing at startup — a container boot is not consent to rewrite
 * files — so this is the whole-library path: imports convert through the download queue, a track
 * someone plays converts through the manifest route, and this converts what nobody has played yet.
 * It is also how you find out why V2 is not engaging: a missing ffmpeg, or a library that is all
 * MP3, just looks like "V2 never started", because a track without `mse_meta` answers its manifest
 * with 415 and the UI falls back to V1 silently.
 *
 *   npm run v2convert -- --dry-run             what would change, nothing written
 *   npm run v2convert                          convert in place
 *   npm run v2convert -- --track 0f2b…c1       just that track (id, filename or stored path)
 *   npm run v2convert -- --limit 20            first 20 tracks by date added
 *   npm run v2convert -- --concurrency 4       parallel ffmpeg runs (default 2)
 *   npm run v2convert -- --all                 also list tracks that are already fragment-ready
 *   npm run v2convert -- --json                one machine-readable summary line, no track output
 *
 * `--transcode` is the destructive one: an mp3 (see TRANSCODE_FORMATS) is re-encoded to fragmented
 * AAC and the original file is deleted, so it never runs unless you type it, and never at startup.
 * Pair it with `--dry-run` and `--limit` before letting it near 1000 tracks.
 *
 * Run it from anywhere: the npm script cd's into `backend` so the server's own `.env`
 * (MUSIC_DIR, DATABASE_PATH, FFMPEG_PATH…) applies. Safe alongside a running server — a converted
 * file lands as an atomic rename in the same directory, temp names are per-PID, and rows are
 * written per track.
 *
 * Exit codes: 0 clean, 1 something failed, 2 bad usage.
 */
import { basename } from 'path';

// `--limit=20` and `--limit 20` mean the same thing; splitting here spares every reader below.
const argv = process.argv.slice(2).flatMap((arg) => {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  return eq === -1 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)];
});
const has = (name) => argv.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= argv.length || argv[i + 1].startsWith('--') ? fallback : argv[i + 1];
};
const valuesOf = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  }
  return out;
};

const KNOWN = ['dry-run', 'track', 'limit', 'concurrency', 'all', 'json', 'transcode', 'bitrate', 'help'];
const unknown = argv.filter((arg) => arg.startsWith('--') && !KNOWN.includes(arg.slice(2)));
const USAGE = 'usage: npm run v2convert -- [--dry-run] [--track <id|file>] [--limit N]'
  + ' [--concurrency N] [--transcode [--bitrate 192k]] [--all] [--json]';
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(', ')}\n${USAGE}`);
  process.exit(2);
}
if (has('help')) {
  console.log(USAGE);
  process.exit(0);
}
const selectors = valuesOf('track');
if (argv.includes('--track') && !selectors.length) {
  console.error(`--track needs a track id or filename\n${USAGE}`);
  process.exit(2);
}

const dryRun = has('dry-run');
const showAll = has('all');
const asJson = has('json');
const transcode = has('transcode');

// What each outcome is called, in this mode. The file being fragmented and the database row being
// ready are different facts, and only one of them is worth a whole library scan to discover.
const LABEL = {
  normalized: 'converted',
  'would-normalize': dryRun ? 'needs conversion' : 'converted',
  transcoded: 'transcoded',
  'would-transcode': dryRun ? 'needs transcode' : 'transcoded',
  metadata: dryRun ? 'needs metadata' : 'metadata refreshed',
  fragmented: 'fragment-ready',
  skipped: 'skipped',
  missing: 'file missing',
  failed: 'FAILED',
};

// A human runs this by hand, so the server's own per-track pino output stays out of the way;
// import after that decision, which is also why nothing above needs the database.
process.env.LOG_LEVEL ||= 'error';
const { default: config } = await import('../config/config.js');
const { initDatabase, closeDatabase, trackQueries } = await import('../db/database.js');
const { normalizeLibrary } = await import('../services/formatNormalizer.js');

const bitrate = valueOf('bitrate', config.transcodeBitrate);

await initDatabase();

// `--track` accepts what a human can see: the id, the filename, or the stored relative path.
function resolveTracks(names) {
  const ids = [];
  const missing = [];
  for (const name of names) {
    const track = trackQueries.getById(name)
      || trackQueries.getByFilepath(name)
      || trackQueries.getByFilepath(basename(name));
    if (track) ids.push(track.id);
    else missing.push(name);
  }
  return { ids, missing };
}

let ids = null;
if (selectors.length) {
  const { ids: found, missing } = resolveTracks(selectors);
  if (missing.length) {
    console.error(`No track by ${missing.map((m) => `"${m}"`).join(', ')}`);
    console.error('Ids come from the library: sqlite3 <db> "select id, filename from tracks"');
    closeDatabase();
    process.exit(2);
  }
  ids = found;
}

// The per-track line needs a denominator, and `--limit` may make it smaller than the library.
const total = ids ? ids.length : Math.min(
  Number(valueOf('limit', 100_000)),
  trackQueries.getAll(100_000, 0, 'created_at', 'asc').filter(Boolean).length,
);

if (!asJson) {
  console.log(`V2 conversion${dryRun ? ' (dry run — nothing will be written)' : ''}`);
  console.log(`  music  ${config.musicDir}`);
  console.log(`  db     ${config.databasePath}`);
  console.log(`  ffmpeg ${config.ffmpegPath} · ffprobe ${config.ffprobePath}`);
  if (transcode) console.log(`  output AAC at ${bitrate} · sources in ${config.transcodeFormats.join(', ')} are replaced`);
}

if (transcode && !dryRun && !asJson) {
  console.log('\n  ⚠ --transcode re-encodes and DELETES the source: song.mp3 becomes song.m4a.');
  console.log('    Lossy in, lossy out, no way back — pilot with --limit 5 first.');
}

const seenReasons = new Set();
const printer = ({ track, result, index, ms }) => {
  if (asJson) return;
  if (result.status === 'fragmented' && !showAll) return;
  seenReasons.add(result.reason);
  const showReason = result.reason && (result.status !== 'fragmented' || showAll);
  const name = track.filename || track.title || track.id;
  console.log(`  [${String(index + 1).padStart(String(total).length)}/${total}] `
    + `${LABEL[result.status] || result.status}  ${name}`
    + `${showReason ? `  → ${result.reason}` : ''}${ms > 900 ? ` (${(ms / 1000).toFixed(1)}s)` : ''}`);
};

const startedAt = Date.now();
let summary;
try {
  summary = await normalizeLibrary({
    apply: !dryRun,
    limit: Number(valueOf('limit', 100_000)),
    concurrency: Number(valueOf('concurrency', 2)),
    onTrack: printer,
    ids,
    transcode,
    bitrate,
  });
} catch (error) {
  if (asJson) console.log(JSON.stringify({ error: error.message }));
  else console.error(`Conversion aborted: ${error.message}`);
  closeDatabase();
  process.exit(1);
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
// A quiet run is a machine's run: hand back the numbers and nothing else.
if (asJson) {
  console.log(JSON.stringify({
    dryRun,
    musicDir: config.musicDir,
    databasePath: config.databasePath,
    seconds: Number(seconds),
    ...summary,
  }));
  closeDatabase();
  process.exit(summary.failed > 0 ? 1 : 0);
}

const humanBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const pending = (dryRun ? summary.wouldNormalize + summary.wouldTranscode : summary.normalized + summary.transcoded)
  + summary.metadata;
const parts = [`checked ${summary.checked}`];
if (summary.normalized) parts.push(`converted ${summary.normalized}`);
if (summary.transcoded) parts.push(`transcoded ${summary.transcoded}`);
if (dryRun && summary.wouldNormalize) parts.push(`needs conversion ${summary.wouldNormalize}`);
if (dryRun && summary.wouldTranscode) parts.push(`needs transcode ${summary.wouldTranscode}`);
if (summary.metadata) {
  parts.push(dryRun ? `needs metadata ${summary.metadata}` : `metadata refreshed ${summary.metadata}`);
}
if (summary.fragmented) parts.push(`already fragment-ready ${summary.fragmented}`);
if (summary.skipped) parts.push(`skipped ${summary.skipped}`);
parts.push(`failed ${summary.failed} (${seconds}s)`);
console.log(`\n${parts.join(' · ')}`);

for (const [reason, count] of Object.entries(summary.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(count).padStart(5)} × ${reason}`);
}
if (/ENOENT|exited 127/.test(Object.keys(summary.reasons).join(' '))) {
  console.log('\n  → ffmpeg/ffprobe not runnable. Install both, or point FFMPEG_PATH / FFPROBE_PATH at them.');
}
if (summary.failed > 0 && !dryRun) {
  console.log('  → failed tracks stay on the V1 player; nothing was written for them.');
}
if (summary.transcoded) {
  console.log(summary.bytesFreed >= 0
    ? `  → re-encoding freed ${humanBytes(summary.bytesFreed)} across ${summary.transcoded} track(s).`
    : `  → re-encoding added ${humanBytes(-summary.bytesFreed)} across ${summary.transcoded} track(s).`);
}
if (dryRun && pending > 0) {
  const what = transcode ? 'rewrite + transcode + metadata' : 'file rewrite + metadata';
  console.log(`\n  npm run v2convert${transcode ? ' -- --transcode' : ''}   # apply those ${pending} (${what})`);
}
if (!dryRun && summary.metadata) {
  console.log(`  → refreshed the metadata of ${summary.metadata} track(s) whose file was already fragmented.`);
}

closeDatabase();
process.exit(summary.failed > 0 ? 1 : 0);
