<template>
  <div class="audio-player">
    <!-- Audio Unlock Overlay -->
    <div v-if="needsAudioUnlock" class="audio-unlock-overlay" @click="unlockAudio">
      <div class="unlock-content">
        <div class="unlock-icon">🔊</div>
        <h3>Click to Enable Audio</h3>
        <p>Browser requires user interaction to play audio</p>
      </div>
    </div>

    <!-- Buffering / Loading Overlay -->
    <div v-if="isBuffering" class="buffer-overlay">
      <div class="spinner"></div>
      <p>{{ bufferMessage }}</p>
    </div>

    <!-- Error Overlay -->
    <div v-if="mseError && !isBuffering" class="error-overlay">
      <div class="error-content">
        <div class="error-icon">⚠️</div>
        <h3>Playback Error</h3>
        <p>{{ mseError.message }}</p>
        <button @click="retryPlayback" class="retry-btn">Retry</button>
      </div>
    </div>

    <!-- Now Playing Info -->
    <div class="now-playing">
      <div class="track-info">
        <h2 v-if="currentTrack">{{ currentTrack.title }}</h2>
        <h2 v-else class="no-track">No track playing</h2>
        <p v-if="currentTrack" class="artist">{{ currentTrack.artist || 'Unknown Artist' }}</p>
      </div>
      <!-- Room connection + drift, the same read-out V1 offers -->
      <div class="sync-status" :class="{ connected: isConnected, disconnected: !isConnected }">
        <div class="status-line">
          <span class="status-dot"></span>
          {{ isConnected ? 'Connected' : 'Disconnected' }}
        </div>
        <div v-if="drift !== null" class="drift-line" :class="{ 'drift-warning': drift > 5 }">
          Drift: {{ drift.toFixed(2) }}s
        </div>
      </div>
    </div>

    <!-- Hidden audio element managed by MSE. `ended` is what advances the playlist: the
         server only moves on after a client reports the track finished (V1 does the same). -->
    <audio ref="audioElement" preload="none" @ended="onEnded" @error="onMediaError"></audio>

    <!-- Player Controls -->
    <div class="player-controls">
      <!-- Progress Bar with Cached Regions -->
      <div ref="progressBarEl" class="progress-bar" @dblclick="seekToPosition">
        <!-- Green fill for played content -->
        <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>

        <!-- Grey blocks for cached/buffered regions ahead of playhead -->
        <template v-if="cachedBlocks.length > 0">
          <div
            v-for="(block, i) in heldBlocks"
            :key="'h' + i"
            class="cached-block held"
            :style="{ left: block.start + '%', width: block.width + '%' }"
          ></div>
          <div
            v-for="(block, i) in cachedBlocks"
            :key="'b' + i"
            class="cached-block"
            :style="{ left: block.start + '%', width: block.width + '%' }"
          ></div>
        </template>

        <!-- Progress handle at playhead position -->
        <div class="progress-handle" :style="{ left: progressPercent + '%' }"></div>

        <!-- Loop region markers, dragged to trim the repeated section (same affordance as V1) -->
        <template v-if="showLoopMarkers">
          <div
            class="loop-region"
            :style="{ left: loopStartPercent + '%', width: (loopEndPercent - loopStartPercent) + '%' }"
          ></div>
          <div
            class="loop-marker loop-start"
            :style="{ left: loopStartPercent + '%' }"
            title="Loop start - drag to adjust"
            @mousedown="startDragLoopStart"
          >
            <div class="loop-marker-label">{{ formatTime(loopStart) }}</div>
            <div class="loop-marker-handle">⟨</div>
          </div>
          <div
            class="loop-marker loop-end"
            :style="{ left: loopEndPercent + '%' }"
            title="Loop end - drag to adjust"
            @mousedown="startDragLoopEnd"
          >
            <div class="loop-marker-label">{{ formatTime(loopEnd) }}</div>
            <div class="loop-marker-handle">⟩</div>
          </div>
        </template>
      </div>

      <!-- Time Display -->
      <div class="time-display">
        <span class="current-time">{{ formatTime(currentTime) }}</span>
        <span class="duration">{{ formatTime(duration) }}</span>
      </div>

      <!-- Control Buttons -->
      <div class="control-buttons">
        <button
          @click="handlePreviousClick"
          class="control-btn"
          :disabled="!hasPrevious"
          title="Previous track"
        >
          ⏮️
        </button>
        <button
          @click="handlePlayPauseClick"
          class="control-btn play-pause"
          :disabled="!currentTrack"
          :title="isPlaying ? 'Pause' : 'Resume'"
        >
          {{ isPlaying ? '⏸️' : '▶️' }}
        </button>
        <button
          @click="handleNextClick"
          class="control-btn"
          :disabled="!hasNext"
          title="Next track"
        >
          ⏭️
        </button>
        <button
          @click="handleRepeatClick"
          class="control-btn"
          :class="{ active: repeatOn }"
          :title="repeatOn ? 'Repeat: On' : 'Repeat: Off'"
        >
          🔁
        </button>
      </div>

    </div>

    <!-- Volume Control -->
    <div class="volume-control">
      <span class="volume-icon">🔊</span>
      <input
        type="range"
        min="0"
        max="100"
        :value="volumeToSlider(volume)"
        @input="onVolumeChange"
        class="volume-slider"
      />
      <span class="volume-value">{{ (volume * 100).toFixed(1) }}%</span>
    </div>

    <!-- Settings & Telemetry Panel -->
    <SettingsPanel
      :cache-mode="cacheMode"
      :used-memory="telemetryData.usedMemory"
      :total-memory="telemetryData.totalMemory"
      :speed-history="telemetryData.speedHistory"
      :stall-count="telemetryData.stallCount"
      :total-stall-duration="telemetryData.totalStallDuration"
      :cached-chunks="cachedChunkCount"
      :downloading-count="mse.pendingCount.value || 0"
      @update-cache-limit="onUpdateCacheLimit"
      @update-cache-mode="onUpdateCacheMode"
      @update-speed-cap="onUpdateSpeedCap"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { planCacheBlocks, useMseBuffer, isMseAacSupported } from '../composables/useMseBuffer.js';
