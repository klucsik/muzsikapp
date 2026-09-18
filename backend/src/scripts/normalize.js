#!/usr/bin/env node
/**
 * Convert the existing library to fragmented MP4, in place — the same pass the server runs itself
 * on startup (`NORMALIZE_ON_STARTUP`, on by default). Reaching for a restart to discover that
 * ffmpeg is missing, or that the library is all MP3 and never will convert, is a poor way to find
 * out, so this prints per-reason counts the server only logs.
 *
 *   npm run normalize -- --dry-run        report what would change, touch nothing
 *   npm run normalize                    convert in place
 *   npm run normalize -- --limit 20       first 20 tracks by added date
 *   npm run normalize -- --concurrency 4  parallel ffmpeg runs (default 2)
 *
 * Exits 1 when any track failed, so a deploy script can stop on it.
 */
import config from '../config/config.js';
import { initDatabase, closeDatabase } from '../db/database.js';
import { normalizeLibrary } from '../services/formatNormalizer.js';

const argv = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};

const dryRun = argv.includes('--dry-run');
const unknown = argv.filter((arg) => arg.startsWith('--') && !['--dry-run'].includes(arg)
  && !['limit', 'concurrency'].includes(arg.replace(/^--/, '')));
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(', ')}`);
  process.exit(2);
}

await initDatabase();

console.log(`Normalising library in place=${!dryRun} ffmpeg=${config.ffmpegPath} ffprobe=${config.ffprobePath}`);
const startedAt = Date.now();
let summary;
try {
  summary = await normalizeLibrary({
    apply: !dryRun,
    limit: Number(valueOf('limit', 100_000)),
    concurrency: Number(valueOf('concurrency', 2)),
  });
} catch (error) {
  console.error(`Normalisation aborted: ${error.message}`);
  closeDatabase();
  process.exit(1);
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
const label = dryRun ? 'needs conversion' : 'converted';
console.log(`checked ${summary.checked} · ${label} ${dryRun ? summary.wouldNormalize : summary.normalized}`
  + ` · already fragmented ${summary.fragmented} · skipped ${summary.skipped} · failed ${summary.failed} (${seconds}s)`);

for (const [reason, count] of Object.entries(summary.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(count).padStart(5)} × ${reason}`);
}
if (/ENOENT|exited 127/.test(Object.keys(summary.reasons).join(' '))) {
  console.log('  → ffmpeg/ffprobe not runnable. Install both, or point FFMPEG_PATH / FFPROBE_PATH at them.');
}
if (summary.skipped && !Object.keys(summary.reasons).length) {
  console.log(`  → ${summary.skipped} track(s) left alone: only m4a containers are fragment-ready;`
    + ' everything else stays on the V1 player.');
}

closeDatabase();
process.exit(summary.failed > 0 ? 1 : 0);
