/**
 * useMseBuffer — MediaSource (V2) playback for fragmented-MP4 tracks.
 *
 * The backend normalises every m4a to a fragmented container and hands back a manifest of
 * byte ranges (`GET /audio/:id/manifest` — the audio router is not under `/api`): an init segment plus one entry per fragment.
 * Fragments are fetched with Range requests against the ordinary audio URL, so caching works
 * on immutable byte spans instead of arbitrary slices that no decoder can parse.
 */

import { ref, computed } from 'vue';
import { ChunkCache } from '../services/chunkCache.js';
import { predictNextChunks, CHUNK_DURATION } from '../services/prefetchPredictor.js';
import { telemetry } from './useTelemetry.js';

// ─── Logging ─────────────────────────────────────────────────────────
const log = (...args) => console.log('[MSE]', ...args);
const warn = (...args) => console.warn('[MSE]', ...args);
const err = (...args) => console.error('[MSE]', ...args);

// Fallback mime used only for the capability probe; real playback uses manifest.mime.
const DEFAULT_MIME = 'audio/mp4; codecs="mp4a.40.2"';
const INIT_RETRY_DELAY = 150;
const PREFETCH_INTERVAL_MS = 5000;
// How much audio to keep buffered in front of the playhead. Without a bound the sequential
// chain walks to the end of the track and downloads a 60-minute file on the first click.
const PREFETCH_LOOKAHEAD_SEC = 90;
const MAX_APPEND_RETRIES = 2;

export function isMseSupported(mimeType = DEFAULT_MIME) {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType);
}

export const isMseAacSupported = () => isMseSupported();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRange(url, startByte, endByte, signal) {
  const response = await fetch(url, { headers: { Range: `bytes=${startByte}-${endByte}` }, signal });
  if (response.status === 416) throw new Error(`Range not satisfiable: ${startByte}-${endByte}`);
  if (!response.ok && response.status !== 206) throw new Error(`Fetch failed: ${response.status}`);
  return response.arrayBuffer();
}

/** Init segment + fragment table for a track. `fallback: 'v1'` means "use the other player". */
async function fetchManifest(audioBaseUrl, signal) {
  const response = await fetch(`${audioBaseUrl}/manifest`, { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `Manifest request failed: ${response.status}`);
    error.code = body.error;
    error.fallback = body.fallback;
    throw error;
  }
  return body;
}

// ─── Composable ──────────────────────────────────────────────────────

