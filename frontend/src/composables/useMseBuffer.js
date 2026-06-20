/**
 * useMseBuffer — MediaSource Extensions (MSE) audio buffer manager with caching and prefetching.
 * 
 * Fetches 30s M4A/AAC chunks via HTTP Range requests, manages an in-memory cache,
 * and uses prediction logic to prefetch upcoming segments for seamless playback.
 */

import { ref, computed } from 'vue';
import { ChunkCache, predictNextChunks, CHUNK_DURATION } from '../services/chunkCache.js';
import { telemetry } from '../composables/useTelemetry.js';

// ─── Constants ───────────────────────────────────────────────────────

const AAC_MIME_TYPE = 'audio/mp4; codecs="mp4a.40.2"';
const INIT_RETRY_DELAY = 150;

// ─── Helpers ─────────────────────────────────────────────────────────

function isMseAacSupported() {
  return typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported(AAC_MIME_TYPE);
}

function calculateChunkByteRange(chunkIndex, totalChunks, fileSize) {
  const bytesPerChunk = Math.floor(fileSize / totalChunks);
  const start = chunkIndex * bytesPerChunk;
  const end = chunkIndex === totalChunks - 1
    ? fileSize - 1
    : start + bytesPerChunk - 1;
  return { start, end: Math.min(end, fileSize - 1) };
}

async function fetchChunk(baseUrl, startByte, endByte) {
  const response = await fetch(baseUrl, {
    headers: { 'Range': `bytes=${startByte}-${endByte}` },
  });
  if (response.status === 416) throw new Error('Range not satisfiable');
  if (!response.ok || response.status !== 206) throw new Error(`Fetch failed: ${response.status}`);
  return response.arrayBuffer();
}

// ─── Composable ──────────────────────────────────────────────────────

