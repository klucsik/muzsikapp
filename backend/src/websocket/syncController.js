import { trackQueries } from '../db/database.js';
import logger from '../utils/logger.js';
import sessionState from './sessionState.js'; // Legacy for backward compatibility
import roomStateManager from './roomState.js';
import config from '../config/config.js';

/**
 * Sync Controller - Handles playback synchronization commands
 * Now supports multiple rooms with isolated playback state
 */
class SyncController {
  constructor(io) {
    this.io = io;
    this.positionCheckInterval = null;
  }

  /**
   * Initialize sync controller
   */
  init() {
    logger.info('Sync controller initialized with room support');
    
    // Start periodic position checks for all rooms
    this.startPositionChecks();
  }

  /**
   * Play a track in a specific room
   */
  async playTrack(trackId, roomId = 'room-1', startPosition = 0, playlistIndex = null) {
    try {
      logger.info({ trackId, roomId, startPosition, playlistIndex }, 'Playing track in room');
      
      // Get track from database
      const track = trackQueries.getById(trackId);
      
      if (!track) {
        logger.warn({ trackId, roomId }, 'Track not found for playback');
        throw new Error('Track not found');
      }

      // Get room state
      const roomState = roomStateManager.getRoomState(roomId);

      // Update session state with playlist index
      roomState.playTrack(track, startPosition, playlistIndex);

      // Calculate scheduled start time (1 second from now for buffer)
      const scheduledStartTime = Date.now() + 1000;

      // Broadcast to all clients in this room
      const payload = {
        event: 'play_track',
        data: {
          trackId: track.id,
          streamUrl: `/audio/${track.id}`,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          startPosition,
          scheduledStartTime,
          // Loop points belong to the track being started, so the room is told what they are at
          // the same moment it is told what is playing. Read after `roomState.playTrack()`, which
          // clears a region left over from a different track.
          loopStart: roomState.loopStart,
          loopEnd: roomState.loopEnd,
          serverTimestamp: Date.now(),
          roomId,
        },
      };

      this.io.to(roomId).emit('play_track', payload.data);

      logger.info({ 
        trackId, 
        roomId,
        title: track.title,
        duration: track.duration,
        playlistIndex
      }, 'Track playing in room');

      return { success: true, state: roomState.getState() };
    } catch (error) {
      logger.error({ error, trackId, roomId }, 'Failed to play track');
      throw error;
    }
  }

