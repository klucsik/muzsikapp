import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * In-place normalisation rewrites library files, so these tests run against a throwaway
 * music directory and database. Ordering matters: config captures DATABASE_PATH at import.
 */

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'normalize-db-')), 'test.db');

const { default: config } = await import('../src/config/config.js');
const { initDatabase, closeDatabase, trackQueries } = await import('../src/db/database.js');
const { normalizeTrack, getPlayMeta, buildManifest, planNormalization, probeCodec } =
  await import('../src/services/formatNormalizer.js');
const { scanMp4 } = await import('../src/utils/mp4Boxes.js');

let dir;
let musicDir;
let sourcePath;
let dbReady;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function trackFor(name, overrides = {}) {
  const filePath = join(musicDir, name);
  const stats = statSync(filePath);
  const id = `track-${name.replace(/\W/g, '-')}`;
  trackQueries.insert({
    id,
    title: name,
    artist: 'Test',
    album: null,
    duration: 5,
    filename: name,
    filepath: name, // stored relative to musicDir, like the real scanner does
    bitrate: null,
    file_size: stats.size,
    format: 'M4A/isom/iso2',
    sample_rate: 44100,
    youtube_url: null,
    youtube_video_id: null,
    youtube_thumbnail: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  });
  return { id, filepath: name, duration: 5, format: 'M4A/isom/iso2' };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'normalize-'));
  musicDir = join(dir, 'music');
  mkdirSync(musicDir, { recursive: true });
  config.musicDir = musicDir;
  // Short fragments keep the fixture files interesting (5 s of audio ⇒ several fragments).
  config.fragmentDurationMs = 1000;

  // Must be awaited: trackQueries would otherwise race the migrations.
  dbReady = Promise.resolve(initDatabase());
  await dbReady;

  sourcePath = join(dir, 'prog-source.m4a');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5', '-c:a', 'aac', sourcePath]);

  // A non-AAC track in an MP4 container: fragmentable, but no MSE media type we can promise.
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-c:a', 'alac', join(musicDir, 'alac.m4a')]);
}, 90_000);