export function useMseBuffer() {
  const cache = new ChunkCache(50 * 1024 * 1024); // 50MB default budget

  // ── Internal State ─────────────────────────────────────────────

  /** @type {{ value: HTMLAudioElement | null }} */
  const audioEl = ref(null);
  /** @type {{ value: MediaSource | null }} */
  const mediaSource = ref(null);
  /** @type {{ value: SourceBuffer | null }} */
  const sourceBuffer = ref(null);

  const currentTrackId = ref(null);
  const trackDuration = ref(0);
  const fileSize = ref(0);
  const playlist = ref([]); 
  const loopRegion = ref(null); // { startSec, endSec }
  const repeatMode = ref('none');

  const playing = ref(false);
  const bufferedRanges = ref(null);
  const error = ref(null);
  const mseSupported = ref(isMseAacSupported());
  const loadProgress = ref(0); 

  let _fetchedChunksCount = 0;
  let _abortController = null;
  let _isShuttingDown = false;
  let _prefetchInterval = null;
  let _audioBaseUrl = '';
  let _stallDetectionInterval = null;

  // ── Core Lifecycle ─────────────────────────────────────────────

  function initMediaSource(el) {
    if (_isShuttingDown) return;
    shutdown();
    const ms = new MediaSource();
    mediaSource.value = ms;
    el.src = URL.createObjectURL(ms);

    ms.addEventListener('sourceopen', async () => {
      try {
        const sb = ms.addSourceBuffer(AAC_MIME_TYPE);
        sourceBuffer.value = sb;
        sb.addEventListener('updateend', () => {
          if (!_isShuttingDown && currentTrackId.value) {
            updateBufferedRanges();
            _onSourceBufferUpdateEnd();
          }
        });
      } catch (err) {
        error.value = err;
      }
    });

    startStallDetection();
  }

  function startStallDetection() {
    if (_stallDetectionInterval) clearInterval(_stallDetectionInterval);
    _stallDetectionInterval = setInterval(() => {
      const el = audioEl.value;
      if (playing.value && el) {
        const buffered = el.buffered;
        if (buffered.length > 0) {
          const lastBufferedEnd = buffered.end(buffered.length - 1);
          if (el.currentTime >= lastBufferedEnd - 0.5 && el.currentTime < el.duration - 0.1) {
             telemetry.recordStallStart();
          } else if (el.currentTime < lastBufferedEnd - 0.2) {
             telemetry.recordStallEnd();
          }
        }
      }
    }, 1000);
  }

  function shutdown() {
    if (_stallDetectionInterval) clearInterval(_stallDetectionInterval);
    if (_isShuttingDown) return;
    _isShuttingDown = true;
    
    if (_prefetchInterval) clearInterval(_prefetchInterval);
    if (_abortController) _abortController.abort();

    sourceBuffer.value = null;
    if (mediaSource.value && mediaSource.value.readyState === 'open') {
      try { mediaSource.value.endOfStream(); } catch (_) {}
    }
    if (audioEl.value && audioEl.value.src.startsWith('blob:')) {
      URL.revokeObjectURL(audioEl.value.src);
      audioEl.value.removeAttribute('src');
      audioEl.value.load();
    }

    mediaSource.value = null;
    currentTrackId.value = null;
    trackDuration.value = 0;
    fileSize.value = 0;
    playlist.value = [];
    loopRegion.value = null;
    repeatMode.value = 'none';
    playing.value = false;
    error.value = null;
    bufferedRanges.value = null;
    _isShuttingDown = false;
  }

  async function loadTrack(trackId, audioBaseUrl, audioElRef, duration) {
    shutdown();
    currentTrackId.value = trackId;
    _audioBaseUrl = audioBaseUrl;
    error.value = null;

    initMediaSource(audioElRef);
    await waitForSourceOpen();

    if (!sourceBuffer.value || error.value) return;

    try {
      const headResp = await fetch(audioBaseUrl, { method: 'HEAD' });
      fileSize.value = parseInt(headResp.headers.get('Content-Length') || '0', 10);
      trackDuration.value = duration || parseFloat(headResp.headers.get('X-Track-Duration')) || 0;

      _startPrefetching();
      await _fetchNextChunkInSequence(0);
    } catch (err) {
      error.value = err;
    }
  }

  function waitForSourceOpen() {
    return new Promise((resolve, reject) => {
      const onOpen = () => {
        if (mediaSource.value?.readyState === 'open') {
          mediaSource.value.removeEventListener('sourceopen', onOpen);
          resolve();
        }
      };
      mediaSource.value?.addEventListener('sourceopen', onOpen);
      setTimeout(() => reject(new Error('MediaSource timeout')), 5000);
    });
  }

  // ── Chunk Pipeline (Sequential for playback) ─────────────────────

  async function _fetchNextChunkInSequence(index) {
    if (_isShuttingDown || !currentTrackId.value || index >= Math.ceil(trackDuration.value / CHUNK_DURATION)) return;
    if (_abortController?.signal.aborted) return;

    const cacheKey = `${currentTrackId.value}-${index}`;
    const cachedBuffer = cache.get(cacheKey);
    if (cachedBuffer) {
      await _appendToSourceBuffer(index, cachedBuffer);
      return;
    }

    try {
      const range = calculateChunkByteRange(index, Math.ceil(trackDuration.value / CHUNK_DURATION), fileSize.value);
      cache.markPending(cacheKey); 
      const startTime = performance.now();
      const buffer = await fetchChunk(_audioBaseUrl, range.start, range.end);
      const endTime = performance.now();

      telemetry.recordDownload(buffer.byteLength, (endTime - startTime) / 1000);
      cache.put(cacheKey, buffer);
      telemetry.updateMemoryUsage(cache.totalSize);

      await _appendToSourceBuffer(index, buffer);
    } catch (err) {
      console.error(`[MSE] Chunk ${index} fetch error:`, err);
      setTimeout(() => _fetchNextChunkInSequence(index), INIT_RETRY_DELAY);
    }
  }

  async function _appendToSourceBuffer(index, buffer) {
    if (sourceBuffer.value && !sourceBuffer.value.updating) {
      const currentIdx = Math.floor((audioEl.value?.currentTime || 0) / CHUNK_DURATION);
      if (index < currentIdx) return; 

      try {
        sourceBuffer.value.appendBuffer(buffer);
      } catch (e) {
        console.error('[MSE] Append error:', e);
        cache.remove(`${currentTrackId.value}-${index}`);
      }
    } else if (sourceBuffer.value?.updating) {
      sourceBuffer.value._pendingChunk = index;
    }
  }

  function _onSourceBufferUpdateEnd() {
    if (_isShuttingDown || !currentTrackId.value) return;
    const sb = sourceBuffer.value;
    
    if (sb && sb._pendingChunk !== undefined) {
      const idx = sb._pendingChunk;
      delete sb._pendingChunk;
      _fetchNextChunkInSequence(idx);
      return;
    }

    const playheadSec = audioEl.value?.currentTime || 0;
    const nextIdx = Math.floor(playheadSec / CHUNK_DURATION) + 1;
    _fetchNextChunkInSequence(nextIdx);
  }

  // ── Prefetching (Background) ─────────────────────────────────────

  function _startPrefetching() {
    if (_prefetchInterval) clearInterval(_prefetchInterval);
    _prefetchInterval = setInterval(async () => {
      if (!currentTrackId.value || isBuffering()) return;

      const predicted = predictNextChunks({
        currentTrackIndex: 0, 
        currentTimeInSeconds: audioEl.value?.currentTime || 0,
        playlist: playlist.value,
      }, {
        loopRegion: loopRegion.value,
        repeatMode: repeatMode.value
      });

      for (const { trackIndex, chunkIndex } of predicted) {
        if (trackIndex === 0 && !cache.has(`${currentTrackId.value}-${chunkIndex}`)) {
          _prefetchChunk(currentTrackId.value, chunkIndex);
        }
      }
    }, 5000);
  }

  async function _prefetchChunk(targetTrackId, chunkIdx) {
    if (cache.has(`${targetTrackId}-${chunkIdx}`)) return;
    try {
      const range = calculateChunkByteRange(chunkIdx, Math.ceil(trackDuration.value / CHUNK_DURATION), fileSize.value);
      cache.markPending(`${targetTrackId}-${chunkIdx}`);
      const startTime = performance.now();
      const buffer = await fetchChunk(_audioBaseUrl, range.start, range.end);
      const endTime = performance.now();

      telemetry.recordDownload(buffer.byteLength, (endTime - startTime) / 1000);
      cache.put(`${targetTrackId}-${chunkIdx}`, buffer);
      telemetry.updateMemoryUsage(cache.totalSize);
    } catch (err) {
      console.warn(`[Prefetch] Chunk ${chunkIdx} failed:`, err);
    } finally {
      cache.unmarkPending(`${targetTrackId}-${chunkIdx}`);
    }
  }

  function isBuffering() { return !audioEl.value?.paused; }

  // ── Playback Control ─────────────────────────────────────────────

  async function play() {
    if (!audioEl.value) return;
    try { await audioEl.value.play(); playing.value = true; } catch (err) { error.value = err; }
  }

  function pause() {
    audioEl.value?.pause();
    playing.value = false;
  }

  async function togglePlayPause() {
    if (playing.value) pause(); else await play();
  }

  function seek(seconds) { audioEl.value && (audioEl.value.currentTime = seconds); }
  function setVolume(vol) { audioEl.value && (audioEl.value.volume = vol); }
  function getCurrentTime() { return audioEl.value?.currentTime || 0; }

  function updateBufferedRanges() { bufferedRanges.value = audioEl.value?.buffered ?? null; }

  function bindAudioEvents() {
    const el = audioEl.value;
    if (!el) return;
    el.addEventListener('play', () => playing.value = true);
    el.addEventListener('pause', () => playing.value = false);
    el.addEventListener('ended', () => playing.value = false);
  }

  return {
    playing, bufferedRanges, error, mseSupported, loadProgress, currentTrackId,
    trackDuration, playlist, loopRegion, repeatMode,
    initMediaSource, shutdown, loadTrack, play, pause, togglePlayPause, seek, setVolume, getCurrentTime, bindAudioEvents
  };
}
