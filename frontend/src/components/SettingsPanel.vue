<template>
  <div class="settings-panel" :class="{ collapsed: !isOpen }">
    <div v-if="isOpen" class="panel-content">
      <!-- Left Column: Settings -->
      <div class="settings-section">
        <h4>Settings</h4>

        <!-- Cache Size Slider -->
        <div class="setting-row">
          <label for="cache-size-slider">Cache size</label>
          <div class="slider-group">
            <input
              id="cache-size-slider"
              type="range"
              min="10"
              max="500"
              step="25"
              :value="cacheSizeMb"
              @input="onCacheSizeChange"
              class="setting-slider"
            />
            <span class="slider-value">{{ cacheSizeMb }} MB</span>
          </div>
        </div>

        <!-- Speed Cap -->
        <div class="setting-row">
          <label for="speed-cap-select">Download cap</label>
          <select id="speed-cap-select" :value="speedCapLabel" @change="onSpeedCapChange" class="speed-select">
            <option value="none">No limit</option>
            <option value="5242880">5 MB/s</option>
            <option value="2097152">2 MB/s</option>
            <option value="1048576">1 MB/s</option>
            <option value="custom">Custom...</option>
          </select>
          <div v-if="speedCapLabel === 'custom'" class="custom-speed-input">
            <input
              type="number"
              min="64"
              :value="customSpeedKbs"
              @input="onCustomSpeedChange"
              placeholder="KB/s"
              class="custom-input"
            />
            <span>KB/s</span>
          </div>
        </div>
      </div>

      <!-- Right Column: Telemetry -->
      <div class="telemetry-section">
        <h4>Telemetry</h4>

        <!-- Memory Usage Bar -->
        <div class="metric-row memory-bar-wrapper">
          <label>Memory</label>
          <div class="memory-bar" :class="memoryBarClass">
            <div class="memory-fill" :style="{ width: memoryPercent + '%' }"></div>
            <span class="memory-text">{{ formatBytes(usedMemory) }} / {{ formatBytes(totalMemory) }}</span>
          </div>
        </div>

        <!-- Sparkline Chart -->
        <div class="metric-row sparkline-wrapper">
          <label>Speed (60s)</label>
          <svg class="sparkline" viewBox="0 0 280 50" preserveAspectRatio="none">
            <!-- Tick marks at ~20s and ~40s -->
            <text x="93" y="48" fill="#666" font-size="8" text-anchor="middle">-20s</text>
            <text x="187" y="48" fill="#666" font-size="8" text-anchor="middle">-40s</text>
            <!-- Y-axis grid lines -->
            <line v-if="sparkMax > 0" x1="0" y1="10" x2="280" y2="10" stroke="#333" stroke-width="0.5" />
            <line v-if="sparkMax > 0" x1="0" y1="25" x2="280" y2="25" stroke="#333" stroke-width="0.5" />
            <line v-if="sparkMax > 0" x1="0" y1="40" x2="280" y2="40" stroke="#333" stroke-width="0.5" />
            <!-- Data line -->
            <polyline
              v-if="sparkPoints.length > 1"
              :points="sparkPointsStr"
              fill="none"
              stroke="#4CAF50"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <!-- Data dots -->
            <circle
              v-for="(pt, i) in sparkPoints"
              :key="i"
              :cx="pt.x"
              :cy="pt.y"
              r="1.5"
              fill="#4CAF50"
            />
          </svg>
        </div>

        <!-- Stall Counter -->
        <div class="metric-row stat-row">
          <span class="stat-label">Stalls:</span>
          <span class="stat-value">{{ stallCount }} (total {{ totalStallDuration.toFixed(1) }}s)</span>
        </div>

        <!-- Buffer Health -->
        <div class="metric-row health-row">
          <span :class="['health-dot', healthDotClass]"></span>
          <span class="stat-label">Cache:</span>
          <span class="stat-value">{{ cachedChunks }} chunks</span>
          <span class="stat-sep">|</span>
          <span class="stat-label">Downloading:</span>
          <span class="stat-value">{{ downloadingCount }}</span>
        </div>

        <!-- Track Progress Bar -->
        <div v-if="trackTotalSize > 0" class="metric-row track-progress-wrapper">
          <label>Track</label>
          <div class="track-progress-bar">
            <div v-if="isFullyCached" class="fully-cached">
              <span>✓ Fully cached</span>
            </div>
            <template v-else>
              <div class="track-fill" :style="{ width: trackProgressPct + '%' }"></div>
              <span class="track-text">{{ Math.round(trackProgressPct) }}%{{ etaSeconds > 0 ? ' (~' + Math.ceil(etaSeconds) + 's left)' : '' }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Chevron Toggle -->
    <button class="chevron-toggle" @click="togglePanel">
      {{ isOpen ? '▲' : '▼' }}
    </button>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

// ── Logging ──────────────────────────────────────────────────────
function log(...args) { console.log('[Settings]', ...args); }

// ── Props / Emits ────────────────────────────────────────────────

const props = defineProps({
  usedMemory:      { type: Number, default: 0 },
  totalMemory:     { type: Number, default: 50 * 1024 * 1024 },
  speedHistory:    { type: Array,  default: () => [] },
  stallCount:      { type: Number, default: 0 },
  totalStallDuration: { type: Number, default: 0 },
  cachedChunks:    { type: Number, default: 0 },
  downloadingCount:{ type: Number, default: 0 },
  trackTotalSize:  { type: Number, default: 0 },
  trackLoadedBytes:{ type: Number, default: 0 },
  avgSpeed:        { type: Number, default: 0 },
});

const emit = defineEmits([
  'update-cache-limit',
  'update-speed-cap',
]);

// ── Panel State ──────────────────────────────────────────────────

const isOpen = ref(localStorage.getItem('muzsikapp-settings-panel-open') === 'true');

function togglePanel() {
  isOpen.value = !isOpen.value;
  localStorage.setItem('muzsikapp-settings-panel-open', String(isOpen.value));
}

// ── Cache Size Slider ────────────────────────────────────────────

const cacheSizeMb = computed(() => Math.round(props.totalMemory / (1024 * 1024)));

function onCacheSizeChange(e) {
  const mb = parseInt(e.target.value, 10);
  emit('update-cache-limit', mb * 1024 * 1024);
}

// ── Speed Cap Selector ───────────────────────────────────────────

const speedCapLabel = ref('none');
const customSpeedKbs = ref(512);

function onSpeedCapChange(e) {
  const val = e.target.value;
  speedCapLabel.value = val;
  if (val === 'none') {
    emit('update-speed-cap', 0);
  } else if (val === 'custom') {
    // handled by custom input below
  } else {
    emit('update-speed-cap', parseInt(val, 10));
  }
}

function onCustomSpeedChange(e) {
  const kbs = parseInt(e.target.value, 10);
  if (kbs > 0) {
    customSpeedKbs.value = kbs;
    emit('update-speed-cap', kbs * 1024);
  }
}

// ── Memory Bar ───────────────────────────────────────────────────

const memoryPercent = computed(() => {
  if (props.totalMemory === 0) return 0;
  return Math.min(100, (props.usedMemory / props.totalMemory) * 100);
});

const memoryBarClass = computed(() => {
  const pct = memoryPercent.value;
  if (pct < 75) return 'green';
  if (pct <= 90) return 'yellow';
  return 'red';
});

// ── Sparkline ────────────────────────────────────────────────────

const sparkPoints = computed(() => {
  const data = props.speedHistory;
  if (!data || data.length === 0) return [];

  const now = Date.now();
  // Filter to last 60 seconds
  const filtered = data.filter(p => now - p.timestamp < 60000);
  if (filtered.length === 0) return [];

  const maxVal = Math.max(...filtered.map(p => p.value), 1);
  const width = 280;
  const height = 40; // SVG is 50px tall, reserve 10px for labels

  return filtered.map((p, i) => {
    const xPct = (now - p.timestamp) / 60000; // 0 (now) to 1 (60s ago)
    const x = width - (xPct * width);
    const y = height - ((p.value / maxVal) * height);
    return { x: Math.round(x), y: Math.round(y) };
  });
});

// Grid lines only make sense once the sparkline has a scale.
const sparkMax = computed(() => {
  const data = (props.speedHistory || []).filter((p) => Date.now() - p.timestamp < 60000);
  return data.length ? Math.max(...data.map((p) => p.value)) : 0;
});

const sparkPointsStr = computed(() => {
  return sparkPoints.value.map(p => `${p.x},${p.y}`).join(' ');
});

// ── Buffer Health ────────────────────────────────────────────────

const healthDotClass = computed(() => {
  if (props.cachedChunks >= 5) return 'green';
  if (props.cachedChunks >= 1) return 'yellow';
  return 'red';
});

// ── Track Progress ───────────────────────────────────────────────

const trackProgressPct = computed(() => {
  if (props.trackTotalSize <= 0) return 0;
  return Math.min(100, (props.trackLoadedBytes / props.trackTotalSize) * 100);
});

const isFullyCached = computed(() => trackProgressPct.value >= 100);

const etaSeconds = computed(() => {
  if (isFullyCached.value || props.avgSpeed <= 0) return 0;
  const remainingBytes = props.trackTotalSize - props.trackLoadedBytes;
  return Math.max(0, remainingBytes / props.avgSpeed);
});

// ── Formatting Helpers ───────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

// ── Watch telemetry changes (debug) ─────────────────────────────

watch(() => props.cachedChunks, (val) => {
  log('telemetry update — cached:', val, 'downloading:', props.downloadingCount, 'stalls:', props.stallCount);
});

// ── Expose for parent access ─────────────────────────────────────

defineExpose({ isOpen, togglePanel });
</script>

<style scoped>
.settings-panel {
  background: #222;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}

.panel-content {
  display: flex;
  gap: 16px;
  padding: 12px;
  min-height: 140px;
}

/* ── Settings Section (Left) ─────────────────────────────────── */

.settings-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.settings-section h4,
.telemetry-section h4 {
  margin: 0;
  font-size: 0.85em;
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid #333;
  padding-bottom: 4px;
}

.setting-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.setting-row label,
.metric-row label {
  font-size: 0.8em;
  color: #999;
}

.slider-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.setting-slider {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #1a1a1a;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}

.setting-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #4CAF50;
  cursor: pointer;
}

.slider-value {
  font-size: 0.8em;
  color: #e0e0e0;
  min-width: 50px;
  text-align: right;
}

/* Speed cap */
.speed-select {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  padding: 4px 6px;
  font-size: 0.8em;
}

.custom-speed-input {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.custom-input {
  width: 70px;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  padding: 3px 6px;
  font-size: 0.8em;
}

.custom-speed-input span {
  font-size: 0.75em;
  color: #999;
}

/* ── Telemetry Section (Right) ──────────────────────────────── */

.telemetry-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.metric-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-row, .health-row {
  flex-direction: row;
  align-items: center;
  gap: 4px;
  font-size: 0.8em;
}

.stat-label {
  color: #999;
}

.stat-value {
  color: #e0e0e0;
}

.stat-sep {
  color: #666;
}

/* Memory bar */
.memory-bar-wrapper {
  flex-direction: column !important;
}

.memory-bar {
  height: 24px;
  background: #1a1a1a;
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}

.memory-fill {
  height: 100%;
  transition: width 0.5s ease, background-color 0.3s ease;
  min-width: 2%;
}

.memory-bar.green .memory-fill   { background: #4CAF50; }
.memory-bar.yellow .memory-fill  { background: #FFC107; }
.memory-bar.red .memory-fill     { background: #F44336; }

.memory-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 0.7em;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  white-space: nowrap;
}

/* Sparkline */
.sparkline-wrapper {
  flex-direction: column !important;
}

.sparkline {
  width: 100%;
  height: 50px;
}

/* Health dot */
.health-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.health-dot.green  { background: #4CAF50; }
.health-dot.yellow { background: #FFC107; }
.health-dot.red    { background: #F44336; }

/* Track progress */
.track-progress-wrapper {
  flex-direction: column !important;
}

.track-progress-bar {
  height: 12px;
  background: #1a1a1a;
  border-radius: 3px;
  overflow: hidden;
  position: relative;
}

.track-fill {
  height: 100%;
  background: #2196F3;
  transition: width 0.5s ease;
  min-width: 1%;
}

.fully-cached {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #4CAF50;
  font-size: 0.7em;
}

.track-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 0.65em;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  white-space: nowrap;
}

/* ── Chevron Toggle ─────────────────────────────────────────── */

.chevron-toggle {
  width: 100%;
  padding: 4px;
  background: #222;
  border: none;
  border-top: 1px solid #333;
  color: #666;
  font-size: 0.75em;
  cursor: pointer;
  transition: all 0.2s;
}

.chevron-toggle:hover {
  background: #2a2a2a;
  color: #999;
}

/* ── Collapsed State ─────────────────────────────────────────── */

.settings-panel.collapsed .panel-content {
  display: none;
}

/* ── Responsive ─────────────────────────────────────────────── */

@media (max-width: 768px) {
  .panel-content {
    flex-direction: column;
    gap: 12px;
  }
}
</style>
