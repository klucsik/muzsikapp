/**
 * useMseBuffer — MediaSource (V2) playback for fragmented-MP4 tracks.
 *
 * The backend normalises every m4a to a fragmented container and hands back a manifest of
 * byte ranges (`GET /audio/:id/manifest` — the audio router is not under `/api`): an init segment plus one entry per fragment.
 * Fragments are fetched with Range requests against the ordinary audio URL, so caching works
 * on immutable byte spans instead of arbitrary slices that no decoder can parse.
 */

import { ref, computed, watch, toRaw } from 'vue';
import api from '../services/api';
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

// Cache keys are `${trackId}-${index}` (or `-init`). Track ids are UUIDs containing dashes,
// so the suffix has to be anchored: the id is everything before the *last* dash.
const CACHE_KEY_RE = /^(.+)-(init|\d+)$/;

/** Spans of `spans` not covered by `holes`; both are {start,end} lists in seconds. */
function subtractSpans(spans, holes) {
  const out = [];
  for (const span of spans) {
    let parts = [{ start: span.start, end: span.end }];
    for (const hole of holes) {
      const next = [];
      for (const part of parts) {
        if (hole.end <= part.start || hole.start >= part.end) {
          next.push(part);
          continue;
        }
        if (hole.start > part.start) next.push({ start: part.start, end: hole.start });
        if (hole.end < part.end) next.push({ start: hole.end, end: part.end });
      }
      parts = next;
    }
    out.push(...parts);
  }
  return out.filter((span) => span.end - span.start > 0.05);
}

/**
 * What the seek bar should draw as "loaded", in percentages of `duration`.
 *
 * Two different things get called loaded: audio the decoder already holds (`buffered`) and audio
 * the fragment cache still holds (`cached`). They part company whenever bytes are in hand but not
 * yet appended — right after loading a warmed or replayed track, where the row strip correctly
 * reads 100% while the bar crept up behind it. Returned as two layers so the bar can show the
 * difference instead of pretending the tail is missing.
 */
