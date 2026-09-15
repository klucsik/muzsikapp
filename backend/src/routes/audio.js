import express from 'express';
import { createReadStream, statSync } from 'fs';
import { join } from 'path';
import { trackQueries } from '../db/database.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { getManifest, getInitFile, getSegmentFile } from '../services/segmenter.js';
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
 * V2 player (MSE) endpoints.
 *
 * Progressive MP4 cannot be fed to a SourceBuffer, so the backend remuxes it into
 * fragmented segments on first request and caches the result. A track that is not
 * segmentable answers 415 with `fallback: 'v1'` so the client can switch players.
 */

const SEGMENT_STATUS = {
  UNSUPPORTED_FORMAT: 415,
  SOURCE_MISSING: 404,
  NOT_SEGMENTED: 404,
  SEGMENT_OUT_OF_RANGE: 404,
};

function segmentError(res, error, trackId) {
  const status = SEGMENT_STATUS[error.code] || 500;
  logger[status === 500 ? 'error' : 'warn'](
    { trackId, code: error.code, message: error.message },
    'Segment request failed',
  );
  res.status(status).json({
    error: error.code || 'SEGMENT_FAILED',
    message: error.message,
    ...(error.code === 'UNSUPPORTED_FORMAT' ? { fallback: 'v1' } : {}),
  });
}

/**
 * GET /api/audio/:trackId/manifest
 * Triggers conversion when needed. This is the V2 "switchover" call.
 */
router.get('/:trackId/manifest', async (req, res) => {
  const track = trackQueries.getById(req.params.trackId);
  if (!track) {
    return res.status(404).json({ error: 'Track not found', id: req.params.trackId });
  }

  try {
    const manifest = await getManifest(track, { force: req.query.force === '1' });
    res.setHeader('Cache-Control', 'no-cache');
    res.json(manifest);
  } catch (error) {
    segmentError(res, error, track.id);
  }
});

/**
 * GET /api/audio/:trackId/init   — the ftyp+moov init segment
 */
router.get('/:trackId/init', async (req, res) => {
  try {
    const { manifest, path } = await getInitFile(req.params.trackId);
    res.setHeader('Content-Type', manifest.mime);
    res.sendFile(path, { cacheControl: true, maxAge: 31536000000, immutable: true }, (err) => {
      if (err && !res.headersSent) segmentError(res, err, req.params.trackId);
    });
  } catch (error) {
    segmentError(res, error, req.params.trackId);
  }
});

/**
 * GET /api/audio/:trackId/segment/:index
 */
router.get('/:trackId/segment/:index', async (req, res) => {
  try {
    const { manifest, segment, path } = await getSegmentFile(req.params.trackId, req.params.index);
    res.setHeader('Content-Type', manifest.mime);
    res.setHeader('X-Track-Duration', String(manifest.duration));
    res.setHeader('X-Range', `${segment.start}-${segment.end}`);
    res.sendFile(path, { cacheControl: true, maxAge: 31536000000, immutable: true }, (err) => {
      if (err && !res.headersSent) segmentError(res, err, req.params.trackId);
    });
  } catch (error) {
    segmentError(res, error, req.params.trackId);
  }
});

export default router;