export function useMseBuffer() {
  const cache = new ChunkCache(50 * 1024 * 1024); // 50MB default budget

  /** @type {{ value: HTMLAudioElement | null }} */
  const audioEl = ref(null);
  /** @type {{ value: MediaSource | null }} */
  const mediaSource = ref(null);
  /** @type {{ value: SourceBuffer | null }} */
  const sourceBuffer = ref(null);

  const currentTrackId = ref(null);
  const trackDuration = ref(0);
  const fragments = ref([]);
  const manifestMime = ref(DEFAULT_MIME);
  const playlist = ref([]);
  const loopRegion = ref(null); // { startSec, endSec }
  const repeatMode = ref('none');

  const playing = ref(false);
  const bufferedRanges = ref(null);
  const error = ref(null);
  const mseSupported = ref(isMseSupported());
  const needsFallback = ref(false);
  const loadProgress = ref(0);

  const cacheSize = computed(() => cache.totalSize);
  const pendingCount = computed(() => {
    let count = 0;
    for (const key of cache.pendingIndices) {
      if (typeof key === 'string' || typeof key === 'number') count += 1;
    }
    return count;
  });

  let _speedCapBytesPerSec = 0; // 0 = unlimited
  let _abortController = null;
  let _sequentialFetchInFlight = false;
  let _isShuttingDown = false;
  let _prefetchInterval = null;
  let _stallDetectionInterval = null;
  let _audioBaseUrl = '';
  let _initEnd = 0;
  let _initAppended = false;
  let _lastAppendedIndex = -1;
  let _appendQueue = []; // fragment indices waiting for the SourceBuffer to free up
  let _appendRetries = 0;

  // ── Fragment geometry ──────────────────────────────────────────

  const fragmentCount = computed(() => fragments.value.length);

  /** Real fragment boundaries come from the manifest, not from a fixed chunk length. */
  function fragmentIndexForTime(seconds) {
    const list = fragments.value;
    if (!list.length) return 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const start = list[i].start ?? 0;
      if (seconds >= start - 0.001) return i;
    }
    return 0;
  }

  /** Predictive prefetch assumes fixed-length chunks; only trust it when that holds. */
  function predictorApplies() {
    const count = fragments.value.length;
    if (!count || !trackDuration.value) return false;
    const actual = trackDuration.value / count;
    return Math.abs(actual - CHUNK_DURATION) / CHUNK_DURATION < 0.25;
  }

  // ── Core lifecycle ─────────────────────────────────────────────

  function initMediaSource(el, mimeType = DEFAULT_MIME) {
    if (_isShuttingDown) { warn('initMediaSource blocked by shutdown'); return; }

    const ms = new MediaSource();
    mediaSource.value = ms;
    manifestMime.value = mimeType;
    el.src = URL.createObjectURL(ms);

    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer(mimeType);
        sourceBuffer.value = sb;
        log('SourceBuffer created for MIME:', mimeType, 'mode:', sb.mode);
        // Default 'segments' mode is required: it honours each fragment's own timestamps, so
        // appending a fragment after a seek lands at the right media time. 'sequence' would
        // glue it to the end of the buffer instead.
        sb.addEventListener('updateend', onSourceBufferUpdateEnd);
        sb.addEventListener('error', () => {
          err('SourceBuffer error (readyState:', sb.updating ? 'updating' : 'idle', ')');
          telemetry.recordPlaybackError?.('sourcebuffer-error');
        });
      } catch (e) {
        err('failed to add SourceBuffer:', e.message || e);
        error.value = e;
      }
    });

    startStallDetection();
  }

  function startStallDetection() {
    if (_stallDetectionInterval) clearInterval(_stallDetectionInterval);
    _stallDetectionInterval = setInterval(() => {
      const el = audioEl.value;
      if (!playing.value || !el) return;
      const buffered = el.buffered;
      if (!buffered.length) return;
      const lastBufferedEnd = buffered.end(buffered.length - 1);
      if (el.currentTime >= lastBufferedEnd - 0.5 && el.currentTime < (el.duration || Infinity) - 0.1) {
        telemetry.recordStallStart();
      } else if (el.currentTime < lastBufferedEnd - 0.2) {
        telemetry.recordStallEnd();
      }
    }, 1000);
  }

  function shutdown(silent = false) {
    if (!silent) log('shutdown called');
    if (_stallDetectionInterval) { clearInterval(_stallDetectionInterval); _stallDetectionInterval = null; }
    const alreadyDown = _isShuttingDown;
    _isShuttingDown = true;

    if (_prefetchInterval) { clearInterval(_prefetchInterval); _prefetchInterval = null; }
    if (_abortController) { _abortController.abort(); _abortController = null; }

    const sb = sourceBuffer.value;
    if (sb && mediaSource.value) {
      sb.removeEventListener('updateend', onSourceBufferUpdateEnd);
      try {
        // endOfStream() throws while an update is in flight; the element is being torn down
        // anyway, so ignore it rather than log spurious errors on every track change.
        if (!sb.updating && mediaSource.value.readyState === 'open') mediaSource.value.endOfStream();
      } catch (_) { /* tearing down */ }
    }

    const el = audioEl.value;
    if (el?.src?.startsWith('blob:')) {
      URL.revokeObjectURL(el.src);
      el.removeAttribute('src');
      el.load();
    }

    mediaSource.value = null;
    sourceBuffer.value = null;
    if (!alreadyDown) audioEl.value = null;
    currentTrackId.value = null;
    trackDuration.value = 0;
    fragments.value = [];
    _initEnd = 0;
    _initAppended = false;
    _lastAppendedIndex = -1;
    _appendQueue = [];
    playing.value = false;
    error.value = null;
    needsFallback.value = false;
    bufferedRanges.value = null;
    loadProgress.value = 0;
    _isShuttingDown = false;
  }

  async function loadTrack(trackId, audioBaseUrl, audioElRef, duration) {
    log('loadTrack:', trackId, audioBaseUrl);
    shutdown();

    currentTrackId.value = trackId;
    _audioBaseUrl = audioBaseUrl;
    error.value = null;
    needsFallback.value = false;
    audioEl.value = audioElRef;
    _abortController = new AbortController(); // fresh per track; shutdown() aborts the old one

    const signal = _abortController.signal;
    let manifest;
    try {
      manifest = await fetchManifest(audioBaseUrl, signal);
    } catch (e) {
      if (signal.aborted) return;
      if (e.fallback === 'v1' || e.code === 'UNSUPPORTED_FORMAT') {
        warn('track needs the V1 player:', e.message);
        needsFallback.value = true;
        return;
      }
      err('manifest failed:', e.message || e);
      error.value = e;
      return;
    }

    fragments.value = manifest.fragments || [];
    trackDuration.value = manifest.durationSec || duration || 0;
    _initEnd = manifest.initEnd || 0;

    if (!isMseSupported(manifest.mime)) {
      warn('browser cannot decode', manifest.mime, '— falling back to V1');
      needsFallback.value = true;
      return;
    }

    initMediaSource(audioElRef, manifest.mime);
    await waitForSourceOpen();

    if (!sourceBuffer.value || error.value) {
      err('loadTrack aborted: no SourceBuffer');
      if (!error.value) error.value = new Error('MediaSource unavailable');
      return;
    }

    if (trackDuration.value && mediaSource.value.duration !== trackDuration.value) {
      try { mediaSource.value.duration = trackDuration.value; } catch (_) { /* set on append */ }
    }

    await loadInitSegment();
    if (_isShuttingDown || currentTrackId.value !== trackId) return;

    startPrefetching();
    const startIndex = fragmentIndexForTime(audioElRef?.currentTime || 0);
    _lastAppendedIndex = startIndex - 1;
    await fetchFragmentInSequence(startIndex);
  }

  /** ftyp+moov: without this first append every following fragment is undecodable. */
  async function loadInitSegment() {
    if (_initAppended || !_initEnd) return;
    const key = `${currentTrackId.value}-init`;
    try {
      let buffer = cache.get(key);
      if (!buffer) {
        buffer = await fetchRange(_audioBaseUrl, 0, _initEnd - 1, _abortController?.signal);
        cache.put(key, buffer);
      }
      await appendBuffer(buffer, { init: true });
      _initAppended = true;
      log('init segment appended:', buffer.byteLength, 'bytes');
    } catch (e) {
      if (e?.name === 'AbortError') return;
      err('init segment failed:', e.message || e);
      error.value = e;
    }
  }

  function waitForSourceOpen() {
    return new Promise((resolve, reject) => {
      const ms = mediaSource.value;
      if (!ms) return reject(new Error('No MediaSource'));
      if (ms.readyState === 'open') return resolve();

      let timerId = null;
      const onOpen = () => {
        if (mediaSource.value?.readyState !== 'open') return;
        mediaSource.value.removeEventListener('sourceopen', onOpen);
        clearTimeout(timerId);
        resolve();
      };

      ms.addEventListener('sourceopen', onOpen);
      timerId = setTimeout(() => {
        err('MediaSource sourceopen timed out, readyState:', ms.readyState);
        reject(new Error('MediaSource timeout'));
      }, 5000);
    });
  }

  // ── Fragment pipeline ──────────────────────────────────────────

  async function fetchFragmentInSequence(index) {
    if (_isShuttingDown || !currentTrackId.value) return;
    if (index >= fragmentCount.value) return;

    const trackAtStart = currentTrackId.value;
    const cacheKey = `${trackAtStart}-${index}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      await appendBuffer(cached, { index });
      return nextFragment(index);
    }

    if (_abortController?.signal.aborted) return;

    try {
      const fragment = fragments.value[index];
      _sequentialFetchInFlight = true;
      cache.markPending(cacheKey);
      const startedAt = performance.now();
      log(`fragment ${index}: bytes=${fragment.offset}-${fragment.offset + fragment.size - 1}`);

      let buffer;
      try {
        buffer = await fetchRange(_audioBaseUrl, fragment.offset, fragment.offset + fragment.size - 1, _abortController?.signal);
      } finally {
        _sequentialFetchInFlight = false;
      }

      if (currentTrackId.value !== trackAtStart) return; // track changed mid-fetch

      const elapsedSec = Math.max((performance.now() - startedAt) / 1000, 0.001);
      await respectSpeedCap(buffer.byteLength, startedAt);

      telemetry.recordDownload(buffer.byteLength, elapsedSec);
      cache.put(cacheKey, buffer);
      telemetry.updateMemoryUsage(cache.totalSize);
      log(`fragment ${index}: ${buffer.byteLength} bytes in ${elapsedSec.toFixed(2)}s`);

      await appendBuffer(buffer, { index });
      return nextFragment(index);
    } catch (e) {
      _sequentialFetchInFlight = false;
      cache.unmarkPending?.(cacheKey);
      if (e?.name === 'AbortError') return;
      err(`fragment ${index} fetch error:`, e.message || e);
      telemetry.recordDownloadError?.();
      await sleep(INIT_RETRY_DELAY);
      return fetchFragmentInSequence(index);
    }
  }

  function nextFragment(previousIndex) {
    const currentTime = audioEl.value?.currentTime || 0;
    if (bufferedAheadSec(currentTime) > PREFETCH_LOOKAHEAD_SEC) return undefined; // prefetch loop resumes
    const playheadIndex = fragmentIndexForTime(currentTime);
    const next = Math.max(previousIndex + 1, playheadIndex);
    if (next < previousIndex + 1 || next >= fragmentCount.value) return undefined;
    return fetchFragmentInSequence(next);
  }

  /** Seconds of decoded audio already buffered in front of `currentTime`. */
  function bufferedAheadSec(currentTime) {
    const buffered = audioEl.value?.buffered;
    if (!buffered) return 0;
    let end = currentTime;
    for (let i = 0; i < buffered.length; i += 1) {
      if (buffered.start(i) <= currentTime + 0.5 && buffered.end(i) > end) end = buffered.end(i);
    }
    return Math.max(end - currentTime, 0);
  }

  /** Respects the user's bandwidth cap by padding out the download time. */
  async function respectSpeedCap(byteLength, startedAt) {
    if (!_speedCapBytesPerSec) return;
    const minimumMs = (byteLength / _speedCapBytesPerSec) * 1000 - (performance.now() - startedAt);
    if (minimumMs > 0) await sleep(minimumMs);
  }

  /**
   * Append with a queue: SourceBuffer rejects appendBuffer while updating, and MSE also
   * rejects appends that would exceed the byte quota until old audio is removed.
   */
  function appendBuffer(buffer, { index = null, init = false } = {}) {
    return new Promise((resolve) => {
      const sb = sourceBuffer.value;
      if (!sb) { warn('append: no SourceBuffer'); resolve(); return; }

      _appendQueue.push({ buffer, index, init, resolve });
      drainAppendQueue();
    });
  }

  function drainAppendQueue() {
    const sb = sourceBuffer.value;
    if (!sb || !_appendQueue.length) return;

    // Keep the queue short: stale fragments behind the playhead are worthless.
    while (_appendQueue.length) {
      const head = _appendQueue[0];
      if (head.index !== null && head.index <= _lastAppendedIndex) {
        _appendQueue.shift();
        head.resolve();
        continue;
      }
      if (!sb.updating) {
        const item = _appendQueue.shift();
        try {
          sb.appendBuffer(item.buffer);
          if (item.index !== null) _lastAppendedIndex = Math.max(_lastAppendedIndex, item.index);
          item.resolve();
        } catch (e) {
          _appendRetries += 1;
          if (isQuotaError(e) && _appendRetries <= MAX_APPEND_RETRIES && evictBufferedAudio()) {
            // Put it back and let the removal's updateend retry it; resolving now would
            // let the pipeline run on and leave a permanent hole in buffered audio.
            _appendQueue.unshift(item);
            return;
          }
          err('append failed:', e.message || e);
          telemetry.recordDownloadError?.();
          cache.remove(`${currentTrackId.value}-${item.index}`);
          item.resolve();
        }
        return; // wait for updateend
      }
      return; // SourceBuffer busy; updateend will drain again
    }
  }

  function isQuotaError(e) {
    return e?.name === 'QuotaExceededError' || e?.code === 22;
  }

  /** Drop buffered audio well behind the playhead so appends can keep going. */
  function evictBufferedAudio() {
    const sb = sourceBuffer.value;
    const el = audioEl.value;
    if (!sb || !el || sb.updating) return false;

    const keepFrom = Math.max(0, (el.currentTime || 0) - 30);
    if (keepFrom <= 0 || !el.buffered.length) return false;
    try {
      sb.remove(0, keepFrom);
      return true;
    } catch (_) {
      return false;
    }
  }

  function onSourceBufferUpdateEnd() {
    if (_isShuttingDown || !currentTrackId.value) return;
    _appendRetries = 0;
    updateBufferedRanges();
    drainAppendQueue();
  }

  // ── Prefetching (background) ───────────────────────────────────

  function startPrefetching() {
    if (_prefetchInterval) clearInterval(_prefetchInterval);
    _prefetchInterval = setInterval(() => {
      // Skip only while a playback-critical fetch is running — prefetching matters most
      // *while* playing, so do not gate on `playing`.
      if (!currentTrackId.value || _sequentialFetchInFlight) return;

      const currentIndex = fragmentIndexForTime(audioEl.value?.currentTime || 0);
      const wanted = new Set();

      if (predictorApplies()) {
        for (const prediction of predictNextChunks(
          { currentTrackIndex: 0, currentTimeInSeconds: audioEl.value?.currentTime || 0, playlist: playlist.value },
          { loopRegion: loopRegion.value, repeatMode: repeatMode.value },
        )) {
          if (prediction.trackIndex === 0) wanted.add(prediction.chunkIndex);
        }
      }

      // Always keep the next couple of fragments warm, predictor or not.
      for (let offset = 1; offset <= 2; offset += 1) {
        if (currentIndex + offset < fragmentCount.value) wanted.add(currentIndex + offset);
      }

      // The sequential chain stops once it is far enough ahead; wake it when the playhead
      // has eaten into that reserve, otherwise playback stalls at the end of the buffer.
      const currentTime = audioEl.value?.currentTime || 0;
      if (
        !_sequentialFetchInFlight
        && _initAppended
        && _lastAppendedIndex + 1 < fragmentCount.value
        && bufferedAheadSec(currentTime) < PREFETCH_LOOKAHEAD_SEC
      ) {
        fetchFragmentInSequence(Math.max(_lastAppendedIndex + 1, currentIndex));
      }

      for (const index of wanted) {
        const key = `${currentTrackId.value}-${index}`;
        if (!cache.has(key)) prefetchFragment(index);
      }
    }, PREFETCH_INTERVAL_MS);
  }

  async function prefetchFragment(index) {
    if (index < 0 || index >= fragmentCount.value) return;
    const trackAtStart = currentTrackId.value;
    const key = `${trackAtStart}-${index}`;
    if (cache.has(key)) return;

    cache.markPending(key);
    try {
      const fragment = fragments.value[index];
      const startedAt = performance.now();
      const buffer = await fetchRange(_audioBaseUrl, fragment.offset, fragment.offset + fragment.size - 1);
      telemetry.recordDownload(buffer.byteLength, Math.max((performance.now() - startedAt) / 1000, 0.001));
      if (currentTrackId.value === trackAtStart) {
        cache.put(key, buffer);
        telemetry.updateMemoryUsage(cache.totalSize);
      }
    } catch (e) {
      if (e?.name !== 'AbortError') warn(`prefetch ${index} failed:`, e.message || e);
    } finally {
      cache.unmarkPending?.(key);
    }
  }

  // ── Playback control ───────────────────────────────────────────

  async function play() {
    if (!audioEl.value) { warn('play: no audio element'); return; }
    try {
      await audioEl.value.play();
      playing.value = true;
    } catch (e) {
      err('play failed:', e.message || e);
      error.value = e;
    }
  }

  function pause() {
    audioEl.value?.pause();
    playing.value = false;
  }

  async function togglePlayPause() {
    if (playing.value) pause();
    else await play();
  }

  /** Seeking may land on a fragment we never fetched, so kick the pipeline from there. */
  function seek(seconds) {
    const el = audioEl.value;
    if (!el) return;
    el.currentTime = seconds;
    const index = fragmentIndexForTime(seconds);
    if (index > _lastAppendedIndex || !isTimeBuffered(seconds)) {
      _lastAppendedIndex = Math.min(_lastAppendedIndex, index - 1);
      fetchFragmentInSequence(index);
    }
  }

  function isTimeBuffered(seconds) {
    const buffered = audioEl.value?.buffered;
    if (!buffered) return false;
    for (let i = 0; i < buffered.length; i += 1) {
      if (seconds >= buffered.start(i) && seconds <= buffered.end(i)) return true;
    }
    return false;
  }

  function setVolume(vol) {
    if (audioEl.value) audioEl.value.volume = vol;
  }

  function getCurrentTime() { return audioEl.value?.currentTime || 0; }

  function updateBufferedRanges() {
    const buffered = audioEl.value?.buffered ?? null;
    bufferedRanges.value = buffered;

    if (buffered && buffered.length && trackDuration.value) {
      let seconds = 0;
      for (let i = 0; i < buffered.length; i += 1) {
        seconds += buffered.end(i) - buffered.start(i);
      }
      loadProgress.value = Math.min(seconds / trackDuration.value, 1);
    }
  }

  function bindAudioEvents() {
    const el = audioEl.value;
    if (!el || _isShuttingDown) return;
    el.addEventListener('play', () => { playing.value = true; });
    el.addEventListener('pause', () => { playing.value = false; });
    el.addEventListener('ended', () => { playing.value = false; telemetry.recordStallEnd(); });
    el.addEventListener('error', () => telemetry.recordPlaybackError?.('media-element-error'));
  }

  // ── Settings ───────────────────────────────────────────────────

  function setCacheLimit(bytes) {
    log('cache limit:', bytes, 'used:', cache.totalSize);
    cache.maxCacheBytes = bytes;
    telemetry.totalMemory.value = bytes;
    evictToBudget();
  }

  /** Oldest-first eviction, skipping the protected pool (loop regions). */
  function evictToBudget() {
    if (cache.totalSize <= cache.maxCacheBytes) return;
    const entries = [...cache.cacheMap.entries()]
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const entry of entries) {
      if (cache.totalSize <= cache.maxCacheBytes) break;
      if (cache.protectedPool?.has(entry.key)) continue;
      cache.remove(entry.key);
    }
    telemetry.updateMemoryUsage(cache.totalSize);
  }

  function setSpeedCap(bytesPerSec) {
    _speedCapBytesPerSec = bytesPerSec || 0;
  }

  return {
    playing, bufferedRanges, error, mseSupported, loadProgress, currentTrackId,
    trackDuration, playlist, loopRegion, repeatMode, cacheSize, pendingCount,
    fragments, fragmentCount, needsFallback,
    initMediaSource, shutdown, loadTrack, play, pause, togglePlayPause, seek, setVolume,
    getCurrentTime, bindAudioEvents, updateBufferedRanges, setCacheLimit, setSpeedCap,
  };
}