export function planCacheBlocks({ buffered = [], cached = [], currentTime = 0, duration = 0 } = {}) {
  if (!duration) return { loaded: [], held: [] };
  const from = Math.max(0, currentTime);
  const clip = (spans) => spans
    .map((span) => ({ start: Math.min(Math.max(span.start, from), duration), end: Math.min(span.end, duration) }))
    .filter((span) => span.end - span.start > 0.05);
  const toBlocks = (spans) => spans.map((span) => {
    const start = (span.start / duration) * 100;
    return { start, width: Math.min(100 - start, ((span.end - span.start) / duration) * 100) };
  });

  const loaded = clip(buffered);
  const held = subtractSpans(clip(cached), loaded);
  return { loaded: toBlocks(loaded), held: toBlocks(held) };
}

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
  // The room's 🔄 Loop Playlist flag. Separate from the repeat button: it repeats the queue,
  // so it is what makes the first track the successor of the last one.
  const playlistLoop = ref(false);

  const playing = ref(false);
  /** @type {{ value: Array<{ start: number, end: number }> }} plain snapshots of element.buffered */
  const bufferedRanges = ref([]);
  const error = ref(null);
  const mseSupported = ref(isMseSupported());
  const needsFallback = ref(false);
  const loadProgress = ref(0);

  // ChunkCache is a plain Map, so nothing inside it is reactive. Every mutation bumps this
  // counter and the stats computeds below depend on it — without this the UI reads the very
  // first value forever and the buffer panel looks frozen at zero chunks.
  const cacheVersion = ref(0);
  const touchCache = () => { cacheVersion.value += 1; };

  const cachePut = (key, buffer) => { cache.put(key, buffer); touchCache(); };
  const cacheRemove = (key) => { cache.remove(key); touchCache(); };
  const markPending = (key) => { cache.markPending?.(key); touchCache(); };
  const unmarkPending = (key) => { cache.unmarkPending?.(key); touchCache(); };

  const cacheSize = computed(() => {
    void cacheVersion.value;
    return cache.totalSize;
  });

  /** Every cached chunk of every track, newest eviction order aside. */
  const cachedKeys = computed(() => {
    void cacheVersion.value;
    const keys = [];
    for (const key of cache.cacheMap.keys()) {
      if (CACHE_KEY_RE.test(key)) keys.push(key);
    }
    return keys;
  });

  const cachedChunkCount = computed(() => cachedKeys.value.length);

  const pendingKeys = computed(() => {
    void cacheVersion.value;
    return [...cache.pendingIndices].filter((key) => CACHE_KEY_RE.test(key));
  });

  const pendingCount = computed(() => pendingKeys.value.length);

  /**
   * Per-fragment inventory for the current track: byte range, size and whether the bytes are
   * in cache, in flight, or still missing. Drives the chunk list in the player.
   */
  const chunkRows = computed(() => {
    void cacheVersion.value;
    const trackId = currentTrackId.value;
    if (!trackId) return [];
    return fragments.value.map((fragment, index) => {
      const key = `${trackId}-${index}`;
      const entry = cache.cacheMap.get(key);
      const state = entry ? 'cached' : cache.pendingIndices.has(key) ? 'downloading' : 'missing';
      const start = fragment.start ?? 0;
      const end = fragment.end ?? (trackDuration.value
        ? ((index + 1) * trackDuration.value) / fragments.value.length
        : 0);
      return {
        index,
        start,
        end,
        offset: fragment.offset,
        bytes: entry?.buffer.byteLength ?? fragment.size ?? 0,
        downloaded: !!entry,
        state,
      };
    });
  });

  /** Other tracks whose bytes are already in the cache (next-track warming). */
  const warmedTracks = computed(() => {
    void cacheVersion.value;
    const byTrack = new Map();
    for (const [key, entry] of cache.cacheMap) {
      const match = CACHE_KEY_RE.exec(key);
      if (!match) continue;
      const [, trackId, suffix] = match;
      if (trackId === currentTrackId.value) continue;
      const record = byTrack.get(trackId) || { trackId, init: false, chunks: 0, bytes: 0 };
      if (suffix === 'init') record.init = true;
      else record.chunks += 1;
      record.bytes += entry.buffer.byteLength;
      byTrack.set(trackId, record);
    }
    return [...byTrack.values()];
  });

  /**
   * How much of each track this client already holds, for the cache strip on the track list. Keyed
   * by track id: `{ cached, total, bytes }`, where `cached` counts fragments (the init segment is
   * overhead, not audio) and `total` comes from the manifest. A track whose manifest was never
   * fetched gets `total: 0` so the caller can leave it blank instead of drawing a misleading 0%.
   */
  /**
   * Time ranges of the *current* track whose fragments are still in the cache. `bufferedRanges`
   * only reports what reached the SourceBuffer, and a warmed or replayed track sits fully in
   * memory seconds before the appends catch up — the seek bar needs both to say "loaded".
   */
  const cachedSpans = computed(() => {
    const spans = [];
    for (const row of chunkRows.value) {
      if (!row.downloaded || row.end <= row.start) continue;
      const last = spans[spans.length - 1];
      if (last && row.start - last.end < 0.01) last.end = Math.max(last.end, row.end);
      else spans.push({ start: row.start, end: row.end });
    }
    return spans;
  });

  const cacheCoverage = computed(() => {
    void cacheVersion.value;
    const byTrack = {};
    for (const [key, entry] of cache.cacheMap) {
      const match = CACHE_KEY_RE.exec(key);
      if (!match) continue;
      const [, trackId, suffix] = match;
      const record = byTrack[trackId] || (byTrack[trackId] = {
        cached: 0,
        total: _manifests.get(trackId)?.fragmentCount || _manifests.get(trackId)?.fragments?.length || 0,
        bytes: 0,
      });
      if (suffix !== 'init') record.cached += 1;
      record.bytes += entry.buffer.byteLength;
    }
    return byTrack;
  });

  let _speedCapBytesPerSec = 0; // 0 = unlimited
  let _abortController = null;
  let _sequentialFetchInFlight = false;
  let _isShuttingDown = false;
  // Bumped by shutdown(). An in-flight load of an earlier generation must not touch shared state
  // any more: appending into a MediaSource that was already ended is what makes Chromium kill
  // the pipeline with CHUNK_DEMUXER_ERROR_APPEND_FAILED, and the room can switch tracks (or
  // rooms) faster than the element swaps src.
  let _loadToken = 0;
  let _prefetchInterval = null;
  let _stallDetectionInterval = null;
  let _audioBaseUrl = '';
  let _initEnd = 0;
  let _initAppended = false;
  let _lastAppendedIndex = -1;
  let _appendQueue = []; // fragment indices waiting for the SourceBuffer to free up
  let _appendRetries = 0;

  function onSourceBufferError() {
    const sb = sourceBuffer.value;
    err('SourceBuffer error (readyState:', sb?.updating ? 'updating' : 'idle', ')');
    telemetry.recordPlaybackError?.('sourcebuffer-error');
  }

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
    const token = _loadToken;
    mediaSource.value = ms;
    manifestMime.value = mimeType;
    el.src = URL.createObjectURL(ms);

    ms.addEventListener('sourceopen', () => {
      // A shutdown or a newer load replaced this MediaSource while the element was swapping
      // srcs. Wiring up its SourceBuffer would hand the pipeline back to a dead stream.
      if (token !== _loadToken || toRaw(mediaSource.value) !== ms) {
        warn('ignoring sourceopen from a superseded MediaSource');
        return;
      }
      try {
        const sb = ms.addSourceBuffer(mimeType);
        sourceBuffer.value = sb;
        log('SourceBuffer created for MIME:', mimeType, 'mode:', sb.mode);
        // Default 'segments' mode is required: it honours each fragment's own timestamps, so
        // appending a fragment after a seek lands at the right media time. 'sequence' would
        // glue it to the end of the buffer instead.
        sb.addEventListener('updateend', onSourceBufferUpdateEnd);
        sb.addEventListener('error', onSourceBufferError);
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
    _loadToken++;
    if (_stallDetectionInterval) { clearInterval(_stallDetectionInterval); _stallDetectionInterval = null; }
    const alreadyDown = _isShuttingDown;
    _isShuttingDown = true;

    if (_prefetchInterval) { clearInterval(_prefetchInterval); _prefetchInterval = null; }
    if (_abortController) { _abortController.abort(); _abortController = null; }

    const sb = sourceBuffer.value;
    const ms = mediaSource.value;
    if (sb) {
      sb.removeEventListener('updateend', onSourceBufferUpdateEnd);
      sb.removeEventListener('error', onSourceBufferError);
      // Detaching the SourceBuffer is what actually releases its demuxer/decoder. Leaving it
      // attached to a soon-orphaned MediaSource leaks one per track change, and Chromium then
      // refuses the next addSourceBuffer with "this MediaSource has reached the limit of
      // SourceBuffer objects" — after which nothing plays and every bar reads empty.
      // 'ended' is the usual state at the end of a track and still owns the decoder, so only a
      // closed MediaSource is skipped. An updating SourceBuffer refuses to be detached until its
      // append finishes, hence the one-shot retry after `updateend`.
      if (ms && ms.readyState !== 'closed') {
        const detach = () => { try { ms.removeSourceBuffer(sb); } catch (_) { /* GC will take it */ } };
        if (sb.updating) {
          try { sb.abort(); } catch (_) { /* tearing down */ }
          sb.addEventListener('updateend', detach, { once: true });
        } else {
          detach();
        }
      }
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
    bufferedRanges.value = [];
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
      // A warmed track already has its manifest, which skips a round trip on transition.
      manifest = _manifests.get(trackId) || await fetchManifest(audioBaseUrl, signal);
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
    if (fragments.value.length) _manifests.set(trackId, manifest);

    if (!isMseSupported(manifest.mime)) {
      warn('browser cannot decode', manifest.mime, '— falling back to V1');
      needsFallback.value = true;
      return;
    }

    const token = _loadToken;
    initMediaSource(audioElRef, manifest.mime);
    try {
      await waitForSourceOpen(token);
    } catch (e) {
      if (token !== _loadToken) return; // a newer load owns the element now
      warn('MediaSource never opened:', e.message || e);
      if (!error.value) error.value = new Error('MediaSource unavailable');
      return;
    }
    if (token !== _loadToken) {
      warn('load superseded before append:', trackId);
      return;
    }

    // Only the SourceBuffer itself proves the stream is usable: `error` can hold an unrelated
    // rejection that landed while waiting — an autoplay block is routine before a user gesture,
    // and treating it as a dead MediaSource used to abort the load after the init segment was
    // skipped, which then poisoned the pipeline with init-less appends.
    if (!sourceBuffer.value) {
      err('loadTrack aborted: no SourceBuffer');
      if (!error.value) error.value = new Error('MediaSource unavailable');
      return;
    }

    if (trackDuration.value && mediaSource.value.duration !== trackDuration.value) {
      try { mediaSource.value.duration = trackDuration.value; } catch (_) { /* set on append */ }
    }

    await loadInitSegment();
    if (_isShuttingDown || token !== _loadToken || currentTrackId.value !== trackId) return;

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
        cachePut(key, buffer);
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

  function waitForSourceOpen(token = _loadToken) {
    return new Promise((resolve, reject) => {
      const ms = mediaSource.value;
      if (!ms) return reject(new Error('No MediaSource'));
      if (ms.readyState === 'open') return resolve();

      let timerId = null;
      const onOpen = () => {
        // `sourceopen` only fires when the stream really is open, so the instance check is all
        // that is left: anything else belongs to a load that has already been replaced.
        if (token !== _loadToken || toRaw(mediaSource.value) !== ms) {
          clearTimeout(timerId);
          reject(new Error('Load superseded'));
          return;
        }
        ms.removeEventListener('sourceopen', onOpen);
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

    // Fragments are only decodable behind their init segment. A load that was replaced (or
    // aborted) leaves _initAppended false, and appending raw media here is what Chromium reports
    // as CHUNK_DEMUXER_ERROR_APPEND_FAILED.
    if (!_initAppended) await loadInitSegment();
    if (_isShuttingDown || currentTrackId.value !== trackAtStart) return;

    const cached = cache.get(cacheKey);
    if (cached) {
      await appendBuffer(cached, { index });
      return nextFragment(index);
    }

    if (_abortController?.signal.aborted) return;

    try {
      const fragment = fragments.value[index];
      _sequentialFetchInFlight = true;
      markPending(cacheKey);
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
      cachePut(cacheKey, buffer);
      telemetry.updateMemoryUsage(cache.totalSize);
      log(`fragment ${index}: ${buffer.byteLength} bytes in ${elapsedSec.toFixed(2)}s`);

      await appendBuffer(buffer, { index });
      return nextFragment(index);
    } catch (e) {
      _sequentialFetchInFlight = false;
      unmarkPending(cacheKey);
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

  // ── Next-track warming ─────────────────────────────────────────
  // The cache is keyed by track id and survives shutdown(), so fragments fetched for the
  // upcoming playlist item are already in memory when the transition happens.

  const NEXT_TRACK_FRAGMENTS = 2;
  const _manifests = new Map(); // trackId -> manifest, also reused by loadTrack
  const _warmInFlight = new Set(); // trackIds with a warm already running (the ticker fires every 5s)

  /** Server repeat is a boolean meaning “replay the current track”, which maps to 'one'. */
  /** 🔄 Loop Playlist, as broadcast by the room (`loop_mode_change` / `state_sync`). */
  function setPlaylistLoop(enabled) { playlistLoop.value = !!enabled; }

  function setRepeatMode(value) {
    repeatMode.value = value === true ? 'one' : (value === false ? 'none' : (value || 'none'));
  }

  function trackIdOf(entry) {
    return entry?.id ?? entry?.trackId ?? null;
  }

  function nextPlaylistTrackId() {
    const list = playlist.value || [];
    if (list.length < 2) return null;
    const idx = list.findIndex((t) => trackIdOf(t) === currentTrackId.value);
    if (idx === -1) return null;
    if (repeatMode.value === 'one') return trackIdOf(list[idx]); // same track again
    const next = idx + 1;
    if (next >= list.length) {
      // Only wrap when the playlist itself repeats.
      return repeatMode.value === 'all' || playlistLoop.value ? trackIdOf(list[0]) : null;
    }
    return trackIdOf(list[next]);
  }

  /** Fetch the init segment plus the first fragments of another track into the cache. */
  async function warmTrackFragments(trackId, count = NEXT_TRACK_FRAGMENTS) {
    if (!trackId || trackId === currentTrackId.value || _isShuttingDown) return;
    if (_warmInFlight.has(trackId)) return;
    const wanted = [`${trackId}-init`];
    for (let i = 0; i < count; i += 1) wanted.push(`${trackId}-${i}`);
    if (wanted.every((key) => cache.has(key))) return;

    const url = api.getAudioUrl(trackId);
    const trackAtStart = currentTrackId.value;
    _warmInFlight.add(trackId);
    try {
      let meta = _manifests.get(trackId);
      if (!meta) {
        meta = await fetchManifest(url);
        _manifests.set(trackId, meta);
      }

      const keys = [];
      if (meta.initEnd && !cache.has(`${trackId}-init`)) keys.push({ key: `${trackId}-init`, offset: 0, size: meta.initEnd });
      const total = Math.min(count, (meta.fragments || []).length);
      for (let i = 0; i < total; i += 1) {
        const fragment = meta.fragments[i];
        const key = `${trackId}-${i}`;
        if (!cache.has(key)) keys.push({ key, offset: fragment.offset, size: fragment.size });
      }

      let fetched = 0;
      for (const item of keys) {
        // Bail out if playback moved on while we were downloading.
        if (_isShuttingDown || currentTrackId.value !== trackAtStart) break;
        markPending(item.key);
        try {
          cachePut(item.key, await fetchRange(url, item.offset, item.offset + item.size - 1));
          fetched += 1;
        } finally {
          unmarkPending(item.key);
        }
      }
      telemetry.updateMemoryUsage(cache.totalSize);
      if (fetched) log(`warmed next track ${String(trackId).slice(0, 8)}: ${fetched} segments`);
    } catch (e) {
      if (e?.name !== 'AbortError') warn('next-track warm failed:', e.message || e);
    } finally {
      _warmInFlight.delete(trackId);
    }
  }

  /**
   * True once the current track no longer needs the bandwidth: either the reserve in front of
   * the playhead is full or the whole track is already fetched.
   */
  function nextTrackBandwidthFree() {
    if (_sequentialFetchInFlight || !_initAppended) return false;
    const currentTime = audioEl.value?.currentTime || 0;
    const remainingInTrack = trackDuration.value
      ? Math.max(trackDuration.value - currentTime, 0)
      : PREFETCH_LOOKAHEAD_SEC;
    return bufferedAheadSec(currentTime) >= Math.min(PREFETCH_LOOKAHEAD_SEC, remainingInTrack) - 0.5
      || _lastAppendedIndex + 1 >= fragmentCount.value;
  }

  const nextTrackId = computed(() => nextPlaylistTrackId());

  // Turning the loop on while sitting on the last item redefines "next" as the first track, and
  // the prefetch ticker is the only thing that warms it — a paused player never ticks, so the
  // wrap-around track would stay cold until the transition. React to the target changing instead.
  watch(nextTrackId, (id, previous) => {
    if (!id || id === previous || id === currentTrackId.value) return;
    // No element attached means nothing is loaded, so this is a fresh player, not a listener
    // waiting on the end of the playlist. Warming here would download ahead on an empty queue.
    if (!audioEl.value) return;
    // While audio is actually playing, leave it to the ticker unless the current track has
    // caught up — competing with the track being heard is how stalls happen.
    if (playing.value && !nextTrackBandwidthFree()) return;
    warmTrackFragments(id);
  });

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
          cacheRemove(`${currentTrackId.value}-${item.index}`);
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
    maybeEndStream();
  }

  /**
   * An open MediaSource never fires `ended`: the element just stalls at the end of the buffer.
   * Once the last fragment is decoded into the buffer, close the stream so playback finishes the
   * way a plain file does and the player can rely on the real event instead of a watchdog.
   */
  function maybeEndStream() {
    const sb = sourceBuffer.value;
    const ms = mediaSource.value;
    const el = audioEl.value;
    if (!sb || !ms || !el || sb.updating || ms.readyState !== 'open') return;
    if (!fragmentCount.value || _lastAppendedIndex + 1 < fragmentCount.value) return;

    const total = trackDuration.value || el.duration;
    if (!total || !Number.isFinite(total)) return;
    const buffered = el.buffered;
    if (!buffered.length || buffered.end(buffered.length - 1) < total - 0.5) return;

    try {
      ms.endOfStream();
      log('stream closed at', total.toFixed(1));
    } catch (_) {
      // An append started between the checks; the next updateend gets another turn.
    }
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

      // Nothing useful left to download for *this* track — spend the idle bandwidth on the next
      // one. Comparing against the raw lookahead alone never fires on short tracks, or near the
      // end of a long one, because the remaining audio is smaller than the reserve.
      if (nextTrackBandwidthFree()) {
        const nextId = nextPlaylistTrackId();
        if (nextId) warmTrackFragments(nextId);
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

    markPending(key);
    try {
      const fragment = fragments.value[index];
      const startedAt = performance.now();
      const buffer = await fetchRange(_audioBaseUrl, fragment.offset, fragment.offset + fragment.size - 1);
      telemetry.recordDownload(buffer.byteLength, Math.max((performance.now() - startedAt) / 1000, 0.001));
      if (currentTrackId.value === trackAtStart) {
        cachePut(key, buffer);
        telemetry.updateMemoryUsage(cache.totalSize);
      }
    } catch (e) {
      if (e?.name !== 'AbortError') warn(`prefetch ${index} failed:`, e.message || e);
    } finally {
      unmarkPending(key);
    }
  }

  // ── Playback control ───────────────────────────────────────────

  async function play() {
    if (!audioEl.value) { warn('play: no audio element'); return; }
    try {
      await audioEl.value.play();
      playing.value = true;
      // A later successful play is the proof the old failure (usually an autoplay block) no
      // longer applies; leaving it set keeps the error/unlock overlay up over working playback.
      error.value = null;
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

  /**
   * `maybeEndStream()` closes the MediaSource so the element fires a real `ended`. A seek back
   * into (or forward inside) the track must reopen it first: appending to an 'ended' MediaSource
   * throws InvalidStateError, which would silently strand the playhead. Assigning `duration` is
   * the spec'd way to move readyState from 'ended' back to 'open'.
   */
  function reopenIfEnded(seconds) {
    const ms = mediaSource.value;
    if (!ms || ms.readyState !== 'ended') return;
    const total = trackDuration.value || audioEl.value?.duration || 0;
    if (total && seconds < total - 0.25) {
      try {
        ms.duration = total;
        log('MediaSource reopened for seek to', seconds.toFixed(2));
      } catch (e) {
        warn('failed to reopen MediaSource:', e.message || e);
      }
    }
  }

  /** Seeking may land on a fragment we never fetched, so kick the pipeline from there. */
  function seek(seconds) {
    const el = audioEl.value;
    if (!el) return;
    const total = trackDuration.value || el.duration || 0;
    // Never park the playhead on the last frame: that is the region a closing stream owns, and
    // it reads as "unbuffered" a moment later, which used to re-append the final fragment.
    const target = total > 0 ? Math.min(Math.max(seconds, 0), Math.max(0, total - 0.05)) : Math.max(seconds, 0);
    reopenIfEnded(target);
    el.currentTime = target;

    const index = fragmentIndexForTime(target);
    const tailAppended = fragmentCount.value > 0 && _lastAppendedIndex >= fragmentCount.value - 1;
    if (target >= total - 0.25 && (isTimeBuffered(target) || tailAppended)) {
      log(`seek ${target.toFixed(2)}s → track end, nothing to fetch`);
      return;
    }
    if (index > _lastAppendedIndex || !isTimeBuffered(target)) {
      _lastAppendedIndex = Math.min(_lastAppendedIndex, index - 1);
      log(`seek ${target.toFixed(2)}s → fragment ${index}, appending from ${_lastAppendedIndex + 1}`);
      fetchFragmentInSequence(index);
    } else {
      log(`seek ${target.toFixed(2)}s → fragment ${index} already buffered`);
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

  /**
   * Snapshot the element's TimeRanges into plain objects.
   *
   * `HTMLMediaElement.buffered` is a single mutable object, so assigning it to a ref never
   * changes identity and Vue would keep rendering the first snapshot forever — which is why
   * the cached-region indicators used to look frozen.
   */
  function updateBufferedRanges() {
    const buffered = audioEl.value?.buffered;
    if (buffered) {
      const spans = [];
      for (let i = 0; i < buffered.length; i += 1) spans.push({ start: buffered.start(i), end: buffered.end(i) });
      const changed = spans.length !== bufferedRanges.value.length
        || spans.some((span, i) => span.start !== bufferedRanges.value[i].start || span.end !== bufferedRanges.value[i].end);
      if (changed) bufferedRanges.value = spans;

      if (trackDuration.value) {
        let seconds = 0;
        for (const span of spans) seconds += span.end - span.start;
        loadProgress.value = Math.min(seconds / trackDuration.value, 1);
      }
    } else if (bufferedRanges.value.length) {
      bufferedRanges.value = [];
    }
  }

  // The audio element outlives a track change, so the listeners must be attached once —
  // rebinding on every loadTrack stacks duplicate handlers for the life of the page.
  const _boundElements = new WeakSet();

  function bindAudioEvents() {
    const el = audioEl.value;
    if (!el || _isShuttingDown) return;
    if (_boundElements.has(el)) return;
    _boundElements.add(el);
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
      cacheRemove(entry.key);
    }
    telemetry.updateMemoryUsage(cache.totalSize);
  }

  function setSpeedCap(bytesPerSec) {
    _speedCapBytesPerSec = bytesPerSec || 0;
  }

  return {
    playing, bufferedRanges, error, mseSupported, loadProgress, currentTrackId,
    trackDuration, playlist, loopRegion, repeatMode, cacheSize, pendingCount,
    cachedChunkCount, cachedKeys, pendingKeys, chunkRows, warmedTracks, cacheCoverage, cachedSpans,
    fragments, fragmentCount, needsFallback,
    initMediaSource, shutdown, loadTrack, play, pause, togglePlayPause, seek, setVolume,
    getCurrentTime, bindAudioEvents, updateBufferedRanges, setCacheLimit, setSpeedCap,
    setRepeatMode, setPlaylistLoop, playlistLoop,
    warmTrackFragments, nextPlaylistTrackId, nextTrackId,
  };
}
