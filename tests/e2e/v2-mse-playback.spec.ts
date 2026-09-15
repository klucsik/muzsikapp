import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * Verifies the part unit tests cannot: can a real browser decode what our byte-range
 * fragment index produces?
 *
 * A throwaway library and database are pointed at copies of real audio, so this also drives
 * startup normalisation end to end. The harness runs against the API origin itself (any JSON
 * endpoint is a fine same-origin document) because the subject is MediaSource behaviour plus
 * range requests — component-level coverage lives in the other specs.
 */

const PORT = Number(process.env.E2E_AUDIO_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;
// Any real library works; default to this machine's, which is what the backend uses too.
const SOURCE_LIBRARY = process.env.E2E_MUSIC_SOURCE || process.env.MUSIC_DIR || '/workspace/music';

let serverProcess = null;
let tempDir = null;
let trackId = null;

function sourceFile() {
  if (process.env.E2E_TRACK) return join(SOURCE_LIBRARY, process.env.E2E_TRACK);
  const candidates = existsSync(SOURCE_LIBRARY)
    ? readdirSync(SOURCE_LIBRARY).filter((name) => /\.(m4a|mp4)$/i.test(name))
    : [];
  if (!candidates.length) throw new Error(`No .m4a fixture found in ${SOURCE_LIBRARY}`);
  return join(SOURCE_LIBRARY, candidates[0]);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(400);
  }
  throw new Error('Backend did not become healthy in time');
}

async function findTrackId() {
  const body = await (await fetch(`${BASE}/api/tracks?limit=200`)).json();
  const tracks = Array.isArray(body) ? body : body.tracks || [];
  const playable = tracks.find((track) => /\.(m4a|mp4)$/i.test(track.filepath || ''));
  if (!playable) throw new Error(`Scanner found no m4a track: ${JSON.stringify(tracks).slice(0, 300)}`);
  return playable.id;
}

