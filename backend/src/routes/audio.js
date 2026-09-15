import express from 'express';
import { createReadStream, statSync } from 'fs';
import { join } from 'path';
import { trackQueries } from '../db/database.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { buildManifest, getPlayMeta } from '../services/formatNormalizer.js';
import { getMimeType } from '../utils/audioFormat.js';

const router = express.Router();

/**
 * Get MIME type from file format
 */
/**
 * Stream audio file with Range request support
 * GET /audio/:trackId
 */
router.get('/:trackId', (req, res) => {
  try {
    const trackId = req.params.trackId;
    
    // Get track from database
    const track = trackQueries.getById(trackId);
    
    if (!track) {
      logger.warn({ trackId }, 'Track not found');
      return res.status(404).json({
        error: 'Track not found',
        id: trackId,
      });
    }
    
    // Build full file path
    const filePath = join(config.musicDir, track.filepath);
    
    // Check if file exists and get stats
    let fileStats;
    try {
      fileStats = statSync(filePath);
    } catch (error) {
      logger.error({ trackId, filePath, error: error.message }, 'Audio file not found');
      return res.status(404).json({
        error: 'Audio file not found on disk',
        id: trackId,
        filepath: track.filepath,
      });
    }
    
    const fileSize = fileStats.size;
    const range = req.headers.range;
    
    // Set common headers
    // Pass the whole track: ffprobe container strings like "M4A/isom/iso2" need the
    // filepath as a fallback before we can name a media type.
    const mimeType = getMimeType(track);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    
    if (range) {
      // Handle Range request (partial content)
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      
      // Validate range
      if (start >= fileSize || end >= fileSize) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        return res.end();
      }
      
      const chunkSize = (end - start) + 1;
      
      // Set partial content headers
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      
      // Stream the requested chunk
      const stream = createReadStream(filePath, { start, end });
      
      stream.on('error', (error) => {
        logger.error({ trackId, error: error.message }, 'Error streaming audio chunk');
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
      
      stream.pipe(res);
      
      logger.debug({ 
        trackId, 
        range: `${start}-${end}/${fileSize}`,
        title: track.title 
      }, 'Streaming audio chunk');
      
    } else {
      // No range request - stream entire file
      res.setHeader('Content-Length', fileSize);
      
      const stream = createReadStream(filePath);
      
      stream.on('error', (error) => {
        logger.error({ trackId, error: error.message }, 'Error streaming audio file');
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
      
      stream.pipe(res);
      
      logger.debug({ 
        trackId, 
        fileSize,
        title: track.title 
      }, 'Streaming full audio file');
    }
    
  } catch (error) {
    logger.error({ error, trackId: req.params.trackId }, 'Failed to stream audio');
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to stream audio',
        message: error.message,
      });
    }
  }
});

/**
 * V2 player (MSE) endpoint.
 *
 * Tracks are stored as fragmented MP4 (normalised in place on scan), so the client only
 * needs to know where each fragment starts: it fetches them by byte range from the ordinary
 * audio route above. A track that cannot be fragmented answers 415 with `fallback: 'v1'`
 * so the player can switch instead of failing.
 */

router.get('/:trackId/manifest', async (req, res) => {
  const track = trackQueries.getById(req.params.trackId);
  if (!track) {
    return res.status(404).json({ error: 'Track not found', id: req.params.trackId });
  }

  try {
    const meta = await getPlayMeta(track);
    res.setHeader('Cache-Control', 'no-cache');
    res.json(buildManifest(track, meta));
  } catch (error) {
    const status = error.code === 'UNSUPPORTED_FORMAT' ? 415 : error.code === 'ENOENT' ? 404 : 500;
    logger[status === 500 ? 'error' : 'warn'](
      { trackId: track.id, code: error.code, message: error.message },
      'Manifest request failed',
    );
    res.status(status).json({
      error: error.code || 'MANIFEST_FAILED',
      message: error.message,
      fallback: 'v1',
    });
  }
});

export default router;
