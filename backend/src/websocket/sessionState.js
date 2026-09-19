/**
 * Session state management
 * Tracks the current playback state for a room
 * Simplified: Server only tracks state, clients handle timing and report when tracks end
 */

export class SessionState {
  constructor() {
    this.currentTrack = null;
    this.currentTrackPlaylistIndex = null; // Track position in playlist, not just track ID
    this.playbackState = 'stopped'; // 'playing', 'paused', 'stopped'
    this.position = 0; // Current position in seconds
    this.lastUpdateTime = null; // Server timestamp of last state change
    this.volume = 0.7; // 0.0 to 1.0
    this.repeatMode = false; // Whether to repeat the current track
    this.loopPlaylist = false; // Whether to loop the entire playlist
    this.loopStart = null; // Custom loop start point in seconds (null = beginning)
    this.loopEnd = null; // Custom loop end point in seconds (null = end of track)
  }

  /**
   * Start playing a track
   */
  playTrack(track, startPosition = 0, playlistIndex = null) {
    // A loop region is a slice of one track, so it cannot follow playback onto the next one —
    // clients clear their markers on `play_track` and would then ignore a region the server
    // still wraps positions inside. Repeating the *same* track keeps it, which is what makes
    // “repeat this section” survive the replay the server performs on `track_ended`.
    const previousId = this.currentTrack?.id ?? null;
    if ((!track || previousId !== track.id) && (this.loopStart !== null || this.loopEnd !== null)) {
      this.loopStart = null;
      this.loopEnd = null;
    }

    this.currentTrack = track;
    this.currentTrackPlaylistIndex = playlistIndex;
    this.playbackState = 'playing';
    this.position = startPosition;
    this.lastUpdateTime = Date.now();
    
    return this.getState();
  }

  /**
   * Pause playback
   */
  pause() {
    if (this.playbackState === 'playing') {
      // Update position to current time
      if (this.lastUpdateTime) {
        const elapsed = (Date.now() - this.lastUpdateTime) / 1000;
        this.position += elapsed;
      }
      // Cap position at duration if exceeded
      if (this.currentTrack && this.position > this.currentTrack.duration) {
        this.position = this.currentTrack.duration;
      }
    }
    
    this.playbackState = 'paused';
    this.lastUpdateTime = Date.now();
    
    return this.getState();
  }

  /**
   * Resume playback
   */
  resume() {
    if (this.playbackState === 'paused' && this.currentTrack) {
      this.playbackState = 'playing';
      this.lastUpdateTime = Date.now();
    }
    
    return this.getState();
  }

  /**
   * Stop playback
   */
  stop() {
    this.playbackState = 'stopped';
    this.position = 0;
    this.lastUpdateTime = Date.now();
    this.currentTrack = null; // Clear track to prevent auto-restart
    this.currentTrackPlaylistIndex = null; // Clear playlist index
    
    return this.getState();
  }

  /**
   * Seek to a specific position
   */
  seek(position) {
    this.position = position;
    this.lastUpdateTime = Date.now();
    
    return this.getState();
  }

  /**
   * Set volume
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    return this.getState();
  }

  /**
   * Toggle repeat mode
   */
  toggleRepeat() {
    this.repeatMode = !this.repeatMode;
    return this.getState();
  }

  /**
   * Set repeat mode
   */
  setRepeat(enabled) {
    this.repeatMode = !!enabled;
    return this.getState();
  }

  /**
   * Toggle loop playlist mode
   */
  toggleLoop() {
    this.loopPlaylist = !this.loopPlaylist;
    return this.getState();
  }

  /**
   * Set loop playlist mode
   */
  setLoop(enabled) {
    this.loopPlaylist = !!enabled;
    return this.getState();
  }

  /**
   * Set custom loop points
   */
  setLoopPoints(loopStart, loopEnd) {
    if (
      !Number.isFinite(loopStart) || !Number.isFinite(loopEnd)
      || loopStart < 0 || loopEnd <= loopStart
    ) {
      return this.getState();
    }

    // A region that starts past the end of the loaded track can never be reached, so “repeat
    // this section” would silently degrade into “repeat the whole track”. Clamping also stops a
    // region from the previous (longer) track outrunning the short one now loaded.
    const duration = Number(this.currentTrack?.duration);
    if (Number.isFinite(duration) && duration > 0) {
      loopEnd = Math.min(loopEnd, duration);
      loopStart = Math.min(loopStart, Math.max(0, loopEnd - 0.5));
    }

    this.loopStart = loopStart;
    this.loopEnd = loopEnd;
    return this.getState();
  }

  /**
   * Clear custom loop points (use full track)
   */
  clearLoopPoints() {
    this.loopStart = null;
    this.loopEnd = null;
    return this.getState();
  }

  /**
   * Get current expected position (for sync checks)
   */
  getCurrentPosition() {
    if (this.playbackState === 'playing' && this.lastUpdateTime) {
      const elapsed = (Date.now() - this.lastUpdateTime) / 1000;
      let position = this.position + elapsed;
      
      // If we have custom loop points in repeat mode, handle position wrapping
      if (this.repeatMode && this.loopEnd !== null) {
        const loopStart = this.loopStart !== null ? this.loopStart : 0;
        const loopDuration = this.loopEnd - loopStart;
        
        if (loopDuration > 0 && position >= this.loopEnd) {
          // Calculate how many times we've looped and where we should be
          const overrun = position - this.loopEnd;
          const loops = Math.floor(overrun / loopDuration);
          position = loopStart + (overrun % loopDuration);
        }
      }
      
      return position;
    }
    return this.position;
  }

  /**
   * Get complete state object
   */
  getState() {
    return {
      currentTrack: this.currentTrack,
      playbackState: this.playbackState,
      position: this.getCurrentPosition(),
      lastUpdateTime: this.lastUpdateTime,
      volume: this.volume,
      repeatMode: this.repeatMode,
      loopPlaylist: this.loopPlaylist,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      serverTime: Date.now(),
    };
  }

  /**
   * Check if a track is currently loaded
   */
  hasTrack() {
    return this.currentTrack !== null;
  }

  /**
   * Check if currently playing
   */
  isPlaying() {
    return this.playbackState === 'playing';
  }
}

// Legacy singleton instance for backward compatibility
const sessionState = new SessionState();

export default sessionState;