import { CACHE_SETTINGS_KEY, normalizeCacheMode } from '../services/cachePolicy.js';
import SettingsPanel from './SettingsPanel.vue';
import api from '../services/api';
import websocket from '../services/websocket';

// ── Logging helper ────────────────────────────────────────────────
const log = (...args) => console.log('[V2]', ...args);
const warn = (...args) => console.warn('[V2]', ...args);
const err = (...args) => console.error('[V2]', ...args);

// ── Props / Emits ────────────────────────────────────────────────

const props = defineProps({
  playlist: { type: Array, default: () => [] },
  currentTrackId: { type: String, default: null },
  hasNext: { type: Boolean, default: false },
  hasPrevious: { type: Boolean, default: false },
});

const emit = defineEmits(['next-track', 'previous-track', 'fallback-v1', 'cache-progress']);

// ── MSE Buffer Composable ────────────────────────────────────────

const mse = useMseBuffer();
import { telemetry } from '../composables/useTelemetry.js';

// ── Telemetry Data for SettingsPanel ─────────────────────────────

const telemetryData = computed(() => ({
  usedMemory:      telemetry.usedMemory.value,
  totalMemory:     telemetry.totalMemory.value,
  speedHistory:    telemetry.speedHistory.value,
  stallCount:      telemetry.stallCount.value,
  totalStallDuration: telemetry.totalStallDuration.value,
}));

// ── Settings Handlers ────────────────────────────────────────────

function onUpdateCacheLimit(bytes) {
  mse.setCacheLimit(bytes);
}

function onUpdateSpeedCap(bytesPerSec) {
  mse.setSpeedCap(bytesPerSec);
}

// ── Persisted player settings ─────────────────────────────────
// One JSON blob rather than a key per control, so the next setting costs a field. Cache size and
// the download cap stay session-scoped on purpose: both are stress-test dials, and a value left
// over from last week's experiment reads like a broken player.

function readPlayerSettings() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_SETTINGS_KEY)) || {};
  } catch (_) {
    return {}; // a hand-edited or half-written blob must not take the player down
  }
}

function writePlayerSettings(patch) {
  localStorage.setItem(CACHE_SETTINGS_KEY, JSON.stringify({ ...readPlayerSettings(), ...patch }));
}

const cacheMode = ref(normalizeCacheMode(readPlayerSettings().cacheMode));

function onUpdateCacheMode(mode) {
  const next = normalizeCacheMode(mode);
  cacheMode.value = next;
  writePlayerSettings({ cacheMode: next });
  mse.setCacheMode(next);
}

// ── Local State ──────────────────────────────────────────────────

const audioElement = ref(null);
const currentTrack = ref(null);
const currentTime = ref(0);
const duration = ref(0);
const isPlaying = ref(false);

// Load saved volume from localStorage or default to 0.3
const savedVolume = parseFloat(localStorage.getItem('rpg-music-volume') || '0.3');
const volume = ref(savedVolume);

const mseError = ref(null);
const isBuffering = ref(false);
const bufferMessage = ref('Loading...');

// Seed from the service so a player that mounts over an already-open socket does not flash
// 'Disconnected' until the next reconnect (the service emits 'connected' only on new sockets).
const isConnected = ref(websocket.connected === true);

// ── Computed ─────────────────────────────────────────────────────

const progressPercent = computed(() => {
  if (duration.value === 0) return 0;
  return (currentTime.value / duration.value) * 100;
});

// ── Chunk inventory ────────────────────────────────────────────

const cachedChunkCount = computed(() => mse.cachedChunkCount.value || 0);

/**
 * Convert MSE buffered TimeRanges into an array of { start, width } percent blocks.
 * Only includes regions ahead of the current playhead (grey cached indicators).
 */
/**
 * Loaded audio ahead of the playhead, in two layers: `loaded` sits in the decoder already,
 * `held` is in the fragment cache and only needs an append. Without the second layer a fully
 * cached track looked like its last chunk was missing while the playlist row said otherwise.
 */
const cacheLayers = computed(() => planCacheBlocks({
  buffered: mse.bufferedRanges.value,
  cached: mse.cachedSpans.value,
  currentTime: currentTime.value,
  duration: duration.value,
}));
const cachedBlocks = computed(() => cacheLayers.value.loaded);
const heldBlocks = computed(() => cacheLayers.value.held);

// ── Time Formatting ──────────────────────────────────────────────

const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

// ── Playback Control ─────────────────────────────────────────────

