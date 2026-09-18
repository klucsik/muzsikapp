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
const PASSWORD = 'e2e-test-password';
// Any real library works; default to this machine's, which is what the backend uses too.
const SOURCE_LIBRARY = process.env.E2E_MUSIC_SOURCE || process.env.MUSIC_DIR || '/workspace/music';

// The UI test above leaves its double-clicked track in room-1's `current-playlist-*`
// collection, which would duplicate the entry this test seeds and make “next track” land on
// the same song. Room 3 is one of the pre-seeded room playlists (1–5) that no other spec touches.
const ROOM = 'room-3';
const PLAYLIST_COLLECTION = `current-playlist-${ROOM}`;

let serverProcess = null;
let tempDir = null;
let trackId = null;
let secondTrackId = null;
let authToken = null;

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

async function findTrackIds() {
  const body = await (await fetch(`${BASE}/api/tracks?limit=200`)).json();
  const tracks = Array.isArray(body) ? body : body.tracks || [];
  return tracks
    .filter((track) => /\.(m4a|mp4)$/i.test(track.filepath || ''))
    .map((track) => track.id)
    .sort();
}

async function findTrackId() {
  const ids = await findTrackIds();
  if (!ids.length) throw new Error('Scanner found no m4a track');
  return ids[0];
}