afterAll(async () => {
  await dbReady;
  await closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

/** Reset both the file and its DB row (tracks.filepath is unique). */
function freshTrack(name = 'prog.m4a', source = sourcePath) {
  const existing = trackQueries.getByFilepath(name);
  if (existing) trackQueries.delete(existing.id);

  copyFileSync(source, join(musicDir, name));
  return trackFor(name);
}

describe('planNormalization', () => {
  it('only fragments m4a containers', () => {
    expect(planNormalization({ format: 'M4A/isom/iso2' }).supported).toBe(true);
    expect(planNormalization({ format: 'MP3 (MPEG audio layer 3)' }).supported).toBe(false);
    expect(planNormalization({ format: null, filepath: 'song.flac' }).supported).toBe(false);
  });

  it('tells the client to use the V1 player for unsupported formats', () => {
    const plan = planNormalization({ format: 'MP3 (MPEG audio layer 3)' });
    expect(plan.reason).toMatch(/V1/);
  });
});

describe('probeCodec', () => {
  it('maps AAC to a media type with the right object type', async () => {
    const codec = await probeCodec(sourcePath);
    expect(codec.codecName).toBe('aac');
    expect(codec.mime).toMatch(/^audio\/mp4; codecs="mp4a\.40\.\d+"$/);
  });

  it('refuses to guess a media type for other codecs', async () => {
    const codec = await probeCodec(join(musicDir, 'alac.m4a'));
    expect(codec.mime).toBeNull();
    expect(codec.codecName).toBe('alac');
  });
});

describe('normalizeTrack', () => {
  beforeEach(() => {
    config.normalizeTimeoutMs = 120_000;
  });

  it('reports what it would do without touching the file when apply is false', async () => {
    const track = freshTrack();
    const before = statSync(join(musicDir, 'prog.m4a'));

    const result = await normalizeTrack(track, { apply: false });
    expect(result.status).toBe('would-normalize');
    expect(statSync(join(musicDir, 'prog.m4a'))).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
  });

  it('fragments in place and indexes the result', async () => {
    const track = freshTrack();
    const originalSize = statSync(join(musicDir, 'prog.m4a')).size;

    const result = await normalizeTrack(track);
    expect(result.status).toBe('normalized');

    const scan = await scanMp4(join(musicDir, 'prog.m4a'));
    expect(scan.fragmented).toBe(true);
    expect(scan.fragments.length).toBeGreaterThanOrEqual(3);

    // ffmpeg reads -frag_duration in microseconds. Passing milliseconds gives one fragment per
    // AAC frame, so assert the pieces are actually the length we asked for (1 s here).
    const starts = scan.fragments.map((fragment) => fragment.start);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThan(0.5);
      expect(starts[i] - starts[i - 1]).toBeLessThan(2);
    }

    const stored = JSON.parse(trackQueries.getById(track.id).mse_meta);
    // Fragmented containers carry no length, so the index must have probed one.
    expect(stored.durationSec).toBeCloseTo(5, 1);
    expect(stored.fragments.at(-1).end).toBeCloseTo(5, 1);
    expect(stored.fragmentCount).toBe(scan.fragments.length);
    expect(stored.mime).toMatch(/mp4a\.40\.\d+/);
    expect(stored.initEnd).toBeGreaterThan(0);
    expect(stored.fileSize).not.toBe(originalSize); // container really changed

    const leftovers = readdirSync(musicDir).filter((name) => name.includes('.frag-'));
    expect(leftovers).toEqual([]);
  });

  it('is idempotent — a fragmented file is indexed, not rewritten', async () => {
    const track = freshTrack();
    await normalizeTrack(track);

    const before = statSync(join(musicDir, 'prog.m4a'));
    const second = await normalizeTrack(trackQueries.getById(track.id));

    expect(second.status).toBe('fragmented');
    const after = statSync(join(musicDir, 'prog.m4a'));
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('repairs a row whose file is fragmented and whose metadata is gone', async () => {
    const track = freshTrack();
    await normalizeTrack(track);

    // A rebuilt database, or a file copied into the library by hand: the container is already in
    // shape and the row knows nothing about it. Rewriting the file would be waste; writing the row
    // is real work, so it gets a status of its own instead of hiding inside "fragmented".
    trackQueries.update(track.id, { mse_meta: null });
    const result = await normalizeTrack(trackQueries.getById(track.id));

    expect(result.status).toBe('metadata');
    expect(result.reason).toBe('no stored metadata');
    expect(JSON.parse(trackQueries.getById(track.id).mse_meta).fragmentCount)
      .toBe(result.meta.fragmentCount);

    // A dry run reports the same thing and still writes nothing.
    trackQueries.update(track.id, { mse_meta: null });
    const dry = await normalizeTrack(trackQueries.getById(track.id), { apply: false });

    expect(dry.status).toBe('metadata');
    expect(trackQueries.getById(track.id).mse_meta).toBeNull();
  });

  it('leaves the original file alone when ffmpeg fails', async () => {
    const track = freshTrack();
    const before = statSync(join(musicDir, 'prog.m4a'));
    config.normalizeTimeoutMs = 1; // guaranteed to kill the remux

    const result = await normalizeTrack(track);
    expect(result.status).toBe('failed');

    const after = statSync(join(musicDir, 'prog.m4a'));
    expect(after.size).toBe(before.size);
    expect((await scanMp4(join(musicDir, 'prog.m4a'))).fragmented).toBe(false);
    expect(readdirSync(musicDir).filter((name) => name.includes('.frag-'))).toEqual([]);
  });

  it('skips tracks whose audio codec has no verified media type', async () => {
    const track = trackFor('alac.m4a');
    const result = await normalizeTrack(track);
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/codec/);
  });

  it('reports a missing file instead of throwing', async () => {
    const result = await normalizeTrack({ id: 'ghost', filepath: 'nope.m4a', format: 'M4A/isom/iso2' });
    expect(result.status).toBe('missing');
  });
});

describe('getPlayMeta / buildManifest', () => {
  it('reuses stored metadata while the file is unchanged', async () => {
    const track = freshTrack();
    await normalizeTrack(track);

    const first = await getPlayMeta(trackQueries.getById(track.id));
    const mtimeAfterFirst = statSync(join(musicDir, 'prog.m4a')).mtimeMs;
    const second = await getPlayMeta(trackQueries.getById(track.id));

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(statSync(join(musicDir, 'prog.m4a')).mtimeMs).toBe(mtimeAfterFirst);
  });

  it('rebuilds when the stored fingerprint is stale', async () => {
    const track = freshTrack();
    await normalizeTrack(track);
    trackQueries.update(track.id, { mse_meta: JSON.stringify({ version: 1, fingerprint: '0-0', fragments: [] }) });

    const meta = await getPlayMeta(trackQueries.getById(track.id));
    expect(meta.fragments.length).toBeGreaterThan(0);
  });

  it('rejects formats that cannot be fragmented', async () => {
    await expect(getPlayMeta({ id: 'x', filepath: 'a.mp3', format: 'MP3 (MPEG audio layer 3)' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('describes byte ranges the client can fetch directly', async () => {
    const track = freshTrack();
    await normalizeTrack(track);

    const stored = trackQueries.getById(track.id);
    const manifest = buildManifest(stored, JSON.parse(stored.mse_meta));
    expect(manifest.url).toBe(`/audio/${track.id}`);
    expect(manifest.durationSec).toBeCloseTo(5, 1);
    expect(manifest.initEnd).toBeGreaterThan(0);
    expect(manifest.fragments[0]).toMatchObject({ index: 0, offset: manifest.initEnd });
    expect(manifest.fragmentCount).toBe(manifest.fragments.length);

    // ranges must be contiguous so a Range request never returns a partial fragment
    for (let i = 1; i < manifest.fragments.length; i += 1) {
      const prev = manifest.fragments[i - 1];
      expect(manifest.fragments[i].offset).toBe(prev.offset + prev.size);
    }
  });

  it('leaves no sidecar files in the library directory', async () => {
    const track = freshTrack();
    await normalizeTrack(trackQueries.getById(track.id));

    // One file per track: normalisation rewrites in place, so there are no segment dirs,
    // manifests or temp files lying around next to the audio.
    expect(readdirSync(musicDir).filter((name) => !name.endsWith('.m4a'))).toEqual([]);
  });
});