  /**
   * Pause playback in a specific room
   */
  pause(roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    const stateBefore = roomState.playbackState;
    roomState.pause();
    const stateAfter = roomState.playbackState;

    const payload = {
      event: 'pause',
      data: {
        position: roomState.getCurrentPosition(),
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('pause', payload.data);

    logger.info({ 
      position: payload.data.position,
      roomId,
      stateBefore,
      stateAfter
    }, 'Playback paused in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Resume playback in a specific room
   */
  resume(roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    
    if (!roomState.hasTrack()) {
      throw new Error('No track to resume');
    }

    roomState.resume();

    // Calculate scheduled start time
    const scheduledStartTime = Date.now() + 1000;

    const payload = {
      event: 'resume',
      data: {
        position: roomState.getCurrentPosition(),
        scheduledStartTime,
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('resume', payload.data);

    logger.info({ position: payload.data.position, roomId }, 'Playback resumed in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Stop playback in a specific room
   */
  stop(roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    roomState.stop();

    const payload = {
      event: 'stop',
      data: {
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('stop', payload.data);

    logger.info({ roomId }, 'Playback stopped in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Seek to position in a specific room
   */
  seek(position, roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    
    if (!roomState.hasTrack()) {
      throw new Error('No track loaded');
    }

    roomState.seek(position);

    // Calculate scheduled start time if playing
    const scheduledStartTime = roomState.isPlaying() 
      ? Date.now() + 1000 
      : null;

    const payload = {
      event: 'seek',
      data: {
        position,
        scheduledStartTime,
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('seek', payload.data);

    logger.info({ position, roomId }, 'Seeked to position in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Set volume in a specific room
   */
  setVolume(volume, roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    roomState.setVolume(volume);

    const payload = {
      event: 'volume_change',
      data: {
        volume: roomState.volume,
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('volume_change', payload.data);

    logger.info({ volume: roomState.volume, roomId }, 'Volume changed in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Toggle repeat mode in a specific room
   */
  toggleRepeat(roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    roomState.toggleRepeat();

    const payload = {
      event: 'repeat_mode_change',
      data: {
        repeatMode: roomState.repeatMode,
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('repeat_mode_change', payload.data);

    logger.info({ repeatMode: roomState.repeatMode, roomId }, 'Repeat mode changed in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Toggle loop playlist mode in a specific room
   */
  toggleLoop(roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    roomState.toggleLoop();

    const payload = {
      event: 'loop_mode_change',
      data: {
        loopPlaylist: roomState.loopPlaylist,
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('loop_mode_change', payload.data);

    logger.info({ loopPlaylist: roomState.loopPlaylist, roomId }, 'Loop playlist mode changed in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Set custom loop points in a specific room
   */
  setLoopPoints(loopStart, loopEnd, roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    roomState.setLoopPoints(loopStart, loopEnd);

    const payload = {
      event: 'loop_points_change',
      data: {
        loopStart: roomState.loopStart,
        loopEnd: roomState.loopEnd,
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('loop_points_change', payload.data);

    logger.info({ loopStart, loopEnd, roomId }, 'Loop points changed in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Clear custom loop points in a specific room
   */
  clearLoopPoints(roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    roomState.clearLoopPoints();

    const payload = {
      event: 'loop_points_change',
      data: {
        loopStart: null,
        loopEnd: null,
        serverTimestamp: Date.now(),
        roomId,
      },
    };

    this.io.to(roomId).emit('loop_points_change', payload.data);

    logger.info({ roomId }, 'Loop points cleared in room');

    return { success: true, state: roomState.getState() };
  }

  /**
   * Get current state for a specific room
   */
  getState(roomId = 'room-1') {
    const roomState = roomStateManager.getRoomState(roomId);
    return roomState.getState();
  }

  /**
   * Play next track in playlist for a specific room
   */
  async playNextTrack(roomId = 'room-1') {
    try {
      const { collectionQueries } = await import('../db/database.js');
      const roomState = roomStateManager.getRoomState(roomId);
      const room = roomStateManager.getRoom(roomId);
      
      // Get current playlist for this room
      const result = collectionQueries.getCollectionTracks(room.playlistCollectionId, 1000, 0);
      const playlist = result.tracks || [];
      
      logger.info({ 
        playlistLength: playlist.length, 
        roomId,
        currentTrack: roomState.currentTrack?.title 
      }, 'Playing next track in room');
      
      if (playlist.length === 0) {
        logger.info({ roomId }, 'Playlist is empty, stopping playback');
        this.stop(roomId);
        return { success: false, reason: 'empty_playlist' };
      }

      const currentTrack = roomState.currentTrack;
      if (!currentTrack) {
        // No current track, start from the beginning
        logger.info({ roomId }, 'No current track, starting from first track');
        const firstTrack = playlist[0];
        await this.playTrack(firstTrack.id, roomId, 0, 0);
        return { success: true };
      }

      // Use the stored playlist index instead of searching by ID
      // This properly handles duplicate tracks in the playlist
      let currentIndex = roomState.currentTrackPlaylistIndex;
      
      // If index is not set, try to find it (fallback)
      if (currentIndex === null || currentIndex === undefined) {
        logger.warn({ roomId }, 'Playlist index not tracked, falling back to ID search');
        currentIndex = playlist.findIndex(t => t.id === currentTrack.id);
      }
      
      if (currentIndex === -1) {
        // Current track not in playlist, can't advance
        logger.info({ roomId }, 'Current track not in playlist, stopping playback');
        this.stop(roomId);
        return { success: false, reason: 'track_not_in_playlist' };
      }

      // Check if there's a next track
      if (currentIndex < playlist.length - 1) {
        // Play next track
        const nextTrack = playlist[currentIndex + 1];
        logger.info({ 
          currentIndex, 
          nextIndex: currentIndex + 1, 
          roomId,
          nextTrackTitle: nextTrack.title 
        }, 'Playing next track in sequence');
        await this.playTrack(nextTrack.id, roomId, 0, currentIndex + 1);
        return { success: true };
      }
      
      // We're at the end of the playlist
      if (roomState.loopPlaylist && playlist.length > 0) {
        // Loop back to the first track
        const firstTrack = playlist[0];
        logger.info({ 
          firstTrackTitle: firstTrack.title,
          roomId,
          playlistLength: playlist.length 
        }, 'Looping playlist - playing first track');
        await this.playTrack(firstTrack.id, roomId, 0, 0);
        return { success: true };
      }
      
      // No loop mode - just stop
      logger.info({ roomId }, 'End of playlist reached, stopping playback');
      this.stop(roomId);
      return { success: false, reason: 'end_of_playlist' };
      
    } catch (error) {
      logger.error({ error, roomId }, 'Failed to play next track');
      throw error;
    }
  }

  /**
   * Play previous track in playlist for a specific room
   */
  async playPreviousTrack(roomId = 'room-1') {
    try {
      const { collectionQueries } = await import('../db/database.js');
      const roomState = roomStateManager.getRoomState(roomId);
      const room = roomStateManager.getRoom(roomId);
      
      // Get current playlist for this room
      const result = collectionQueries.getCollectionTracks(room.playlistCollectionId, 1000, 0);
      const playlist = result.tracks || [];
      
      logger.info({ 
        playlistLength: playlist.length, 
        roomId,
        currentTrack: roomState.currentTrack?.title 
      }, 'Playing previous track in room');
      
      if (playlist.length === 0) {
        logger.info({ roomId }, 'Playlist is empty, stopping playback');
        this.stop(roomId);
        return { success: false, reason: 'empty_playlist' };
      }

      const currentTrack = roomState.currentTrack;
      if (!currentTrack) {
        // No current track, start from the end
        logger.info({ roomId }, 'No current track, starting from last track');
        const lastTrack = playlist[playlist.length - 1];
        await this.playTrack(lastTrack.id, roomId, 0, playlist.length - 1);
        return { success: true };
      }

      // Use the stored playlist index instead of searching by ID
      // This properly handles duplicate tracks in the playlist
      let currentIndex = roomState.currentTrackPlaylistIndex;
      
      // If index is not set, try to find it (fallback)
      if (currentIndex === null || currentIndex === undefined) {
        logger.warn({ roomId }, 'Playlist index not tracked, falling back to ID search');
        currentIndex = playlist.findIndex(t => t.id === currentTrack.id);
      }
      
      if (currentIndex === -1) {
        // Current track not in playlist, can't advance
        logger.info({ roomId }, 'Current track not in playlist, stopping playback');
        this.stop(roomId);
        return { success: false, reason: 'track_not_in_playlist' };
      }

      // Check if there's a previous track
      if (currentIndex > 0) {
        // Play previous track
        const prevTrack = playlist[currentIndex - 1];
        logger.info({ 
          currentIndex, 
          prevIndex: currentIndex - 1, 
          roomId,
          prevTrackTitle: prevTrack.title 
        }, 'Playing previous track in sequence');
        await this.playTrack(prevTrack.id, roomId, 0, currentIndex - 1);
        return { success: true };
      }
      
      // We're at the beginning of the playlist
      if (roomState.loopPlaylist && playlist.length > 0) {
        // Loop back to the last track
        const lastTrack = playlist[playlist.length - 1];
        logger.info({ 
          lastTrackTitle: lastTrack.title,
          roomId,
          playlistLength: playlist.length 
        }, 'Looping playlist - playing last track');
        await this.playTrack(lastTrack.id, roomId, 0, playlist.length - 1);
        return { success: true };
      }
      
      // No loop mode - just stop
      logger.info({ roomId }, 'Beginning of playlist reached, stopping playback');
      this.stop(roomId);
      return { success: false, reason: 'beginning_of_playlist' };
      
    } catch (error) {
      logger.error({ error, roomId }, 'Failed to play previous track');
      throw error;
    }
  }

  /**
   * Start periodic position checks for all rooms
   */
  startPositionChecks() {
    // Start position check for each room
    const rooms = roomStateManager.getAllRooms();
    
    rooms.forEach(room => {
      const intervalId = setInterval(() => {
        const roomState = roomStateManager.getRoomState(room.id);
        const currentPosition = roomState.getCurrentPosition();
        const isPlaying = roomState.isPlaying();
        
        // Only send position checks when actively playing
        if (isPlaying) {
          const payload = {
            event: 'position_check',
            data: {
              expectedPosition: currentPosition,
              maxDrift: config.maxDriftSeconds,
              serverTimestamp: Date.now(),
              roomId: room.id,
            },
          };

          this.io.to(room.id).emit('position_check', payload.data);

          logger.debug({ 
            position: currentPosition.toFixed(2),
            roomId: room.id
          }, 'Position check sent to room');
        }
      }, config.positionCheckInterval);

      roomStateManager.setRoomInterval(room.id, intervalId);
      
      logger.info({ 
        roomId: room.id,
        interval: config.positionCheckInterval 
      }, 'Position check interval started for room');
    });
  }

  /**
   * Stop position checks for all rooms
   */
  stopPositionChecks() {
    roomStateManager.cleanup();
    logger.info('All position check intervals stopped');
  }

  /**
   * Handle client position report (for monitoring)
   */
  handlePositionReport(clientId, roomId, data) {
    logger.debug({ 
      clientId,
      roomId,
      position: data.position,
      state: data.state 
    }, 'Client position report');
  }

  /**
   * Handle client error
   */
  handleClientError(clientId, roomId, error) {
    logger.error({ clientId, roomId, error }, 'Client reported error');
  }

  /**
   * Handle track ended event from client
   */
  async handleTrackEnded(clientId, roomId) {
    const roomState = roomStateManager.getRoomState(roomId);
    
    logger.info({ 
      clientId,
      roomId,
      currentTrack: roomState.currentTrack?.title,
      repeatMode: roomState.repeatMode
    }, 'Track ended event received from client');
    
    // Check if repeat mode is enabled
    if (roomState.repeatMode && roomState.currentTrack) {
      logger.info({ trackId: roomState.currentTrack.id, roomId }, 'Repeat mode: replaying current track');
      try {
        // If custom loop points are set, start at loopStart, otherwise start at 0
        const startPosition = roomState.loopStart !== null ? roomState.loopStart : 0;
        // Pass the current playlist index when repeating
        await this.playTrack(roomState.currentTrack.id, roomId, startPosition, roomState.currentTrackPlaylistIndex);
      } catch (error) {
        logger.error({ error, clientId, roomId }, 'Failed to replay track in repeat mode');
      }
      return;
    }
    
    // Not repeating - try to play next track in playlist
    try {
      await this.playNextTrack(roomId);
    } catch (error) {
      logger.error({ error, clientId, roomId }, 'Failed to play next track after track ended');
    }
  }

  /**
   * Cleanup
   */
  cleanup() {
    this.stopPositionChecks();
  }
}

export default SyncController;