// The server owns playback state: controls send a command and the room's `pause`/`resume`
// broadcast drives the element, so every other listener stays in sync. Local toggling is the
// fallback for when we are not attached to a room (V1 has the same shape).

const roomId = ref(websocket.getCurrentRoomId?.() || localStorage.getItem('rpg-music-room-id') || 'room-1');

async function handlePlayPauseClick() {
  log('play/pause clicked, currentTrack:', !!currentTrack.value, 'mseError:', !!mseError.value, 'audioEl:', !!audioElement.value);
  if (mseError.value) { warn('blocked by error'); return; }

  try {
    if (isPlaying.value) await api.pause(roomId.value);
    else await api.resume(roomId.value);
    log('play/pause sent to server, room:', roomId.value, 'wasPlaying:', isPlaying.value);
  } catch (e) {
    warn('server play/pause failed, controlling locally:', e.message || e);
    try {
      await mse.togglePlayPause();
      isPlaying.value = mse.playing.value;
    } catch (inner) {
      err('toggle failed:', inner.message || inner);
      mseError.value = inner;
    }
  }
}

// ── Track end ──────────────────────────────────────────────────
// `track_ended` is what makes the server queue the next playlist item (or replay in repeat
// mode). Without it V2 sits at the end of the buffer in silence forever.

let _endedReportedFor = null;

function reportTrackEnded(reason) {
  const trackId = currentTrack.value?.id;
  if (!trackId || _endedReportedFor === trackId) return;
  _endedReportedFor = trackId;
  log('track ended — reporting to server:', String(trackId).slice(0, 8), `(${reason})`);
  isPlaying.value = false;
  try {
    websocket.reportTrackEnded();
  } catch (e) {
    err('reportTrackEnded failed:', e.message || e);
  }
}

function onEnded() {
  reportTrackEnded('ended event');
}

function onMediaError() {
  const mediaError = audioElement.value?.error;
  err('media element error:', mediaError?.code, mediaError?.message);
  try {
    websocket.reportError('V2 playback error', currentTrack.value?.id);
  } catch (_) { /* socket may be down */ }
}

// MSE only fires `ended` once the playhead reaches the declared duration and a half-filled
// buffer can stall just short of it, so nudge the same path from the tick loop. That keeps a
// track from stranding the room when the last fragment lands late.
function maybeReportEnded() {
  if (!isPlaying.value || !duration.value) return;
  if (audioElement.value?.seeking) return;
  if (currentTime.value >= duration.value - 0.75) reportTrackEnded('watchdog');
}

function handleNextClick() {
  emit('next-track');
}

function handlePreviousClick() {
  emit('previous-track');
}

async function retryPlayback() {
  mseError.value = null;
  isBuffering.value = true;
  bufferMessage.value = 'Retrying...';
  if (currentTrack.value) {
    _endedReportedFor = null;
    await loadTrackIntoMse(currentTrack.value.id);
  }
}

// ── Seek ─────────────────────────────────────────────────────────

async function seekToPosition(event) {
  if (!duration.value) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const percent = (event.clientX - rect.left) / rect.width;
  const newTime = Math.max(0, Math.min(percent * duration.value, duration.value));

  // Same shape as V1: the server owns playback state, so a purely local seek is overwritten by
  // the next `state_sync` (it drags the playhead back to the room's position). Ask the room to
  // seek and let the `seek` broadcast drive the element for everyone, this client included.
  try {
    await api.seek(newTime, roomId.value);
    suppressDrift();
    log('seek sent to server:', newTime.toFixed(2));
  } catch (e) {
    warn('server seek failed, seeking locally:', e.message || e);
    mse.seek(newTime);
    currentTime.value = newTime;
    suppressDrift();
  }
}

// ── Repeat & loop region (V1 parity) ─────────────────────────────
// Repeat mode and loop points are room state: the controls ask the server, and the
// `repeat_mode_change` / `loop_points_change` broadcasts put every listener in the room in the
// same place, so the local state is only ever an optimistic preview of that echo.

const repeatOn = computed(() => mse.repeatMode.value !== 'none');
const loopStart = computed(() => mse.loopRegion.value?.startSec ?? null);
const loopEnd = computed(() => mse.loopRegion.value?.endSec ?? null);
const showLoopMarkers = computed(() => repeatOn.value && duration.value > 0);
const loopStartPercent = computed(() =>
  (duration.value ? ((loopStart.value ?? 0) / duration.value) * 100 : 0),
);
const loopEndPercent = computed(() =>
  (duration.value ? ((loopEnd.value ?? duration.value) / duration.value) * 100 : 0),
);

async function handleRepeatClick() {
  try {
    await api.toggleRepeat(roomId.value);
    log('repeat toggled, room:', roomId.value);
  } catch (e) {
    warn('server repeat toggle failed:', e.message || e);
  }
}

const progressBarEl = ref(null);
const draggingLoopStart = ref(false);
const draggingLoopEnd = ref(false);

/** Client X on the progress bar → seconds, clamped to the track. */
function secondsFromClientX(clientX) {
  const bar = progressBarEl.value;
  if (!bar || !duration.value) return null;
  const rect = bar.getBoundingClientRect();
  if (!rect.width) return null;
  const percent = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  return (percent / 100) * duration.value;
}

let _loopPushTimer = null;

