import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Segmenter tests need a real ffmpeg + real audio, so fixtures are generated on the fly.
 * Env vars are set before importing config (config snapshots process.env at import time).
 */

let workspace;
let segmenter;
let musicDir;
let segmentsDir;
let sourcePath;
let shortSourcePath;
const SEG = 10;
const DURATION = 65;

function haveFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeM4a(dest, seconds) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:a', 'aac', '-b:a', '64k', dest,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

beforeAll(async () => {
  if (!haveFfmpeg()) throw new Error('ffmpeg not available — cannot run segmenter tests');

  workspace = await mkdtemp(join(tmpdir(), 'segmenter-'));
  musicDir = join(workspace, 'music');
  segmentsDir = join(workspace, 'segments');
  await mkdir(musicDir, { recursive: true });

  sourcePath = join(musicDir, 'long.m4a');
  shortSourcePath = join(workspace, 'short-src.m4a');
  makeM4a(sourcePath, DURATION);
  makeM4a(shortSourcePath, 21);

  process.env.MUSIC_DIR = musicDir;
  process.env.SEGMENTS_DIR = segmentsDir;
  process.env.SEGMENT_DURATION = String(SEG);
  process.env.FFMPEG_PATH = 'ffmpeg';

  segmenter = await import('../src/services/segmenter.js');
});

// Real scanner output stores the ffprobe container, not an extension.
const trackFixture = { id: 42, filepath: 'long.m4a', format: 'M4A/isom/iso2', duration: DURATION };

describe('planSegments', () => {
  it('accepts m4a with a fragmented-mp4 plan and an MSE-ready mime', () => {
    const plan = segmenter.planSegments('m4a');
    expect(plan.supported).toBe(true);
    expect(plan.container).toBe('fmp4');
    // The frontend feeds this straight into MediaSource.isTypeSupported()
    expect(plan.mime).toContain('audio/mp4');
    expect(plan.mime).toContain('mp4a.40.2');
  });

  it('rejects formats we have not verified in browsers, with a V1 fallback hint', () => {
    for (const format of ['mp3', 'flac', 'ogg', 'opus', 'wav', '', undefined]) {
      const plan = segmenter.planSegments(format);
      expect(plan.supported).toBe(false);
      expect(plan.reason).toContain('V1');
    }
  });

  it('normalizes dotted, upper-case and ffprobe container strings', () => {
    expect(segmenter.planSegments('.M4A').supported).toBe(true);
    expect(segmenter.planSegments('m4a').format).toBe('.m4a');

    // what actually lands in tracks.format today
    expect(segmenter.planSegments('M4A/isom/iso2').supported).toBe(true);
    expect(segmenter.planSegments({ format: 'ipod/mp42/iso2', filepath: '/x/y/z.m4a' }).supported).toBe(true);

    // container string unhelpful -> fall back to the file extension
    const byExtension = segmenter.planSegments({ format: '', filepath: 'a/b/song.M4A' });
    expect(byExtension.supported).toBe(true);
  });
});