/** Authenticated JSON call against the fixture backend. */
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
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

  async function login() {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(`login failed: ${res.status} ${JSON.stringify(body)}`);
    return body.token;
  }

  test.beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'v2-mse-'));
    const musicDir = join(tempDir, 'music');
    mkdirSync(musicDir, { recursive: true });
    copyFileSync(sourceFile(), join(musicDir, 'fixture.m4a'));
    // Auto-advance needs a playlist with a follower, so the library gets two copies.
    copyFileSync(sourceFile(), join(musicDir, 'fixture-next.m4a'));

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
        // Playback control (POST /api/playback/play) requires an authenticated client.
        AUTH_PASSWORD: PASSWORD,
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stdout.on('data', (chunk) => appendFileSync(logPath, chunk));
    serverProcess.stderr.on('data', (chunk) => appendFileSync(logPath, chunk));

    try {
      await waitForHealth();
      const ids = await findTrackIds();
      if (ids.length < 2) throw new Error(`Expected two fixture tracks, found ${ids.length}`);
      [trackId, secondTrackId] = ids;
      await waitForManifest(trackId);
      await waitForManifest(secondTrackId);
      authToken = await login();
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

  // The in-page harness above proves the byte ranges decode. This one proves the component is
  // actually wired to them: a click on a library row must end up feeding an MSE blob to the
  // V2 player's <audio> element and keep time.
  test('plays a library track through the V2 player UI', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'app wiring is engine-independent; one engine suffices');
    expect(trackId, 'fixture backend unavailable').toBeTruthy();

    const consoleLog = [];
    page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`));

    await page.addInitScript(({ token }) => {
      localStorage.setItem('muzsikapp-player-mode', 'v2');
      localStorage.setItem('auth_token', token);
    }, { token: authToken });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

    // Rows show the tag title, not the filename, so select by structure rather than text.
    const row = page.locator('.track-item').first();
    await row.waitFor({ timeout: 20_000 });
    await row.dblclick();

    const progress = () => page.evaluate(async () => {
      const audio = document.querySelector('audio');
      if (!audio) return null;
      const first = audio.currentTime;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
      return {
        src: audio.src.slice(0, 5),
        currentTime: audio.currentTime,
        advanced: audio.currentTime - first,
        paused: audio.paused,
        buffered: audio.buffered.length ? Number(audio.buffered.end(audio.buffered.length - 1).toFixed(2)) : 0,
        error: audio.error ? audio.error.code : null,
      };
    });

    let sample = null;
    try {
      await expect
        .poll(async () => {
          sample = await progress();
          return sample?.src === 'blob:' && sample.advanced > 0.3;
        }, { timeout: 25_000, message: 'V2 player never fed a blob: source that advances time' })
        .toBe(true);
    } finally {
      // The app's own console is the only useful trace when this fails.
      if (process.env.E2E_REPORT_DIR) {
        writeFileSync(join(process.env.E2E_REPORT_DIR, 'v2-mse-ui.log'), consoleLog.join('\n'));
      }
    }

    sample = sample ?? await progress();
    expect(sample.error, JSON.stringify(sample)).toBeNull();
    expect(sample.buffered).toBeGreaterThan(1);
  });

  // The room only moves on because a client reports “this track ended”, so a player that never
  // sends it strands the playlist after one song. Prove the whole loop over a real socket.
  test('hands the room to the next track when the current one ends', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'one engine proves the wiring');
    expect(trackId && secondTrackId, 'fixture backend unavailable').toBeTruthy();

    const consoleLog = [];
    page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`));

    // Build the playlist and start the first item before the browser connects: the player has
    // to recover the room state from `state_sync` and then follow it to the end.
    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'DELETE' });
    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'POST', body: { track_id: trackId } });
    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'POST', body: { track_id: secondTrackId } });
    await api('/api/playback/play', {
      method: 'POST',
      body: { trackId, roomId: ROOM, startPosition: 0, playlistIndex: 0 },
    });

    await page.addInitScript(({ token, room }) => {
      localStorage.setItem('muzsikapp-player-mode', 'v2');
      localStorage.setItem('auth_token', token);
      localStorage.setItem('rpg-music-room-id', room);
    }, { token: authToken, room: ROOM });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

    const sample = () => page.evaluate(() => {
      const audio = document.querySelector('audio');
      if (!audio) return null;
      return {
        src: audio.src.slice(0, 5),
        currentTime: Number(audio.currentTime.toFixed(2)),
        duration: audio.duration,
        paused: audio.paused,
        error: audio.error ? audio.error.code : null,
      };
    });

    try {
      // 1. the player picks the room's track up. Chromium refuses to start audio until the
      //    document has a gesture, so act like a listener would — which also proves the control
      //    goes through the server rather than only toggling the element. When the browser
      //    blocked autoplay the player shows its unlock overlay, and dismissing that overlay
      //    already resumes playback: pressing play on top of that would pause the whole room.
      const overlay = page.locator('.audio-unlock-overlay');
      const playButton = page.locator('.control-btn.play-pause');
      await playButton.waitFor({ timeout: 25_000 });

      let current = null;
      await expect
        .poll(async () => {
          // An autoplay rejection can land at any point; the overlay click is the gesture.
          if (await overlay.isVisible().catch(() => false)) {
            await overlay.click();
            return false;
          }
          current = await sample();
          // Only press play while the element really is paused, then give the server's resume
          // broadcast a moment to land before judging again — a second click would toggle off.
          if (current?.src === 'blob:' && current.paused) {
            await playButton.click();
            await page.waitForTimeout(1500);
            return false;
          }
          return current?.src === 'blob:' && !current.paused && current.currentTime > 0.3;
        }, { timeout: 40_000, message: 'V2 player never started the room track' })
        .toBe(true);

      // 2. jump to the tail through the real progress bar — nobody wants to watch a whole track
      const seekTo = Math.max(1, current.duration - 4);
      const bar = await page.locator('.progress-bar').boundingBox();
      // A bar squeezed to zero height by the flex layout swallows the double click and the seek
      // below silently does nothing, so fail here with a message that says so.
      expect(bar && bar.height > 4, 'progress bar is too short to click').toBe(true);
      await page.mouse.dblclick(bar.x + bar.width * (seekTo / current.duration), bar.y + bar.height / 2);
      await expect
        .poll(async () => {
          const now = await sample();
          return !!now && now.currentTime >= seekTo - 2;
        }, { timeout: 20_000, message: 'seek to the tail never landed' })
        .toBe(true);

      // 3. ending the track has to move the room…
      await expect
        .poll(async () => (await api(`/api/playback/state?roomId=${ROOM}`))?.currentTrack?.id, {
          timeout: 90_000,
          message: 'server never advanced to the next track',
        })
        .toBe(secondTrackId);

      // …and the player has to actually play the follower, from the beginning
      await expect
        .poll(async () => {
          const now = await sample();
          return !!now && !now.paused && now.currentTime > 0.3 && now.currentTime < 30;
        }, { timeout: 40_000, message: 'next track never started playing in the V2 player' })
        .toBe(true);
    } finally {
      if (process.env.E2E_REPORT_DIR) {
        writeFileSync(join(process.env.E2E_REPORT_DIR, 'v2-mse-autonext.log'), consoleLog.join('\n'));
      }
    }
  });

  // Looping is decided by a room flag, and that flag is the only thing that makes the first
  // item follow the last one. Switching it has to re-plan the prefetch immediately: waiting for
  // the transition would mean the first song of the second lap starts from a cold cache.
  test('pre-buffers the first track when the playlist loop is switched on the last item', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'one engine proves the wiring');
    expect(trackId && secondTrackId, 'fixture backend unavailable').toBeTruthy();

    // Warming asks for the target's manifest before any byte-range request, so the request
    // stream is the observable signal.
    const manifested = new Set();
    page.on('request', (request) => {
      const match = /\/audio\/([0-9a-fA-F-]+)\/manifest/.exec(request.url());
      if (match) manifested.add(match[1]);
    });
    const consoleLog = [];
    page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`));

    const loopButton = page.locator('button.loop-btn');
    const attached = () => page.evaluate(() => !!document.querySelector('audio')?.src.startsWith('blob:'));

    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'DELETE' });
    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'POST', body: { track_id: trackId } });
    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'POST', body: { track_id: secondTrackId } });
    // Start on the *last* item: while the playlist does not loop, nothing follows it.
    await api('/api/playback/play', {
      method: 'POST',
      body: { trackId: secondTrackId, roomId: ROOM, startPosition: 0, playlistIndex: 1 },
    });

    await page.addInitScript(({ token, room }) => {
      localStorage.setItem('muzsikapp-player-mode', 'v2');
      localStorage.setItem('auth_token', token);
      localStorage.setItem('rpg-music-room-id', room);
      // The fragment inventory lives in the settings panel; open it from the start.
      localStorage.setItem('muzsikapp-settings-panel-open', 'true');
    }, { token: authToken, room: ROOM });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

    try {
      await loopButton.waitFor({ timeout: 25_000 });
      // The room flag survives between runs and /api/playback/loop only toggles, so walk it to
      // Off, then reload: warming caches in the page, and a warm from the walk would otherwise
      // hide the very request this test waits for.
      if ((await loopButton.getAttribute('title')) !== 'Loop Playlist: Off') {
        await loopButton.click();
        await expect(loopButton).toHaveAttribute('title', 'Loop Playlist: Off', { timeout: 10_000 });
        await page.reload({ waitUntil: 'networkidle' });
        await loopButton.waitFor({ timeout: 25_000 });
      }
      expect((await loopButton.getAttribute('title'))).toBe('Loop Playlist: Off');
      // The request Set spans the reload above, so it still holds the manifest the page asked
      // for while the room's (leaked) loop flag was on. Reading it now would blame this test's
      // warm for a request made before the loop was switched off.
      manifested.clear();

      await expect
        .poll(async () => page.evaluate(() => document.querySelector('audio')?.src.startsWith('blob:')), {
          timeout: 30_000,
          message: 'V2 player never attached the room track',
        })
        .toBe(true);
      expect(manifested.has(trackId), 'nothing after the last track until the loop is on').toBe(false);

      await loopButton.click();
      await expect(loopButton).toHaveAttribute('title', 'Loop Playlist: On', { timeout: 10_000 });

      await expect
        .poll(() => manifested.has(trackId), {
          timeout: 20_000,
          message: 'the first track was never warmed for the wrap-around',
        })
        .toBe(true);

      // The fragment inventory moved into the settings panel, which also names the next track.
      await expect(page.locator('.fragment-table tbody tr').first()).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.fragment-next')).toContainText('next:', { timeout: 10_000 });
      await expect(page.locator('.fragment-warmed-title')).toBeVisible({ timeout: 10_000 });
    } finally {
      // The app's console is the only useful trace when the prefetch never happens.
      if (process.env.E2E_REPORT_DIR) {
        writeFileSync(join(process.env.E2E_REPORT_DIR, 'v2-mse-loopwarm.log'), consoleLog.join('\n'));
      }
    }
  });

  // Chromium caps how many SourceBuffer objects one page may hold, so a teardown that leaves one
  // attached to its MediaSource turns the Nth track change into “addSourceBuffer … reached the
  // limit of SourceBuffer objects” and a dead player with empty buffer bars.
  test('survives repeated track changes without exhausting MediaSource', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the SourceBuffer budget is a Chromium limit');
    expect(trackId && secondTrackId, 'fixture backend unavailable').toBeTruthy();

    const problems: string[] = [];
    page.on('console', (message) => {
      if (/SourceBuffer objects|addSourceBuffer|SourceBuffer error/i.test(message.text())) {
        problems.push(message.text());
      }
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'DELETE' });
    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'POST', body: { track_id: trackId } });
    await api(`/api/collections/${PLAYLIST_COLLECTION}/tracks`, { method: 'POST', body: { track_id: secondTrackId } });

    await page.addInitScript(({ token, room }) => {
      localStorage.setItem('muzsikapp-player-mode', 'v2');
      localStorage.setItem('auth_token', token);
      localStorage.setItem('rpg-music-room-id', room);
      // Count the objects rather than waiting for the browser to run out: the cap depends on the
      // machine, the leak does not.
      (window as any).__sb = { added: 0, removed: 0 };
      const proto = MediaSource.prototype;
      const add = proto.addSourceBuffer;
      const drop = proto.removeSourceBuffer;
      proto.addSourceBuffer = function (...args) { (window as any).__sb.added++; return add.apply(this, args); };
      proto.removeSourceBuffer = function (...args) { (window as any).__sb.removed++; return drop.apply(this, args); };
    }, { token: authToken, room: ROOM });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

    const playing = () => page.evaluate(async () => {
      const audio = document.querySelector('audio');
      if (!audio || !audio.src.startsWith('blob:')) return false;
      const before = audio.currentTime;
      await new Promise((resolveWait) => setTimeout(resolveWait, 600));
      return audio.currentTime > before + 0.2;
    });

    try {
      for (let i = 0; i < 5; i++) {
        const target = i % 2 === 0 ? trackId : secondTrackId;
        await api('/api/playback/play', {
          method: 'POST', body: { trackId: target, roomId: ROOM, startPosition: 0 },
        });
        await expect.poll(playing, { timeout: 25_000, message: `switch ${i + 1} never played` }).toBe(true);

        if (i === 4) {
          // Park the playhead on the final frames and let the room pause there. The pause
          // broadcast carries that position back, and honouring it used to reopen the tail of a
          // stream the browser had already closed.
          const tail = await page.evaluate(() => document.querySelector('audio')?.duration ?? 0);
          await api('/api/playback/seek', { method: 'POST', body: { position: tail - 0.2, roomId: ROOM } });
          await api('/api/playback/pause', { method: 'POST', body: { roomId: ROOM } });
          await api('/api/playback/play', {
            method: 'POST', body: { trackId: target, roomId: ROOM, startPosition: 0 },
          });
          await expect.poll(playing, { timeout: 25_000, message: 'playback never recovered' }).toBe(true);
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);

      // One SourceBuffer may still be live (the track that is playing); anything else leaked.
      const counts = await page.evaluate(() => (window as any).__sb);
      expect(counts.added, JSON.stringify(counts)).toBeGreaterThanOrEqual(3);
      expect(counts.added - counts.removed, JSON.stringify(counts)).toBeLessThanOrEqual(1);
    } finally {
      if (process.env.E2E_REPORT_DIR) {
        writeFileSync(join(process.env.E2E_REPORT_DIR, 'v2-mse-churn.log'), problems.join('\n'));
      }
    }
  });
});