/** Show the drag immediately, then debounce the room update (V1 does the same). */
function pushLoopPoints(startSec, endSec, immediate = false) {
  mse.loopRegion.value = { startSec, endSec };

  const send = async () => {
    try {
      await api.setLoopPoints(startSec, endSec, roomId.value);
      // V1 parity: once the region lands, a playhead left outside it jumps to the start —
      // but not mid-drag, where the region is still moving under the pointer.
      if (draggingLoopStart.value || draggingLoopEnd.value) return;
      const at = mse.getCurrentTime();
      if (at < startSec || at > endSec) {
        mse.seek(startSec);
        suppressDrift(1000);
      }
    } catch (e) {
      warn('setLoopPoints failed:', e.message || e);
    }
  };

  if (_loopPushTimer) {
    clearTimeout(_loopPushTimer);
    _loopPushTimer = null;
  }
  if (immediate) {
    send();
    return;
  }
  _loopPushTimer = setTimeout(() => { _loopPushTimer = null; send(); }, 150);
}

function startDragLoopStart(event) {
  event.preventDefault();
  event.stopPropagation();
  draggingLoopStart.value = true;
  document.addEventListener('mousemove', dragLoopStart);
  document.addEventListener('mouseup', stopDragLoopStart);
}

function dragLoopStart(event) {
  if (!draggingLoopStart.value) return;
  const seconds = secondsFromClientX(event.clientX);
  if (seconds === null) return;
  const maxStart = loopEnd.value !== null ? loopEnd.value - 0.5 : duration.value;
  pushLoopPoints(Math.min(seconds, maxStart), loopEnd.value ?? duration.value);
}

function stopDragLoopStart() {
  draggingLoopStart.value = false;
  document.removeEventListener('mousemove', dragLoopStart);
  document.removeEventListener('mouseup', stopDragLoopStart);
  pushLoopPoints(loopStart.value ?? 0, loopEnd.value ?? duration.value, true);
}

function startDragLoopEnd(event) {
  event.preventDefault();
  event.stopPropagation();
  draggingLoopEnd.value = true;
  document.addEventListener('mousemove', dragLoopEnd);
  document.addEventListener('mouseup', stopDragLoopEnd);
}

function dragLoopEnd(event) {
  if (!draggingLoopEnd.value) return;
  const seconds = secondsFromClientX(event.clientX);
  if (seconds === null) return;
  const minEnd = loopStart.value !== null ? loopStart.value + 0.5 : 0.5;
  pushLoopPoints(loopStart.value ?? 0, Math.max(seconds, minEnd));
}

function stopDragLoopEnd() {
  draggingLoopEnd.value = false;
  document.removeEventListener('mousemove', dragLoopEnd);
  document.removeEventListener('mouseup', stopDragLoopEnd);
  pushLoopPoints(loopStart.value ?? 0, loopEnd.value ?? duration.value, true);
}

/** Repeat + loop points: rewind at the end of the region, the check V1 runs on `timeupdate`. */
function maybeLoopRegion() {
  if (!repeatOn.value) return;
  // The 250 ms watchdog has no `timeupdate` semantics: without this it would yank a paused
  // playhead back to `loopStart` a quarter second after the room paused past the region end.
  // V1 is immune because `timeupdate` stops firing when paused.
  if (!mse.playing.value) return;
  const region = mse.loopRegion.value;
  if (!region || typeof region.endSec !== 'number') return;
  if (mse.getCurrentTime() < region.endSec) return;
  mse.seek(region.startSec ?? 0);
  suppressDrift();
}

// ── Drift correction ─────────────────────────────────────────────
// The server periodically asks every client where it thinks it is; an intentional seek or loop
// must not be undone by the answer to a check that was already in flight.

const suppressDriftCorrection = ref(false);
const drift = ref(null); // null until the server's first position_check, same as V1
const expectedPosition = ref(null);
let _suppressTimer = null;

function suppressDrift(ms = 500) {
  suppressDriftCorrection.value = true;
  if (_suppressTimer) clearTimeout(_suppressTimer);
  _suppressTimer = setTimeout(() => { suppressDriftCorrection.value = false; _suppressTimer = null; }, ms);
}

function handlePositionCheck(data) {
  const expected = data?.expectedPosition;
  expectedPosition.value = typeof expected === 'number' ? expected : null;
  if (typeof expected !== 'number' || suppressDriftCorrection.value) return;

  drift.value = Math.abs(expected - currentTime.value);
  const maxDrift = typeof data.maxDrift === 'number' ? data.maxDrift : 2;
  if (drift.value > maxDrift && mse.playing.value) {
    log(`correcting drift: ${drift.value.toFixed(2)}s > ${maxDrift}s`);
    mse.seek(expected);
  }
}

// ── Autoplay unlock ──────────────────────────────────────────────
// Chromium refuses `play()` until the document has seen a gesture, and an MSE element is no
// exception. V1 shows a click-through overlay for that; without it V2 just sits there silently.

const needsAudioUnlock = ref(false);

watch(mse.error, (error) => {
  if (error?.name === 'NotAllowedError') {
    needsAudioUnlock.value = true;
    return;
  }
  needsAudioUnlock.value = false;
  // V1 tells the server when playback failed for a reason the room should know about; the
  // autoplay block is the deliberate exception — the unlock overlay handles that one.
  if (error) {
    try {
      websocket.reportError(error.message || 'V2 playback error', currentTrack.value?.id || null);
    } catch (_) { /* socket may be down */ }
  }
});

