/**
 * useTelemetry — Singleton composable for monitoring player performance telemetry.
 * 
 * Provides reactive state for memory usage, download speed (sparkline data),
 * and playback stall metrics. Designed to be used by SettingsPanel.vue.
 */

import { ref, onMounted, onUnmounted } from 'vue';

/** @typedef {{ timestamp: number, value: number }} TelemetryPoint */

export function useTelemetry(config = { maxMemoryBytes: 50 * 1024 * 1024 }) {
  // ── Reactive State ─────────────────────────────────────────────

  /** Current memory usage of the chunk cache (in bytes) */
  const usedMemory = ref(0);
  /** Total configured cache limit (in bytes) */
  const totalMemory = ref(config.maxMemoryBytes);

  /** Array of { timestamp, value } representing rolling 60s window of download speeds (bytes/sec) */
  const speedHistory = ref([]); // Array<TelemetryPoint>

  /** Total number of playback stalls recorded since last track start */
  const stallCount = ref(0);
  /** Cumulative time spent in stalled state (in seconds) */
  const totalStallDuration = ref(0);

  // ── Internal State ─────────────────────────────────────────────

  let _lastFetchTime = 0;
  let _lastFetchBytes = 0;
  let _stallStartTime = null;
  let _intervalId = null;

  // ── Public Methods (to be called by useMseBuffer or other services) ─

  /**
   * Record a completed chunk download to update speed and memory telemetry.
   * @param {number} bytesDownloaded - Size of the downloaded chunk in bytes
   * @param {number} durationSec - Time taken for the download in seconds
   */
  function recordDownload(bytesDownloaded, durationSec) {
    if (durationSec <= 0) return;

    // Update speed history: calculate average rate for this segment
    const bps = bytesDownloaded / durationSec;
    const now = Date.now();
    speedHistory.value = [
      ...speedHistory.value,
      { timestamp: now, value: bps }
    ].filter(p => now - p.timestamp < 60000); // Keep only last 60 seconds

    // Update memory usage (this is actually managed by the cache itself, but we sync it here)
    usedMemory.value += bytesDownloaded; // Note: this is a simplified approximation for telemetry
  }

  /**
   * Signal that a download failed or was aborted.
   */
  function recordDownloadError() {
    // We don't increment speed on error, but we might want to track it if needed
  }

  /**
   * Record the start of a playback stall (e.s. when audio buffer runs low).
   */
  function recordStallStart() {
    if (_stallStartTime) return; // Already stalling
    _stallStartTime = Date.now();
    stallCount.value++;
  }

  /**
   * Record the end of a playback stall.
   */
  function recordStallEnd() {
    if (!_stallStartTime) return;
    const durationSec = (Date.now() - _stallStartTime) / 1000;
    totalStallDuration.value += durationSec;
    _stallStartTime = null;
  }

  /**
   * Update current memory usage directly from the cache object.
   * @param {number} bytes 
   */
  function updateMemoryUsage(bytes) {
    usedMemory.value = bytes;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  onMounted(() => {
    _intervalId = setInterval(() => {
      // Periodic cleanup of history is handled in recordDownload, but we can prune here too if needed
    }, 1000);
  });

  onUnmounted(() => {
    if (_intervalId) clearInterval(_intervalId);
    if (_stallStartTime) {
      const durationSec = (Date.now() - _stallStartTime) / 1000;
      totalStallDuration.value += durationSec;
    }
  });

  return {
    usedMemory,
    totalMemory,
    speedHistory,
    stallCount,
    totalStallDuration,
    recordDownload,
    recordDownloadError,
    recordStallStart,
    recordStallEnd,
    updateMemoryUsage,
  };
}

// Create a singleton instance for global access in the frontend app
export const telemetry = useTelemetry({ maxMemoryBytes: 50 * 1024 * 1024 });
