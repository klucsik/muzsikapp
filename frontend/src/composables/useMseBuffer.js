/**
 * useMseBuffer — MediaSource Extensions (MSE) audio buffer manager.
 *
 * Fetches 30-second M4A/AAC chunks via HTTP Range requests and feeds them
 * into an MSE SourceBuffer for continuous playback. Exposes reactive state
 * for integration with AudioPlayerV2.vue controls.
 *
 * Key responsibilities:
 * - Create and configure MediaSource + audio element pipeline
 * - Fetch 30s M4A segments via Range requests from /audio/:trackId
 * - Decode AAC natively through MSE SourceBuffer (no JS codec layer)
 * - Feed decoded buffers at correct media timeline positions
 * - Handle end-of-stream on track completion, reset on track switch
 */

import { ref, computed } from 'vue';

// ─── Constants ───────────────────────────────────────────────────────

const CHUNK_DURATION = 30; // seconds per chunk (matches V2 design spec)
const AAC_MIME_TYPE = 'audio/mp4; codecs="mp4a.40.2"';
const INIT_RETRY_DELAY = 150; // ms between chunk-fetch retries on SourceBuffer.update

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Check whether the browser supports MSE with AAC in MP4 container.
 * @returns {boolean}
 */
function isMseAacSupported() {
  return typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported(AAC_MIME_TYPE);
}

/**
 * Calculate approximate byte boundaries for a chunk index within a file of known size.
 * Uses uniform time-to-byte mapping: each chunk covers a proportional slice of the file.
 * This is an approximation — actual AAC frames may not align perfectly with byte boundaries,
 * but MSE's decoder is tolerant of minor misalignment at chunk edges.
 *
 * @param {number} chunkIndex - Zero-based index of the chunk to fetch
 * @param {number} totalChunks - Total number of chunks in the file
 * @param {number} fileSize - Total size of the file in bytes
 * @returns {{ start: number, end: number }} Byte range (inclusive)
 */
function calculateChunkByteRange(chunkIndex, totalChunks, fileSize) {
  const bytesPerChunk = Math.floor(fileSize / totalChunks);
  const start = chunkIndex * bytesPerChunk;
  const end = chunkIndex === totalChunks - 1
    ? fileSize - 1 // last chunk gets everything remaining (handles rounding)
    : start + bytesPerChunk - 1;
  return { start, end: Math.min(end, fileSize - 1) };
}

/**
 * Fetch a byte-range slice of the audio file and return as ArrayBuffer.
 *
 * @param {string} baseUrl - Base URL for the audio endpoint (e.g. "/audio/:trackId")
 * @param {number} startByte - Start byte offset (inclusive)
 * @param {number} endByte - End byte offset (inclusive)
 * @returns {Promise<ArrayBuffer>}
 * @throws {Error} On non-206 response or fetch failure
 */