async function unlockAudio() {
  const el = audioElement.value;
  if (!el) return;
  try {
    el.muted = true;
    await el.play();
    el.pause();
    el.muted = false;
    mse.error.value = null;
    needsAudioUnlock.value = false;
    log('audio unlocked by user gesture');
    websocket.requestState();
  } catch (e) {
    warn('unlock failed:', e.message || e);
  }
}

// ── Volume ───────────────────────────────────────────────────────

const sliderToVolume = (sliderValue) => {
  if (sliderValue <= 50) return (sliderValue / 50) * 0.1;
  return 0.1 + ((sliderValue - 50) / 50) * 0.9;
};

const volumeToSlider = (vol) => {
  if (vol <= 0.1) return (vol / 0.1) * 50;
  return 50 + ((vol - 0.1) / 0.9) * 50;
};

function onVolumeChange(event) {
  const newVolume = sliderToVolume(parseFloat(event.target.value));
  volume.value = newVolume;
  mse.setVolume(newVolume);
  localStorage.setItem('rpg-music-volume', newVolume.toString());
}

// ── Track Loading ────────────────────────────────────────────────

async function loadTrackIntoMse(trackId) {
  log('loadTrackIntoMse called with:', trackId);
  log('audioElement ready?', !!audioElement.value, 'el tag:', audioElement.value?.tagName);
  isBuffering.value = true;
  bufferMessage.value = 'Loading track...';
  mseError.value = null;

  try {
    // Fetch track metadata to get duration
    log('fetching track metadata for:', trackId);
    const trackData = await api.getTrack(trackId);
    log('track data received:', { id: trackData.id, title: trackData.title, duration: trackData.duration, fileSize: trackData.file_size });
    currentTrack.value = {
      id: trackData.id,
      title: trackData.title || 'Unknown Title',
      artist: trackData.artist || 'Unknown Artist',
      album: trackData.album || '',
      duration: trackData.duration || 0,
    };
    duration.value = trackData.duration || 0;

    const audioUrl = api.getAudioUrl(trackId);
    log('audio URL:', audioUrl);

    // Initialize MSE pipeline and start chunk fetching
    log('calling mse.loadTrack...');
    await mse.loadTrack(trackId, audioUrl, audioElement.value, trackData.duration);
    log('mse.loadTrack completed');

    // Bind audio element events for reactive state updates
    mse.bindAudioEvents();
    log('audio events bound');

    // Set initial volume
    mse.setVolume(volume.value);
    log('volume set to:', volume.value);

    isBuffering.value = false;
    log('track loaded successfully — buffering overlay hidden');
  } catch (e) {
    err('Failed to load track:', e.message || e, 'stack:', (e.stack||'').split('\n').slice(0,3).join('\n'));
    mseError.value = e;
    isBuffering.value = false;
  }
}

// ── Watch for track changes ──────────────────────────────────────

// A track we cannot fragment, or a browser that cannot decode the result, should hand
// playback back to the element player instead of sitting there buffering.
watch(
  () => mse.needsFallback.value,
  (needed) => {
    if (needed) {
      warn('V2 cannot play this track — switching to V1');
      emit('fallback-v1');
    }
  },
);

// The queue draws a cache strip per track. Coverage moves with every fragment that lands, so
// coalesce the burst — the list only needs to redraw a few times a second.
watch(
  () => mse.cacheCoverage.value,
  (coverage) => emit('cache-progress', coverage),
  { immediate: true, throttle: 250 },
);

watch(
  () => props.currentTrackId,
  (newId, oldId) => {
    log('trackId watch fired:', { newId, oldId });
    if (newId && newId !== mse.currentTrackId.value) {
      log('loading track into MSE:', newId);
      ensureTrackLoaded(newId);
    } else if (!newId) {
      log('track cleared — shutting down MSE');
      // Track cleared — shut down MSE pipeline
      mse.shutdown();
      currentTrack.value = null;
      duration.value = 0;
      currentTime.value = 0;
      isPlaying.value = false;
    }
  },
);

// ── Time Update Loop ─────────────────────────────────────────────

let _timeUpdateInterval = null;

function startTimeUpdates() {
  stopTimeUpdates();
  _timeUpdateInterval = setInterval(() => {
    if (audioElement.value) {
      const t = mse.getCurrentTime();
      currentTime.value = t;
      mse.updateBufferedRanges();
      maybeLoopRegion();
      maybeReportEnded();
      // Log playback state periodically for debugging
      if (mse.playing.value && Math.floor(t * 4) % 8 === 0) {
        log('tick — time:', t.toFixed(1), 'duration:', duration.value, 'playing:', mse.playing.value);
      }
    } else {
      warn('time update: audioElement is null');
    }
  }, 250); // Update every 250ms for smooth progress bar
}

function stopTimeUpdates() {
  if (_timeUpdateInterval) {
    clearInterval(_timeUpdateInterval);
    _timeUpdateInterval = null;
  }
}

// ── WebSocket playback sync ──────────────────────────────────────
// The server owns playback state and V1 reconciles from these events. V2 has to do the same,
// otherwise a freshly selected track buffers its bytes and then sits there silently.