describe('getManifest', () => {
  it('produces an init segment plus contiguous segments covering the track', async () => {
    const manifest = await segmenter.getManifest(trackFixture);

    expect(manifest.initFile).toBe('init.mp4');
    expect(existsSync(join(segmenter.segmentDirFor(trackFixture.id), 'init.mp4'))).toBe(true);

    // 65s at 10s segments -> 6 full + 1 tail (ffmpeg may snap to frame boundaries)
    expect(manifest.segments.length).toBeGreaterThanOrEqual(6);
    expect(manifest.segments.length).toBeLessThanOrEqual(8);

    manifest.segments.forEach((segment, index) => {
      expect(segment.index).toBe(index);
      expect(segment.file).toMatch(/\.m4s$/);
    });

    // Contiguous timeline: each segment starts where the previous one ended.
    for (let i = 1; i < manifest.segments.length; i += 1) {
      const prev = manifest.segments[i - 1];
      expect(Math.abs(manifest.segments[i].start - prev.end)).toBeLessThan(0.002);
    }

    // No gaps and no dropped audio at the end.
    expect(manifest.segments[0].start).toBe(0);
    const covered = manifest.segments[manifest.segments.length - 1].end;
    expect(Math.abs(covered - DURATION)).toBeLessThan(SEG);
  });

  it('writes real fragmented data, not empty placeholders', async () => {
    // listSegmentFiles also returns init.mp4 (~700 B of codec config), which is not media.
    const files = (await segmenter.listSegmentFiles(trackFixture.id)).filter((f) => f.endsWith('.m4s'));
    const sizes = await Promise.all(files.map(async (file) => (await stat(join(segmenter.segmentDirFor(42), file))).size));
    expect(files.length).toBeGreaterThan(1);
    sizes.forEach((bytes) => expect(bytes).toBeGreaterThan(10_000));

    // init segment must carry the codec description the decoder needs
    const init = await readFile(join(segmenter.segmentDirFor(42), 'init.mp4'));
    expect(init.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(init.includes(Buffer.from('moov'))).toBe(true);

    // ...and each media segment must be self-describing (moof) — that is the whole point
    const { path } = await segmenter.getSegmentFile(42, 1);
    const seg = await readFile(path);
    expect(seg.includes(Buffer.from('moof'))).toBe(true);
    expect(seg.includes(Buffer.from('mdat'))).toBe(true);
  });

  it('serves the init segment and rejects out-of-range indexes', async () => {
    const initFile = await segmenter.getInitFile(42);
    expect(existsSync(initFile.path)).toBe(true);

    await expect(segmenter.getSegmentFile(42, 999)).rejects.toMatchObject({ code: 'SEGMENT_OUT_OF_RANGE' });
    await expect(segmenter.getSegmentFile(123456, 0)).rejects.toMatchObject({ code: 'NOT_SEGMENTED' });
  });

  it('reuses cached segments on the next call instead of re-running ffmpeg', async () => {
    const first = await segmenter.getManifest(trackFixture);
    const second = await segmenter.getManifest(trackFixture);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.segments.length).toBe(first.segments.length);
  });

  it('collapses concurrent requests for the same track into one conversion', async () => {
    const freshTrack = { id: 77, filepath: 'concurrent.m4a', format: 'm4a', duration: 21 };
    await copyFile(shortSourcePath, join(musicDir, 'concurrent.m4a'));

    const [a, b] = await Promise.all([
      segmenter.getManifest(freshTrack),
      segmenter.getManifest(freshTrack),
    ]);
    expect(a.createdAt).toBe(b.createdAt);
  });

  it('accepts a track whose format is stored as an ffprobe container string', async () => {
    const manifest = await segmenter.getManifest(trackFixture);
    expect(manifest.container).toBe('fmp4');
    expect(manifest.mime).toContain('audio/mp4');
  });

  it('re-segments when the underlying file changes', async () => {
    const before = await segmenter.getManifest(trackFixture);

    // Simulate a re-download: same path, different bytes.
    await copyFile(shortSourcePath, sourcePath);

    const after = await segmenter.getManifest({ ...trackFixture, duration: 21 });
    expect(after.createdAt).not.toBe(before.createdAt);
    expect(after.segments.length).toBeLessThan(before.segments.length);

    // leave a valid long file behind for any later assertions
    makeM4a(sourcePath, DURATION);
  });

  it('fails cleanly on unsupported formats and missing files', async () => {
    await expect(segmenter.getManifest({ id: 1, filepath: 'x.mp3', format: 'mp3' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });

    await expect(segmenter.getManifest({ id: 2, filepath: 'gone.m4a', format: 'm4a' }))
      .rejects.toMatchObject({ code: 'SOURCE_MISSING' });
  });

  it('cleans up partial output when conversion fails', async () => {
    const badTrack = { id: 99, filepath: 'broken.m4a', format: 'm4a', duration: 3 };
    await writeFile(join(musicDir, 'broken.m4a'), 'not an mp4 file at all');

    await expect(segmenter.getManifest(badTrack)).rejects.toThrow();

    const leftovers = existsSync(segmenter.segmentDirFor(99))
      || (await readdirSafe(segmentsDir)).some((name) => name.includes('99.tmp-'));
    expect(leftovers).toBe(false);
  });
});

async function readdirSafe(dir) {
  const { readdir } = await import('fs/promises');
  return readdir(dir).catch(() => []);
}
