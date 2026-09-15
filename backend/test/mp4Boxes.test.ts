import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanMp4, listTopBoxes } from '../src/utils/mp4Boxes.js';

/**
 * These tests exercise real container layout: a hand-written fake MP4 would not prove the
 * box walking agrees with what ffmpeg actually emits.
 */

let dir;
let progressivePath;
let fragmentedPath;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mp4boxes-'));
  progressivePath = join(dir, 'progressive.m4a');
  fragmentedPath = join(dir, 'fragmented.m4a');

  // 5 s of sine is enough to produce several fragments at 1 s granularity.
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5', '-c:a', 'aac', progressivePath]);
  ffmpeg([
    '-i', progressivePath,
    '-map', '0:a:0',
    '-c', 'copy',
    '-movflags', '+empty_moov+default_base_moof+faststart',
    '-frag_duration', '1000000',
    fragmentedPath,
  ]);
}, 60_000);

describe('scanMp4 — progressive containers', () => {
  it('reports a non-fragmented file as unusable for MSE', async () => {
    const scan = await scanMp4(progressivePath);
    expect(scan.fragmented).toBe(false);
    expect(scan.initEnd).toBeNull();
    expect(scan.fragments).toEqual([]);
  });

  it('still reads duration and timescale from moov/mvhd', async () => {
    const scan = await scanMp4(progressivePath);
    expect(scan.timescale).toBe(44100);
    expect(scan.durationSec).toBeCloseTo(5, 0);
  });

  it('tolerates a file that is not MP4 at all', async () => {
    const junk = join(dir, 'junk.m4a');
    writeFileSync(junk, Buffer.from('not an mp4 file, honestly'));
    const scan = await scanMp4(junk);
    expect(scan.fragmented).toBe(false);
    expect(scan.fragments).toEqual([]);
  });

  it('tolerates an empty file', async () => {
    const empty = join(dir, 'empty.m4a');
    writeFileSync(empty, Buffer.alloc(0));
    const scan = await scanMp4(empty);
    expect(scan.fragmented).toBe(false);
    expect(scan.fileSize).toBe(0);
  });
});

describe('scanMp4 — fragmented containers', () => {
  it('finds the init segment and every fragment', async () => {
    const scan = await scanMp4(fragmentedPath);
    expect(scan.fragmented).toBe(true);
    expect(scan.initEnd).toBeGreaterThan(0);
    expect(scan.fragments.length).toBeGreaterThanOrEqual(3);

    const types = (await listTopBoxes(fragmentedPath)).boxes.map((b) => b.type);
    expect(types.slice(0, 2)).toEqual(['ftyp', 'moov']);
    expect(types).toContain('moof');
  });

  it('produces contiguous ranges covering the whole media data section', async () => {
    const scan = await scanMp4(fragmentedPath);
    const first = scan.fragments[0];
    expect(first.offset).toBe(scan.initEnd); // init bytes come first, nothing in between

    let expectedOffset = first.offset;
    for (const fragment of scan.fragments) {
      expect(fragment.offset).toBe(expectedOffset);
      expect(fragment.size).toBeGreaterThan(0);
      expectedOffset += fragment.size;
    }
    expect(expectedOffset).toBe(scan.fileSize); // no bytes unaccounted for
  });

  it('orders fragments by media time using the media timescale', async () => {
    const scan = await scanMp4(fragmentedPath);
    const starts = scan.fragments.map((f) => f.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts[0]).toBe(0);

    // 1 s fragments: if the movie timescale were used instead of mdhd's, these would be
    // off by an order of magnitude rather than failing outright.
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThan(0.5);
      expect(starts[i] - starts[i - 1]).toBeLessThan(2);
    }
  });

  it('leaves duration unknown for fragmented containers (they do not declare one)', async () => {
    const scan = await scanMp4(fragmentedPath);
    expect(scan.durationSec).toBeNull();
    // The last fragment has no successor to measure against either.
    expect(scan.fragments[scan.fragments.length - 1].end).toBeNull();
    // …so callers must get the length from ffprobe, which this project does in formatNormalizer.
  });
});