// One load in flight per track: the props watch and the websocket events both ask for the
// same track when a room starts playing something.
let _loadPromise = null;
let _loadFor = null;
let _startTimer = null;

function ensureTrackLoaded(trackId) {
  if (!trackId) return Promise.resolve();
  if (_loadPromise && _loadFor === trackId) return _loadPromise;
  if (!_loadPromise && mse.currentTrackId.value === trackId) return Promise.resolve();
  _loadFor = trackId;
  _loadPromise = loadTrackIntoMse(trackId).finally(() => { _loadPromise = null; _loadFor = null; });
  return _loadPromise;
}

function applyPosition(position, force = false, toleranceSec = 1.5) {
  if (typeof position !== 'number' || !Number.isFinite(position)) return;
  const total = mse.trackDuration.value || 0;
  // A position at (or past) the end means the track finished, not "park the playhead there".
  // Seeking into the tail reopens a stream the browser already closed, which used to cascade
  // into a full track reload and take the MediaSource down with it.
  if (total > 0 && position >= total - 0.25) return;
  const target = total > 0 ? Math.max(position, 0) : position;
  if (force || Math.abs(target - mse.getCurrentTime()) > toleranceSec) mse.seek(target);
}

// The server schedules starts ~1s in the future so every room member begins together; the
// offset comes from the same handshake V1 uses.
function scheduleStart(scheduledStartTime) {
  if (_startTimer) {
    clearTimeout(_startTimer);
    _startTimer = null;
  }
  let waitMs = 0;
  if (typeof scheduledStartTime === 'number') {
    const delta = scheduledStartTime - websocket.getServerTime();
    if (delta > 0) waitMs = delta;
  }
  if (waitMs > 0) _startTimer = setTimeout(() => { _startTimer = null; mse.play(); }, waitMs);
  else mse.play();
}

function syncLoopRegion(loopStart, loopEnd) {
  mse.loopRegion.value =
    typeof loopStart === 'number' && typeof loopEnd === 'number' && loopEnd > loopStart
      ? { startSec: loopStart, endSec: loopEnd }
      : null;
}

async function handlePlayTrack(data) {
  if (!data?.trackId) return;
  // A play_track always starts the track afresh — including replaying the current one in
  // repeat mode, which must be allowed to report `track_ended` again.
  _endedReportedFor = null;
  // ...and afresh means the region travels with the track, not with the room. The server owns
  // it and sends it in `play_track` (cleared whenever playback moves to a different track), so
  // mirroring the payload keeps markers, enforcement and the server's own position wrapping
  // talking about the same region. Payloads without the fields still clear.
  syncLoopRegion(data.loopStart ?? null, data.loopEnd ?? null);
  await ensureTrackLoaded(data.trackId);
  // play_track carries `startPosition`; `position` is the state_sync/pause/resume field.
  applyPosition(data.startPosition ?? 0, true);
  scheduleStart(data.scheduledStartTime);
}

async function handleStateSync(data) {
  if (typeof data?.repeatMode !== 'undefined') mse.setRepeatMode(data.repeatMode);
  if (typeof data?.loopPlaylist !== 'undefined') mse.setPlaylistLoop(data.loopPlaylist);
  syncLoopRegion(data?.loopStart, data?.loopEnd);

  const track = data?.currentTrack;
  if (!track) return;
  // Wait for the load to settle, otherwise play/seek races the SourceBuffer setup.
  await ensureTrackLoaded(track.id);
  applyPosition(data.position);
  if (data.playbackState === 'playing') scheduleStart();
  else if (data.playbackState === 'paused') mse.pause();
}

function handlePause(data) {
  mse.pause();
  // The server reports the final position together with the pause that ends a track; the guard
  // in applyPosition keeps that from being treated as a seek.
  applyPosition(data?.position, false, 0.5);
}

function handleResume(data) {
  applyPosition(data?.position);
  scheduleStart(data?.scheduledStartTime);
}

function handleSeekEvent(data) {
  // An explicit seek from another client is authoritative, no drift tolerance.
  applyPosition(data?.position, true);
  suppressDrift();
  if (data?.scheduledStartTime) scheduleStart(data.scheduledStartTime);
}

function handleStop() {
  mse.pause();
  mse.seek(0);
}

function handleRepeatModeChange(data) {
  mse.setRepeatMode(data?.repeatMode);
}

function handleLoopModeChange(data) {
  // 🔄 Loop Playlist is a room flag rather than the repeat button: it decides what follows the
  // last item, which is what makes the player pre-buffer the first track.
  mse.setPlaylistLoop(data?.loopPlaylist);
  log('loop playlist:', data?.loopPlaylist, '— next track:', mse.nextPlaylistTrackId() || 'none',
    `(${(mse.playlist.value || []).length} queued, current ${mse.currentTrackId.value || 'none'})`);
}

function handleLoopPointsChange(data) {
  syncLoopRegion(data?.loopStart, data?.loopEnd);
}

function handleRoomJoined(data) {
  if (!data?.roomId) return;
  roomId.value = data.roomId;
  log('room joined:', data.roomId);
}

function handleConnected() {
  isConnected.value = true;
}

function handleDisconnected() {
  isConnected.value = false;
}

