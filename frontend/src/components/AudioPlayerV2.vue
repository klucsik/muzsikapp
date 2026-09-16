<template>
  <div class="audio-player">
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
    </div>

    <!-- Hidden audio element managed by MSE -->
    <audio ref="audioElement" preload="none"></audio>

    <!-- Player Controls -->
    <div class="player-controls">
      <!-- Progress Bar with Cached Regions -->
      <div class="progress-bar" @dblclick="seekToPosition">
        <!-- Green fill for played content -->
        <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>

        <!-- Grey blocks for cached/buffered regions ahead of playhead -->
        <template v-if="cachedBlocks.length > 0">
          <div
            v-for="(block, i) in cachedBlocks"
            :key="i"
            class="cached-block"
            :style="{ left: block.start + '%', width: block.width + '%' }"
          ></div>
        </template>

        <!-- Progress handle at playhead position -->
        <div class="progress-handle" :style="{ left: progressPercent + '%' }"></div>
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
          :title="isPlaying ? 'Pause' : 'Play'"
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
      </div>

      <!-- Load Progress (during initial buffer fill) -->
      <div v-if="loadProgressPct > 0 && loadProgressPct < 100 && !isPlaying" class="load-progress">
        <div class="load-bar" :style="{ width: loadProgressPct + '%' }"></div>
        <span class="load-text">{{ Math.round(loadProgressPct) }}% buffered</span>
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
      <span class="volume-value">{{ (volume * 100).toFixed(0) }}%</span>
    </div>

    <!-- Settings & Telemetry Panel -->
    <SettingsPanel
      :used-memory="telemetryData.usedMemory"
      :total-memory="telemetryData.totalMemory"
      :speed-history="telemetryData.speedHistory"
      :stall-count="telemetryData.stallCount"
      :total-stall-duration="telemetryData.totalStallDuration"
      :cached-chunks="mse.cacheSize.value || 0"
      :downloading-count="mse.pendingCount.value || 0"
      @update-cache-limit="onUpdateCacheLimit"
      @update-speed-cap="onUpdateSpeedCap"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useMseBuffer, isMseAacSupported } from '../composables/useMseBuffer.js';
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

const emit = defineEmits(['next-track', 'previous-track', 'fallback-v1']);

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

// ── Computed ─────────────────────────────────────────────────────

const progressPercent = computed(() => {
  if (duration.value === 0) return 0;
  return (currentTime.value / duration.value) * 100;
});

const loadProgressPct = computed(() => mse.loadProgress.value * 100);

/**
 * Convert MSE buffered TimeRanges into an array of { start, width } percent blocks.
 * Only includes regions ahead of the current playhead (grey cached indicators).
 */
const cachedBlocks = computed(() => {
  const ranges = mse.bufferedRanges.value;
  if (!ranges || ranges.length === 0 || duration.value === 0) return [];

  const blocks = [];
  for (let i = 0; i < ranges.length; i++) {
    const startSec = ranges.start(i);
    const endSec = ranges.end(i);

    // Only show cached regions ahead of the playhead
    if (endSec <= currentTime.value) continue;

    const blockStart = Math.max(0, ((startSec - currentTime.value) / duration.value)) * 100;
    const blockWidth = ((endSec - startSec) / duration.value) * 100;

    blocks.push({
      start: blockStart,
      width: blockWidth,
    });
  }
  return blocks;
});

// ── Time Formatting ──────────────────────────────────────────────

const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

// ── Playback Control ─────────────────────────────────────────────

async function handlePlayPauseClick() {
  log('play/pause clicked, currentTrack:', !!currentTrack.value, 'mseError:', !!mseError.value, 'audioEl:', !!audioElement.value);
  if (mseError.value) { warn('blocked by error'); return; }

  try {
    mse.togglePlayPause();
    isPlaying.value = mse.playing.value;
    log('play/pause toggled — playing:', isPlaying.value);
  } catch (e) {
    err('toggle failed:', e.message || e);
    mseError.value = e;
  }
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
    await loadTrackIntoMse(currentTrack.value.id);
  }
}

// ── Seek ─────────────────────────────────────────────────────────

function seekToPosition(event) {
  if (!duration.value) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const percent = (event.clientX - rect.left) / rect.width;
  const newTime = Math.max(0, Math.min(percent * duration.value, duration.value));
  mse.seek(newTime);
  currentTime.value = newTime;
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

function ensureTrackLoaded(trackId) {
  if (!trackId) return Promise.resolve();
  if (_loadPromise && _loadFor === trackId) return _loadPromise;
  if (!_loadPromise && mse.currentTrackId.value === trackId) return Promise.resolve();
  _loadFor = trackId;
  _loadPromise = loadTrackIntoMse(trackId).finally(() => { _loadPromise = null; _loadFor = null; });
  return _loadPromise;
}

function applyPosition(position) {
  if (typeof position !== 'number' || !Number.isFinite(position)) return;
  if (Math.abs(position - mse.getCurrentTime()) > 1.5) mse.seek(position);
}

async function handlePlayTrack(data) {
  await ensureTrackLoaded(data?.trackId);
  applyPosition(data?.position);
  await mse.play();
}

async function handleStateSync(data) {
  const track = data?.currentTrack;
  if (!track) return;
  // Wait for the load to settle, otherwise play/seek races the SourceBuffer setup.
  await ensureTrackLoaded(track.id);
  applyPosition(data.position);
  if (data.playbackState === 'playing') mse.play();
  else if (data.playbackState === 'paused') mse.pause();
}

function handlePause() { mse.pause(); }
function handleResume() { mse.play(); }
function handleSeekEvent(data) { applyPosition(data?.position); }
function handleStop() { mse.pause(); mse.seek(0); }

const wsHandlers = [
  ['play_track', handlePlayTrack],
  ['state_sync', handleStateSync],
  ['pause', handlePause],
  ['resume', handleResume],
  ['seek', handleSeekEvent],
  ['stop', handleStop],
];

watch(mse.playing, (value) => { isPlaying.value = value; });

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

  // Start time update loop
  startTimeUpdates();
  log('time updates started (250ms interval)');

  // V1 used to be the only component calling connect(); with V1 unmounted by the mode
  // switch, V2 has to open the socket itself or playback events never arrive.
  websocket.connect();
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
  background: #1a1a1a;
  border-radius: 4px;
  cursor: pointer;
  position: relative;
  margin-bottom: 8px;
  overflow: hidden;
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

/* Load progress bar (during initial buffer fill) */
.load-progress {
  position: relative;
  height: 4px;
  background: #1a1a1a;
  border-radius: 2px;
  margin-top: 6px;
  overflow: hidden;
}

.load-bar {
  height: 100%;
  background: #2196F3;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.load-text {
  position: absolute;
  top: -18px;
  right: 0;
  color: #2196F3;
  font-size: 0.75em;
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