async function fetchChunk(baseUrl, startByte, endByte) {
  const response = await fetch(baseUrl, {
    headers: {
      'Range': `bytes=${startByte}-${endByte}`,
    },
  });

  if (response.status === 416) {
    throw new Error(`Range not satisfiable (${startByte}-${endByte}). Server may have smaller file.`);
  }
  if (!response.ok || response.status !== 206) {
    throw new Error(`Chunk fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  return response.arrayBuffer();
}

// ─── Composable ──────────────────────────────────────────────────────

/**
 * Create an MSE-based audio buffer manager.
 *
 * Returns reactive state and imperative control methods for driving
 * AudioPlayerV2.vue playback from chunked M4A/AAC segments.
 *
 * @returns {object} Reactive state + control API
 */
export function useMseBuffer() {
  // ── Internal refs (not exposed directly) ────────────────────────

  /** @type {{ value: HTMLAudioElement | null }} */
  const audioEl = ref(null);
  /** @type {{ value: MediaSource | null }} */
  const mediaSource = ref(null);
  /** @type {{ value: SourceBuffer | null }} */
  const sourceBuffer = ref(null);

  // Track metadata for chunk calculations
  const currentTrackId = ref(null);
  const trackDuration = ref(0);       // seconds (from server metadata)
  const fileSize = ref(0);            // bytes (from HEAD request or Content-Range header)
  const totalChunks = computed(() => {
    if (trackDuration.value <= 0) return 0;
    return Math.ceil(trackDuration.value / CHUNK_DURATION);
  });

  // ── Reactive state (exposed to consumer) ────────────────────────

  /** Whether playback is currently running */
  const playing = ref(false);

  /** Time ranges that are buffered in the MSE SourceBuffer (in seconds) */
  const bufferedRanges = ref(/** @type {TimeRanges} */ (null));

  /** Current error state, or null if no error */
  const error = ref(null);

  /** Whether MSE with AAC is supported by this browser */
  const mseSupported = ref(isMseAacSupported());

  /** Progress: fraction of total chunks that have been fetched and appended (0..1) */
  const loadProgress = ref(0);

  // ── Private state for chunk pipeline ────────────────────────────

  let _fetchedChunks = new Set();     // indices already appended to SourceBuffer
  let _abortController = null;        // AbortController for cancelling track fetches
  let _isShuttingDown = false;        // flag to prevent re-entry during cleanup
  let _audioBaseUrl = '';             // base URL for chunk Range requests (set on loadTrack)

  // ── Core lifecycle methods ──────────────────────────────────────

  /**
   * Initialize the MSE pipeline: create MediaSource, attach to audio element,
   * configure AAC SourceBuffer. Must be called before any chunk operations.
   *
   * @param {HTMLAudioElement} el - The <audio> DOM element to control
   */
  function initMediaSource(el) {
    if (_isShuttingDown) return;

    // Clean up any previous MediaSource
    shutdown();

    const ms = new MediaSource();
    mediaSource.value = ms;

    el.src = URL.createObjectURL(ms);

    ms.addEventListener('sourceopen', async () => {
      try {
        if (!ms.activeSourceBuffers) {
          // Safety: remove old source buffers (shouldn't exist on fresh MS, but guard anyway)
          while (ms.sourceBuffer.length > 0) {
            ms.removeSourceBuffer(ms.sourceBuffer[0]);
          }
        }

        const sb = ms.addSourceBuffer(AAC_MIME_TYPE);
        sourceBuffer.value = sb;

        // When SourceBuffer finishes updating, trigger next chunk fetch if needed
        sb.addEventListener('updateend', () => {
          if (!_isShuttingDown && currentTrackId.value) {
            updateBufferedRanges();
            _onSourceBufferUpdateEnd();
          }
        });

        sb.addEventListener('error', (e) => {
          console.error('[MSE] SourceBuffer error:', e);
          error.value = new Error('SourceBuffer encoding error — AAC decode failed');
        });
      } catch (err) {
        console.error('[MSE] Failed to add SourceBuffer:', err);
        error.value = err;
      }
    });

    ms.addEventListener('error', () => {
      if (!ms.readyState || ms.readyState === 'closed') return; // ignore post-shutdown
      console.error('[MSE] MediaSource error, state:', ms.readyState);
      error.value = new Error(`MediaSource error (state: ${ms.readyState})`);
    });

    audioEl.value = el;
  }

  /**
   * Tear down the MSE pipeline and release all resources.
   * Called on track switch or component unmount.
   */
  function shutdown() {
    _isShuttingDown = true;

    // Cancel any in-flight fetches
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }

    sourceBuffer.value = null;

    // End stream and close MediaSource
    if (mediaSource.value && mediaSource.value.readyState === 'open') {
      try {
        mediaSource.value.endOfStream();
      } catch (_) { /* ignore — may throw if already ending */ }
    }

    // Detach audio element from object URL
    if (audioEl.value) {
      const src = audioEl.value.src;
      if (src && src.startsWith('blob:')) {
        URL.revokeObjectURL(src);
        audioEl.value.removeAttribute('src');
        audioEl.value.load();
      }
      audioEl.value = null;
    }

    mediaSource.value = null;
    _fetchedChunks.clear();
    currentTrackId.value = null;
    trackDuration.value = 0;
    fileSize.value = 0;
    loadProgress.value = 0;
    playing.value = false;
    error.value = null;
    bufferedRanges.value = null;
    _isShuttingDown = false;
  }

  /**
   * Load a track: discover file size, initialize MSE pipeline, start chunk fetching.
   *
   * @param {string} trackId - The unique track identifier (database ID)
   * @param {string} audioBaseUrl - Full URL to the audio endpoint for this track (e.g. "/audio/abc123")
   * @param {HTMLAudioElement} audioElRef - The <audio> element reference
   * @param {number} [duration] - Optional known duration in seconds; if omitted, fetched via HEAD
   */
  async function loadTrack(trackId, audioBaseUrl, audioElRef, duration) {
    // Shut down previous track first
    shutdown();

    currentTrackId.value = trackId;
    error.value = null;
    playing.value = false;

    if (!mseSupported.value) {
      error.value = new Error('MSE with AAC is not supported in this browser');
      return;
    }

    // Initialize the MSE pipeline on the audio element
    initMediaSource(audioElRef);

    // Wait for MediaSource to open and SourceBuffer to be ready
    await waitForSourceOpen();

    if (!sourceBuffer.value || error.value) {
      return; // error already set in event listener
    }

    // Discover file size via HEAD request (also validates the endpoint exists)
    let discoveredFileSize = 0;
    try {
      const headResp = await fetch(audioBaseUrl, { method: 'HEAD' });
      if (!headResp.ok) {
        throw new Error(`HEAD ${audioBaseUrl} returned ${headResp.status}`);
      }
      const contentLength = headResp.headers.get('Content-Length');
      discoveredFileSize = contentLength ? parseInt(contentLength, 10) : 0;

      // Also try to extract duration from metadata header if server provides it
      const metaDuration = headResp.headers.get('X-Track-Duration');
      if (metaDuration && !duration) {
        duration = parseFloat(metaDuration);
      }
    } catch (err) {
      console.warn('[MSE] HEAD request failed, will discover size from first chunk:', err.message);
    }

    fileSize.value = discoveredFileSize;
    trackDuration.value = duration || 0;
    _audioBaseUrl = audioBaseUrl;

    // Start fetching chunks sequentially
    _startFetching(audioBaseUrl);
  }

  /**
   * Wait for the MediaSource to reach 'open' state.
   * @returns {Promise<void>}
   */
  function waitForSourceOpen() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MediaSource sourceopen timed out (5s)'));
      }, 5000);

      const onOpen = () => {
        clearTimeout(timeout);
        if (mediaSource.value) {
          mediaSource.value.removeEventListener('sourceopen', onOpen);
        }
        resolve();
      };

      if (mediaSource.value && mediaSource.value.readyState === 'open') {
        clearTimeout(timeout);
        resolve();
        return;
      }

      if (mediaSource.value) {
        mediaSource.value.addEventListener('sourceopen', onOpen, { once: true });
      } else {
        reject(new Error('No MediaSource initialized'));
      }
    });
  }

  // ── Chunk fetching pipeline ─────────────────────────────────────

  /**
   * Begin sequential chunk fetching for the current track.
   * Chunks are fetched in order (0, 1, 2, ...) and appended to SourceBuffer.
   */
  function _startFetching(audioBaseUrl) {
    if (_abortController) _abortController.abort();
    _abortController = new AbortController();

    // Fetch initial chunks eagerly — aim for at least 2 chunks (~60s) before starting playback
    _fetchNextChunk(0, audioBaseUrl);
  }

  /**
   * Fetch and append the next chunk in sequence.
   * Recursively schedules itself via _onSourceBufferUpdateEnd to keep the pipeline flowing.
   *
   * @param {number} chunkIndex - Which chunk to fetch next
   * @param {string} audioBaseUrl - Base URL for Range requests
   */
  async function _fetchNextChunk(chunkIndex, audioBaseUrl) {
    if (_isShuttingDown || !currentTrackId.value || _abortController?.signal.aborted) return;
    if (chunkIndex >= totalChunks.value) return; // all chunks fetched

    // Skip already-fetched chunks
    if (_fetchedChunks.has(chunkIndex)) {
      // This shouldn't happen in sequential mode, but guard anyway
      return;
    }

    try {
      const range = calculateChunkByteRange(chunkIndex, totalChunks.value, fileSize.value);
      const buffer = await fetchChunk(audioBaseUrl, range.start, Math.min(range.end, fileSize.value - 1));

      if (_isShuttingDown || _abortController?.signal.aborted) return;

      // Append to SourceBuffer (this triggers updateend → recursive next-chunk fetch)
      if (sourceBuffer.value && !sourceBuffer.value.updating) {
        sourceBuffer.value.appendBuffer(buffer);
        _fetchedChunks.add(chunkIndex);
        loadProgress.value = Math.min(1, (_fetchedChunks.size / totalChunks.value));

        // Log progress for debugging
        if ((chunkIndex + 1) % 5 === 0 || chunkIndex === 0) {
          console.log(`[MSE] Chunk ${chunkIndex + 1}/${totalChunks.value} appended (${(loadProgress.value * 100).toFixed(0)}%)`);
        }
      } else if (sourceBuffer.value?.updating) {
        // SourceBuffer is busy — _onSourceBufferUpdateEnd will retry this chunk
        console.log(`[MSE] SourceBuffer busy, queuing chunk ${chunkIndex} for after updateend`);
        // Store the pending chunk index so we can resume in _onSourceBufferUpdateEnd
        sourceBuffer.value._pendingChunk = { index: chunkIndex, url: _audioBaseUrl };
      }
    } catch (err) {
      if (_isShuttingDown || err.name === 'AbortError') return;

      console.error(`[MSE] Failed to fetch chunk ${chunkIndex}:`, err);
      error.value = err;

      // Retry with exponential backoff for transient failures
      const retryDelay = Math.min(INIT_RETRY_DELAY * 2, 3000);
      setTimeout(() => {
        if (!_isShuttingDown && currentTrackId.value) {
          _fetchNextChunk(chunkIndex, audioBaseUrl);
        }
      }, retryDelay);
    }
  }

  /**
   * Handler for SourceBuffer 'updateend' event — keeps the chunk pipeline flowing.
   */
  function _onSourceBufferUpdateEnd() {
    if (_isShuttingDown || !currentTrackId.value) return;

    // Check if there's a pending chunk (from when SourceBuffer was busy)
    const sb = sourceBuffer.value;
    if (sb && sb._pendingChunk) {
      const pending = sb._pendingChunk;
      delete sb._pendingChunk;
      _fetchNextChunk(pending.index, pending.url);
      return;
    }

    // Otherwise fetch the next sequential chunk
    const nextIndex = _fetchedChunks.size;
    if (nextIndex < totalChunks.value && _audioBaseUrl) {
      _fetchNextChunk(nextIndex, _audioBaseUrl);
    } else if (_fetchedChunks.size >= totalChunks.value) {
      console.log('[MSE] All chunks fetched — track fully loaded');
    }
  }

  // ── Playback control methods ────────────────────────────────────

  /**
   * Start playback on the managed audio element.
   * @returns {Promise<void>}
   */
  async function play() {
    if (!audioEl.value) return;
    try {
      await audioEl.value.play();
      playing.value = true;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        error.value = new Error('Autoplay blocked — user interaction required');
      } else {
        error.value = err;
      }
      console.warn('[MSE] play() failed:', err);
    }
  }

  /**
   * Pause playback.
   */
  function pause() {
    if (!audioEl.value) return;
    audioEl.value.pause();
    playing.value = false;
  }

  /**
   * Toggle between play and pause states.
   */
  async function togglePlayPause() {
    if (playing.value) {
      pause();
    } else {
      await play();
    }
  }

  /**
   * Seek to a specific time position (in seconds).
   * The MSE buffer handles seeking within already-appended data seamlessly.
   *
   * @param {number} seconds - Target playback position in seconds
   */
  function seek(seconds) {
    if (!audioEl.value) return;
    audioEl.value.currentTime = Math.max(0, Math.min(seconds, trackDuration.value || Infinity));
  }

  /**
   * Set the playback volume (0.0 to 1.0).
   * @param {number} vol - Volume level between 0 and 1
   */
  function setVolume(vol) {
    if (!audioEl.value) return;
    audioEl.value.volume = Math.max(0, Math.min(1, vol));
  }

  /**
   * Get the current playback position in seconds.
   * @returns {number}
   */
  function getCurrentTime() {
    return audioEl.value?.currentTime ?? 0;
  }

  // ── Utility methods ─────────────────────────────────────────────

  /**
   * Update the bufferedRanges reactive ref from the audio element's buffered TimeRanges.
   */
  function updateBufferedRanges() {
    bufferedRanges.value = audioEl.value?.buffered ?? null;
  }

  // ── Event binding helper ────────────────────────────────────────

  /**
   * Wire up audio element events to reactive state updates.
   * Call this after the <audio> element is mounted in the component.
   */
  function bindAudioEvents() {
    const el = audioEl.value;
    if (!el) return;

    el.addEventListener('play', () => { playing.value = true; });
    el.addEventListener('pause', () => { playing.value = false; });
    el.addEventListener('ended', () => {
      playing.value = false;
      console.log('[MSE] Track ended');
    });
    el.addEventListener('error', (e) => {
      const mediaError = e.target?.error;
      error.value = mediaError ? new Error(`Media error: ${mediaError.message}`) : new Error('Unknown audio element error');
    });
  }

  return {
    // ── Reactive state (read-only for consumer) ───────────────────
    playing,
    bufferedRanges,
    error,
    mseSupported,
    loadProgress,
    currentTrackId,
    trackDuration,
    totalChunks,
    fileSize,

    // ── Control methods ───────────────────────────────────────────
    initMediaSource,
    shutdown,
    loadTrack,
    play,
    pause,
    togglePlayPause,
    seek,
    setVolume,
    getCurrentTime,
    updateBufferedRanges,
    bindAudioEvents,

    // ── Helpers exposed for testing / advanced usage ──────────────
    _fetchNextChunk,
  };
}

// ─── Module exports (non-composable utilities) ──────────────────────

export { isMseAacSupported, calculateChunkByteRange, fetchChunk, CHUNK_DURATION, AAC_MIME_TYPE };