const wsHandlers = [
  ['connected', handleConnected],
  ['disconnected', handleDisconnected],
  ['play_track', handlePlayTrack],
  ['state_sync', handleStateSync],
  ['pause', handlePause],
  ['resume', handleResume],
  ['seek', handleSeekEvent],
  ['stop', handleStop],
  ['repeat_mode_change', handleRepeatModeChange],
  ['loop_mode_change', handleLoopModeChange],
  ['loop_points_change', handleLoopPointsChange],
  ['position_check', handlePositionCheck],
  ['room_joined', handleRoomJoined],
];

// Keyboard media keys (the same two V1 answers to; OS/keyboard shortcuts arrive here).
function handleMediaKey(event) {
  if (event.key === 'MediaTrackNext') {
    event.preventDefault();
    if (props.hasNext) handleNextClick();
  } else if (event.key === 'MediaTrackPrevious') {
    event.preventDefault();
    if (props.hasPrevious) handlePreviousClick();
  }
}

watch(mse.playing, (value) => {
  isPlaying.value = value;
  // Sound is clearly working, whatever the browser complained about earlier.
  if (value) needsAudioUnlock.value = false;
});

watch(
  () => props.playlist,
  (tracks) => { mse.playlist.value = Array.isArray(tracks) ? tracks : []; },
  { immediate: true, deep: true },
);

// ── Lifecycle ────────────────────────────────────────────────────

onMounted(async () => {
  log('onMounted');
  // Check MSE support
  const supported = isMseAacSupported();
  log('MSE+AAC supported?', supported);
  if (!supported) {
    warn('MSE with AAC not supported — consider V1 fallback');
  }

  // The saved aggressiveness has to reach the buffer before the first track loads, or a hard-mode
  // listener gets soft behaviour until they touch the panel again.
  mse.setCacheMode(cacheMode.value);

  // Start time update loop
  startTimeUpdates();
  log('time updates started (250ms interval)');

  // V1 used to be the only component calling connect(); with V1 unmounted by the mode
  // switch, V2 has to open the socket itself or playback events never arrive.
  websocket.connect();
  window.addEventListener('keydown', handleMediaKey);
  wsHandlers.forEach(([event, handler]) => websocket.on(event, handler));
  log('websocket playback events bound');

  // A track may already be playing when the player is mounted (mode switch, late mount),
  // in which case the currentTrackId watch never fires.
  if (props.currentTrackId) {
    log('mounting with a track already selected:', props.currentTrackId);
    ensureTrackLoaded(props.currentTrackId);
  }

  // Set initial volume on the audio element once it's ready
  await nextTick();
  if (audioElement.value) {
    audioElement.value.volume = volume.value;
    log('audio element ready, volume set to:', volume.value);
  } else {
    warn('audioElement still null after nextTick!');
  }
});

onUnmounted(() => {
  wsHandlers.forEach(([event, handler]) => websocket.off(event, handler));
  window.removeEventListener('keydown', handleMediaKey);
  // A drag that outlives the component would otherwise keep firing on the document.
  document.removeEventListener('mousemove', dragLoopStart);
  document.removeEventListener('mouseup', stopDragLoopStart);
  document.removeEventListener('mousemove', dragLoopEnd);
  document.removeEventListener('mouseup', stopDragLoopEnd);
  if (_startTimer) clearTimeout(_startTimer);
  if (_loopPushTimer) clearTimeout(_loopPushTimer);
  if (_suppressTimer) clearTimeout(_suppressTimer);
  stopTimeUpdates();
  mse.shutdown();
});
</script>

<style scoped>
.audio-player {
  background: #2a2a2a;
  border-radius: 8px;
  padding: 12px;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 240px;
}

/* ── Overlays ─────────────────────────────────────────────────── */

.buffer-overlay,
.error-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(4px);
}

.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid rgba(76, 175, 80, 0.2);
  border-top-color: #4CAF50;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.buffer-overlay p {
  position: absolute;
  bottom: 40%;
  color: #e0e0e0;
  font-size: 0.95em;
}

.error-content {
  text-align: center;
  padding: 30px;
}

.error-icon {
  font-size: 3em;
  margin-bottom: 16px;
}

.error-content h3 {
  color: #ff9800;
  margin: 0 0 8px 0;
  font-size: 1.2em;
}

.error-content p {
  color: #999;
  margin: 0 0 16px 0;
  font-size: 0.9em;
}

.retry-btn {
  padding: 8px 24px;
  background: #4CAF50;
  border: none;
  border-radius: 6px;
  color: white;
  font-size: 1em;
  cursor: pointer;
  transition: background 0.2s;
}

.retry-btn:hover {
  background: #45a049;
}

/* ── Now Playing ──────────────────────────────────────────────── */

.now-playing {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 10px;
  gap: 8px;
  min-height: 50px;
}

.track-info {
  flex: 1;
  min-width: 0;
}

.track-info h2 {
  margin: 0 0 3px 0;
  font-size: 1.1em;
  color: #e0e0e0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-info h2.no-track {
  color: #666;
}

.track-info .artist {
  margin: 0;
  color: #999;
  font-size: 0.95em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Sync status (V1 parity) ──────────────────────────────────── */

.sync-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 6px;
  background: #1a1a1a;
  font-size: 0.85em;
  flex-shrink: 0;
}

.sync-status.connected {
  color: #4CAF50;
}

.sync-status.disconnected {
  color: #f44336;
}

