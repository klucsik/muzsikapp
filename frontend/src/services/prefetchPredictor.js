/**
 * prefetchPredictor — Logic to determine which audio chunks should be prefetched.
 * 
 * Predicts upcoming chunk indices based on current playback position,
 * playlist order, and loop/repeat settings. This ensures that even if a user
 * is looping or transitioning between tracks, the buffer remains full of
 * relevant data.
 */

// Constants for prediction window
const CHUNK_DURATION = 30; // seconds (matches V2 design spec)
const PREFETCH_WINDOW_CHUNKS = 8; // How many chunks ahead to predict (~4 minutes)

/**
 * Predicts the next N chunk indices that should be prefetched.
 * 
 * @param {Object} state - Current playback state
 * @param {number} state.currentTrackIndex - Index of current track in playlist (0-based)
 * @param {number} state.currentTimeInSeconds - Playhead position within the current track
 * @param {Array<Object>} state.playlist - Array of track objects [{ id, duration }, ...]
 * @param {Object|null} settings.loopRegion - Optional loop region: { startSec, endSec } (seconds)
 * @param {string} settings.repeatMode - 'none', 'one' (current track), or 'all' (playlist)
 * @returns {number[]} An ordered list of unique chunk indices to prefetch next.
 */
export function predictNextChunks(state, settings = {}) {
  const { currentTrackIndex, currentTimeInSeconds, playlist } = state;
  const { loopRegion, repeatMode = 'none' } = settings;

  if (!playlist || !playlist[currentTrackIndex]) return [];

  const predictedIndices = new Set();
  let currentTrack = playlist[currentTrackIndex];
  
  // 1. Determine the effective "playback timeline" considering loop regions and repeat modes
  // We will simulate moving forward in time from currentTimeInSeconds to collect chunk indices.
  let simulationTime = currentTimeInSeconds;
  let simulationTrackIdx = currentTrackIndex;

  // Loop/Repeat logic: we'll explore up to PREFETCH_WINDOW_CHUNKS ahead of the playhead.
  // Each "step" in our simulation will be one CHUNK_DURATION.
  for (let i = 0; i < PREFETCH_WINDOW_CHUNKS; i++) {
    const chunkIndex = Math.floor(simulationTime / CHUNK_DURATION);
    predictedIndices.add(`${simulationTrackIdx}-${chunkIndex}`);

    // Move time forward by one chunk duration for the next iteration of simulation
    let nextSimTime = simulationTime + CHUNK_DURATION;

    // Check if we have crossed into a loop region or end of track
    if (loopRegion) {
      // If within loop, ensure our simulation stays inside [startSec, endSec]
      if (simulationTime >= loopRegion.endSec && nextSimTime <= loopRegion.endSec) {
        // We are at the end of a loop; wrap around to the start of the loop region
        nextSimTime = loopRegion.startSec + (nextSimTime - loopRegion.endSec);
      } else if (simulationTime < loopRegion.startSec && nextSimTime > loopRegion.startSec) {
        // We are approaching the start of a loop; wrap back to end of loop region? 
        // Usually, loops trigger when you reach the END. Let's stick to simple forward movement.
      }
    }

    // Handle track transitions if not looping or if we passed loop boundary
    if (simulationTime >= currentTrack.duration) {
      if (repeatMode === 'one') {
        // Stay on current track, wrap time back to 0
        nextSimTime = 0;
      } else if (repeatMode === 'all' || repeatMode === 'none') {
        simulationTrackIdx++;
        if (simulationTrackIdx < playlist.length) {
          currentTrack = playlist[simulationTrackIdx];
          nextSimTime = 0;
        } else {
          // End of playlist reached
          break;
        }
      } else {
        // Default: stop prediction at end of track/playlist
        break;
      }
    }

    simulationTime = nextSimTime;

    // Safety break if we exceed reasonable time (e.g., infinite loop in simulation)
    if (i > 100) break; 
  }

  // Convert internal string format "${trackIdx}-${chunkIdx}" back to a structured object or number?
  // The requirements say "ordered list of chunk indices". Since chunks are track-scoped, 
  // we should return an array of objects: { trackIndex, chunkIndex }.
  return Array.from(predictedIndices).map(id => {
    const [tIdx, cIdx] = id.split('-').map(Number);
    return { trackIndex: tIdx, chunkIndex: cIdx };
  });
}

/**
 * Helper to calculate the next N chunks for a specific track, 
 * ignoring other tracks (used when we want to prefetch upcoming songs).
 */
export function predictUpcomingTracksChunks(playlist, startTrackIdx, repeatMode = 'all') {
  const predictions = [];
  let currentIdx = startTrackIdx;

  while (currentIdx < playlist.length && predictions.length < PREFETCH_WINDOW_CHUNKS) {
    const track = playlist[currentIdx];
    // For new tracks, we want the first few chunks (e.g., 4 chunks)
    for (let c = 0; c < 4 && predictions.length < PREFETCH_WINDOW_CHUNKS; c++) {
      predictions.push({ trackIndex: currentIdx, chunkIndex: c });
    }
    currentIdx++;
  }

  return predictions;
}

export { CHUNK_DURATION };