/** Polls until startup normalisation has produced a fragment index (or times out). */
async function waitForManifest(id, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE}/audio/${id}/manifest`);
    last = { status: response.status, body: await response.json().catch(() => null) };
    if (response.ok && last.body?.fragments?.length) return last.body;
    await sleep(500);
  }
  throw new Error(`No manifest for ${id}: ${JSON.stringify(last)}`);
}

/**
 * Runs in the page. Plain JavaScript only: Playwright stringifies this callback, so the file's
 * TypeScript syntax would reach the browser untranspiled.
 */
async function playWithManifest(page, id) {
  return page.evaluate(async (trackIdToPlay) => {
    const report = { steps: [] };
    const step = (name, value) => { report.steps.push([name, value]); };
    // Which await was in flight when something threw — otherwise the message alone is useless.
    const stage = (name) => { report.stage = name; step(name); return name; };

    try {
      const manifestResponse = await fetch(`/audio/${trackIdToPlay}/manifest`);
      const manifest = await manifestResponse.json();
      report.manifest = {
        status: manifestResponse.status,
        mime: manifest.mime,
        url: manifest.url,
        fragmentCount: (manifest.fragments || []).length,
        durationSec: manifest.durationSec,
        initEnd: manifest.initEnd,
      };
      if (!manifestResponse.ok) throw new Error(`manifest ${manifestResponse.status}: ${JSON.stringify(manifest)}`);

      report.typeSupported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(manifest.mime);
      if (!report.typeSupported) return report;

      // Anything that can stall gets a label, otherwise a hang is indistinguishable from a
      // slow machine when the only signal is "test timeout".
      const timed = (label, promise) => Promise.race([
        promise,
        new Promise((resolveNever, rejectNever) => {
          setTimeout(() => rejectNever(new Error(`timed out waiting for ${label}`)), 10000);
        }),
      ]);

      const audio = document.createElement('audio');
      audio.setAttribute('playsinline', '');
      document.body.appendChild(audio);

      const mediaSource = new MediaSource();
      report.mediaSourceEvents = [];
      ['sourceopen', 'sourceending', 'ended', 'closed', 'endstream'].forEach((name) => {
        mediaSource.addEventListener(name, () => step(`ms:${name}`, mediaSource.readyState));
      });
      audio.src = URL.createObjectURL(mediaSource);
      await timed('sourceopen', new Promise((resolveOpen) => mediaSource.addEventListener('sourceopen', resolveOpen, { once: true })));
      mediaSource.addEventListener('end', () => step('ms-end'));
      mediaSource.addEventListener('ended', () => step('audio-ended'));
      const noteAudioError = () => { report.audioErrorCode = audio.error ? audio.error.code : null; step('audio-error', report.audioErrorCode); };
      audio.addEventListener('error', noteAudioError);
      audio.addEventListener('stalled', () => step('stalled'));
      if (manifest.durationSec) mediaSource.duration = manifest.durationSec;

      const sourceBuffer = mediaSource.addSourceBuffer(manifest.mime);
      step('mode', sourceBuffer.mode);
      sourceBuffer.addEventListener('error', () => {
        report.sourceBufferErrored = true;
        step('sb-error', mediaSource.readyState);
      });
      audio.addEventListener('canplay', () => step('canplay', Number(audio.currentTime.toFixed(2))));

      const grab = async (start, end) => {
        const response = await fetch(manifest.url, { headers: { Range: `bytes=${start}-${end}` } });
        if (response.status !== 206) throw new Error(`range ${start}-${end} → ${response.status}`);
        return response.arrayBuffer();
      };

      const append = (buffer) => new Promise((resolveAppend, rejectAppend) => {
        if (mediaSource.readyState !== 'open') {
          rejectAppend(new Error(`MediaSource is ${mediaSource.readyState}, cannot append`));
          return;
        }
        const onError = () => rejectAppend(new Error(`SourceBuffer error during append (readyState=${mediaSource.readyState})`));
        sourceBuffer.addEventListener('error', onError, { once: true });
        sourceBuffer.addEventListener('updateend', () => {
          sourceBuffer.removeEventListener('error', onError);
          resolveAppend();
        }, { once: true });
        sourceBuffer.appendBuffer(buffer);
      });

      // init segment, then the first three fragments in decode order
      const initSegment = await grab(0, manifest.initEnd - 1);
      report.initBytes = initSegment.byteLength;
      report.initBox = new TextDecoder('latin1').decode(new Uint8Array(initSegment, 4, 8));
      await timed(stage('append init'), append(initSegment));

      for (const index of [0, 1, 2]) {
        const fragment = manifest.fragments[index];
        if (!fragment) continue;
        const buffer = await grab(fragment.offset, fragment.offset + fragment.size - 1);
        if (index === 0) {
          report.firstFragmentBox = new TextDecoder('latin1').decode(new Uint8Array(buffer, 4, 8));
        }
        await timed(stage(`append fragment ${index}`), append(buffer));
        step(`appended-${index}`, Math.round(fragment.size));
      }

      report.bufferedAfterAppend = audio.buffered.length
        ? { start: audio.buffered.start(0), end: audio.buffered.end(audio.buffered.length - 1) }
        : null;
      report.durationAfterAppend = audio.duration;

      report.readyStateBeforePlay = mediaSource.readyState;
      await timed(stage('play()'), audio.play());
      const startedAt = audio.currentTime;
      await sleepInPage(1600);
      report.advancedSeconds = audio.currentTime - startedAt;
      report.pausedDuringPlayback = audio.paused;

      // Random access: append a later fragment, then jump to where its own timestamps place it.
      const targetIndex = Math.min(3, manifest.fragments.length - 1);
      // Once the element has failed to decode, appends throw and there is nothing to measure.
      if (targetIndex >= 0 && report.audioErrorCode === undefined) {
        const target = manifest.fragments[targetIndex];
        report.target = { index: targetIndex, start: target.start };
        await timed(stage('append seek target'), append(await grab(target.offset, target.offset + target.size - 1)));

        audio.currentTime = target.start + 0.2;
        await sleepInPage(400);
        report.afterSeekCurrentTime = audio.currentTime;
        report.afterSeekBuffered = Array.from({ length: audio.buffered.length }, (_, i) => [
          Number(audio.buffered.start(i).toFixed(2)),
          Number(audio.buffered.end(i).toFixed(2)),
        ]);

        const beforeContinue = audio.currentTime;
        await sleepInPage(1000);
        report.advancedAfterSeek = audio.currentTime - beforeContinue;
      }

      audio.pause();
      report.pausedAtEnd = audio.paused;
      return report;

      function sleepInPage(ms) {
        return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      report.error = report.stage ? `${report.stage}: ${message}` : message;
      return report;
    }
  }, id);
}

test.describe('V2 fragmented-MP4 playback', () => {
  // Startup scans and normalises before the manifest route can answer, so both the fixture
  // hook and the browser runs need more than the default 30 s.
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'v2-mse-'));
    const musicDir = join(tempDir, 'music');
    mkdirSync(musicDir, { recursive: true });
    copyFileSync(sourceFile(), join(musicDir, 'fixture.m4a'));

    const logPath = join(tempDir, 'server.log');
    writeFileSync(logPath, '');

    serverProcess = spawn('node', ['src/server.js'], {
      cwd: resolve('../backend'),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        MUSIC_DIR: musicDir,
        DATABASE_PATH: join(tempDir, 'e2e.db'),
        SCAN_ON_STARTUP: 'true',
        NORMALIZE_ON_STARTUP: 'true',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stdout.on('data', (chunk) => appendFileSync(logPath, chunk));
    serverProcess.stderr.on('data', (chunk) => appendFileSync(logPath, chunk));

    try {
      await waitForHealth();
      trackId = await findTrackId();
      await waitForManifest(trackId);
    } catch (error) {
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-3000) : '';
      throw new Error(`${error.message}\n--- server log tail ---\n${log}`);
    }
  });

  test.afterAll(async () => {
    if (serverProcess) serverProcess.kill('SIGTERM');
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // One case per engine; playwright.config.ts supplies the projects.
  test('plays and seeks through MSE', async ({ page, browserName }) => {
      expect(trackId, 'fixture backend unavailable').toBeTruthy();

      await page.goto(`${BASE}/api/health`); // same-origin document for fetch + MediaSource
      const report = await playWithManifest(page, trackId);
      const dump = JSON.stringify(report, null, 1);
      // Long reports get truncated in the reporter output; keep a copy for debugging.
      if (process.env.E2E_REPORT_DIR) {
        writeFileSync(join(process.env.E2E_REPORT_DIR, `v2-mse-${browserName}.json`), dump);
      }

      const decodeUnsupported = report.audioErrorCode === 3 || report.audioErrorCode === 4;

      expect(report.manifest?.status, dump).toBe(200);
      if (!decodeUnsupported) expect(report.error, dump).toBeUndefined();
      expect(report.manifest.fragmentCount, dump).toBeGreaterThanOrEqual(2);
      expect(report.typeSupported, `${browserName} must decode ${report.manifest.mime}`).toBe(true);

      // The ranges really are MP4 boxes and the element understood them. This holds even where
      // decoding is unavailable, so it stays asserted for every engine.
      expect(report.initBox, dump).toContain('ftyp');
      expect(report.firstFragmentBox, dump).toContain('moof');
      expect(Number(report.durationAfterAppend), dump).toBeGreaterThan(1);
      expect(report.bufferedAfterAppend?.end ?? 0, dump).toBeGreaterThan(1);

      if (decodeUnsupported) {
        // Playwright's Firefox build ships no AAC decoder: a plain progressive <audio> also fails
        // with MEDIA_ERR_SRC_NOT_SUPPORTED here, so timing assertions would test the container.
        test.info().annotations.push({
          type: 'note',
          description: `decoded unavailable in this environment (MEDIA_ERR_${report.audioErrorCode}); index assertions passed`,
        });
        test.skip(true, 'engine has no AAC decoder here');
      }

      // and audio is progressing
      expect(report.pausedDuringPlayback, dump).toBe(false);
      expect(report.advancedSeconds, dump).toBeGreaterThan(0.5);

      if (report.target) {
        const expected = report.target.start + 0.2;
        expect(Math.abs(report.afterSeekCurrentTime - expected), dump).toBeLessThan(2.5);
        expect(report.advancedAfterSeek, dump).toBeGreaterThan(0.3);
      }

      expect(report.pausedAtEnd, dump).toBe(true);
  });
});