.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.drift-line {
  font-size: 0.85em;
  color: #4CAF50;
  padding-left: 16px;
}

.drift-line.drift-warning {
  color: #ff9800;
  font-weight: bold;
}

audio {
  display: none;
}

/* ── Controls ─────────────────────────────────────────────────── */

.player-controls {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.progress-bar {
  height: 8px;
  /* `.player-controls` is a column flex box, and this bar has no in-flow content, so a tight
     container shrinks it to zero height — which also makes it impossible to click. */
  flex-shrink: 0;
  background: #1a1a1a;
  border-radius: 4px;
  cursor: pointer;
  position: relative;
  margin-bottom: 8px;
  /* Not clipped: the playhead handle and the loop markers are taller than the 8px track and are
     meant to overhang it, like V1. */
}

.progress-fill {
  height: 100%;
  background: #4CAF50;
  border-radius: 4px;
  transition: width 0.1s linear;
  position: relative;
  z-index: 2;
}

/* Cached region indicators (grey blocks ahead of playhead) */
.cached-block {
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba(158, 158, 158, 0.35);
  border-radius: 0 2px 2px 0;
  z-index: 1;
  pointer-events: none;
}

/* Held in the fragment cache, not in the decoder yet: same grey, quieter, and squared off so the
   boundary with the appended audio stays legible. */
.cached-block.held {
  background: rgba(158, 158, 158, 0.16);
  border-radius: 0;
}

.progress-handle {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 16px;
  height: 16px;
  background: #4CAF50;
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  z-index: 3;
}

/* ── Loop region (V1 parity) ─────────────────────────────────────── */

.loop-region {
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba(33, 150, 243, 0.15);
  border-left: 2px solid rgba(33, 150, 243, 0.5);
  border-right: 2px solid rgba(33, 150, 243, 0.5);
  pointer-events: none;
  z-index: 1;
}

.loop-marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 20px;
  height: 20px;
  background: #2196F3;
  border: 2px solid #fff;
  border-radius: 50%;
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 4;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
  transition: transform 0.2s, background 0.2s, box-shadow 0.2s;
  user-select: none;
}

.loop-marker:hover {
  transform: translate(-50%, -50%) scale(1.3);
  background: #1976D2;
  box-shadow: 0 3px 10px rgba(33, 150, 243, 0.6);
}

.loop-marker-handle {
  color: white;
  font-size: 12px;
  font-weight: bold;
  pointer-events: none;
  line-height: 1;
}

.loop-marker-label {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(71, 71, 71, 0.75);
  color: #999;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  padding: 2px 5px;
  border-radius: 4px;
  pointer-events: none;
  line-height: 1.4;
}

/* ── Autoplay unlock overlay (V1 parity) ─────────────────────────── */

.audio-unlock-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.9);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  cursor: pointer;
  backdrop-filter: blur(4px);
  animation: fadeIn 0.3s ease;
}

.unlock-content {
  text-align: center;
  padding: 40px;
}

.unlock-icon {
  font-size: 4em;
  margin-bottom: 20px;
  animation: pulse 2s infinite;
}

.unlock-content h3 {
  color: #4CAF50;
  margin: 0 0 10px 0;
  font-size: 1.5em;
}

.unlock-content p {
  color: #999;
  margin: 0;
  font-size: 0.9em;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.08); }
  100% { transform: scale(1); }
}

.time-display {
  display: flex;
  justify-content: space-between;
  color: #999;
  font-size: 0.85em;
  margin-bottom: 10px;
}

.control-buttons {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
}

.control-btn {
  padding: 10px 16px;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 1.1em;
  cursor: pointer;
  transition: all 0.2s;
  min-width: 45px;
}

.control-btn:hover:not(:disabled) {
  background: #333;
  border-color: #4CAF50;
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(76, 175, 80, 0.2);
}

.control-btn:active:not(:disabled) {
  transform: translateY(0);
}

.control-btn.active {
  background: #4CAF50;
  border-color: #4CAF50;
}

.control-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.control-btn.play-pause {
  background: #4CAF50;
  border-color: #4CAF50;
  padding: 10px 20px;
  font-size: 1.2em;
}

.control-btn.play-pause:hover:not(:disabled) {
  background: #45a049;
  border-color: #45a049;
}

/* ── Volume Control ───────────────────────────────────────────── */

.volume-control {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
  padding-top: 10px;
}

.volume-icon {
  font-size: 1.2em;
}

.volume-slider {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #1a1a1a;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #4CAF50;
  cursor: pointer;
}

.volume-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #4CAF50;
  cursor: pointer;
  border: none;
}

.volume-value {
  color: #999;
  font-size: 0.9em;
  min-width: 40px;
  text-align: right;
}

/* ── Responsive ───────────────────────────────────────────────── */

@media (max-width: 1024px) {
  .audio-player { padding: 12px; }
  .track-info h2 { font-size: 1.1em; }
  .control-btn { padding: 8px 12px; font-size: 1em; }
  .control-btn.play-pause { padding: 8px 16px; font-size: 1.1em; }
}

@media (max-width: 768px) {
  .now-playing { flex-direction: column; align-items: stretch; }
  .control-buttons { gap: 6px; }
  .control-btn { padding: 6px 10px; font-size: 0.95em; min-width: 40px; }
  .control-btn.play-pause { padding: 6px 14px; }
}
</style>
