import express from 'express';
import { getSyncController } from '../websocket/socketServer.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Play a track
 * POST /api/playback/play
 * Body: { trackId: string, startPosition?: number, playlistIndex?: number }
 */
router.post('/play', async (req, res) => {
  try {
    const { trackId, startPosition = 0, roomId = 'room-1', playlistIndex = null } = req.body;

    if (!trackId) {
      return res.status(400).json({
        error: 'Missing required field: trackId',
      });
    }

    const syncController = getSyncController();
    const result = await syncController.playTrack(trackId, roomId, startPosition, playlistIndex);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to play track');
    res.status(500).json({
      error: 'Failed to play track',
      message: error.message,
    });
  }
});

/**
 * Pause playback
 * POST /api/playback/pause
 */
router.post('/pause', (req, res) => {
  try {
    const { roomId = 'room-1' } = req.body;
    const syncController = getSyncController();
    const result = syncController.pause(roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to pause playback');
    res.status(500).json({
      error: 'Failed to pause playback',
      message: error.message,
    });
  }
});

/**
 * Resume playback
 * POST /api/playback/resume
 */
router.post('/resume', (req, res) => {
  try {
    const { roomId = 'room-1' } = req.body;
    const syncController = getSyncController();
    const result = syncController.resume(roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to resume playback');
    res.status(500).json({
      error: 'Failed to resume playback',
      message: error.message,
    });
  }
});

/**
 * Stop playback
 * POST /api/playback/stop
 */
router.post('/stop', (req, res) => {
  try {
    const { roomId = 'room-1' } = req.body;
    const syncController = getSyncController();
    const result = syncController.stop(roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to stop playback');
    res.status(500).json({
      error: 'Failed to stop playback',
      message: error.message,
    });
  }
});

/**
 * Seek to position
 * POST /api/playback/seek
 * Body: { position: number }
 */
router.post('/seek', (req, res) => {
  try {
    const { position, roomId = 'room-1' } = req.body;

    if (typeof position !== 'number') {
      return res.status(400).json({
        error: 'Missing or invalid field: position',
      });
    }

    const syncController = getSyncController();
    const result = syncController.seek(position, roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to seek');
    res.status(500).json({
      error: 'Failed to seek',
      message: error.message,
    });
  }
});

/**
 * Set volume
 * POST /api/playback/volume
 * Body: { volume: number } (0.0 to 1.0)
 */
router.post('/volume', (req, res) => {
  try {
    const { volume, roomId = 'room-1' } = req.body;

    if (typeof volume !== 'number') {
      return res.status(400).json({
        error: 'Missing or invalid field: volume',
      });
    }

    const syncController = getSyncController();
    const result = syncController.setVolume(volume, roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to set volume');
    res.status(500).json({
      error: 'Failed to set volume',
      message: error.message,
    });
  }
});

/**
 * Toggle repeat mode
 * POST /api/playback/repeat
 */
router.post('/repeat', (req, res) => {
  try {
    const { roomId = 'room-1' } = req.body;
    const syncController = getSyncController();
    const result = syncController.toggleRepeat(roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to toggle repeat mode');
    res.status(500).json({
      error: 'Failed to toggle repeat mode',
      message: error.message,
    });
  }
});

/**
 * Toggle loop playlist mode
 * POST /api/playback/loop
 */
router.post('/loop', (req, res) => {
  try {
    const { roomId = 'room-1' } = req.body;
    const syncController = getSyncController();
    const result = syncController.toggleLoop(roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to toggle loop playlist mode');
    res.status(500).json({
      error: 'Failed to toggle loop playlist mode',
      message: error.message,
    });
  }
});

/**
 * Set custom loop points for repeat mode
 * POST /api/playback/loop-points
 * Body: { loopStart: number, loopEnd: number } (in seconds)
 */
router.post('/loop-points', (req, res) => {
  try {
    const { loopStart, loopEnd, roomId = 'room-1' } = req.body;

    // `typeof NaN === 'number'`, and a NaN region poisons every position check in the room.
    if (!Number.isFinite(loopStart) || !Number.isFinite(loopEnd)) {
      return res.status(400).json({
        error: 'Invalid loop points: both loopStart and loopEnd must be numbers',
      });
    }

    if (loopStart < 0 || loopEnd <= loopStart) {
      return res.status(400).json({
        error: 'Invalid loop points: loopStart must be >= 0 and loopEnd must be > loopStart',
      });
    }

    const syncController = getSyncController();
    const result = syncController.setLoopPoints(loopStart, loopEnd, roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to set loop points');
    res.status(500).json({
      error: 'Failed to set loop points',
      message: error.message,
    });
  }
});

/**
 * Clear custom loop points (use full track for repeat)
 * DELETE /api/playback/loop-points
 */
router.delete('/loop-points', (req, res) => {
  try {
    const { roomId = 'room-1' } = req.body;
    const syncController = getSyncController();
    const result = syncController.clearLoopPoints(roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to clear loop points');
    res.status(500).json({
      error: 'Failed to clear loop points',
      message: error.message,
    });
  }
});

/**
 * Play next track in playlist
 * POST /api/playback/next
 */
router.post('/next', async (req, res) => {
  try {
    const { roomId = 'room-1' } = req.body;
    const syncController = getSyncController();
    const result = await syncController.playNextTrack(roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to play next track');
    res.status(500).json({
      error: 'Failed to play next track',
      message: error.message,
    });
  }
});

/**
 * Play previous track in playlist
 * POST /api/playback/previous
 */
router.post('/previous', async (req, res) => {
  try {
    const { roomId = 'room-1' } = req.body;
    const syncController = getSyncController();
    const result = await syncController.playPreviousTrack(roomId);

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to play previous track');
    res.status(500).json({
      error: 'Failed to play previous track',
      message: error.message,
    });
  }
});

/**
 * Get current playback state
 * GET /api/playback/state
 */
router.get('/state', (req, res) => {
  try {
    const { roomId = 'room-1' } = req.query;
    const syncController = getSyncController();
    const state = syncController.getState(roomId);

    res.json(state);
  } catch (error) {
    logger.error({ error }, 'Failed to get playback state');
    res.status(500).json({
      error: 'Failed to get playback state',
      message: error.message,
    });
  }
});

export default router;
