import express from 'express';
import logger from '../utils/logger.js';
import downloadQueue from '../services/downloadQueue.js';
import { authRequired } from '../middleware/auth.js';
import { 
  searchYouTube, 
  isValidYouTubeUrl, 
  fetchVideoMetadata, 
  isPlaylistUrl, 
  fetchPlaylistMetadata 
} from '../services/ytdlpDownloader.js';

const router = express.Router();

/**
 * Search YouTube for videos
 * GET /api/downloads/search?q=search+query&limit=10
 */
router.get('/search', async (req, res) => {
  try {
    const { q: query, limit = 10 } = req.query;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({
        error: 'Search query is required',
      });
    }
    
    const limitNum = parseInt(limit, 10);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 50) {
      return res.status(400).json({
        error: 'Limit must be between 1 and 50',
      });
    }
    
    logger.info({ query, limit: limitNum }, 'YouTube search requested');
    
    const results = await searchYouTube(query, limitNum);
    
    res.json({
      query,
      results,
      count: results.length,
    });
    
  } catch (error) {
    logger.error({ error }, 'YouTube search failed');
    res.status(500).json({
      error: 'Search failed',
      message: error.message,
    });
  }
});

/**
 * Fetch playlist information
 * GET /api/downloads/playlist?url=playlist_url
 */
router.get('/playlist', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Playlist URL is required',
      });
    }
    
    if (!isPlaylistUrl(url)) {
      return res.status(400).json({
        error: 'Invalid playlist URL',
      });
    }
    
    logger.info({ url }, 'Playlist info requested');
    
    const playlistData = await fetchPlaylistMetadata(url);
    
    res.json(playlistData);
    
  } catch (error) {
    logger.error({ error }, 'Failed to fetch playlist info');
    res.status(500).json({
      error: 'Failed to fetch playlist information',
      message: error.message,
    });
  }
});

/**
 * Add all videos from a playlist to download queue
 * POST /api/downloads/playlist
 * Body: { playlistUrl: string, folder_ids?: array }
 */
router.post('/playlist', authRequired(), async (req, res) => {
  try {
    const { playlistUrl, folder_ids } = req.body;
    
    if (!playlistUrl || typeof playlistUrl !== 'string') {
      return res.status(400).json({
        error: 'Playlist URL is required',
      });
    }
    
    if (!isPlaylistUrl(playlistUrl)) {
      return res.status(400).json({
        error: 'Invalid playlist URL',
      });
    }
    
    logger.info({ playlistUrl, folder_ids }, 'Playlist download requested');
    
    // Fetch playlist metadata
    const playlistData = await fetchPlaylistMetadata(playlistUrl);
    
    if (!playlistData.videos || playlistData.videos.length === 0) {
      return res.status(400).json({
        error: 'Playlist is empty or could not be fetched',
      });
    }
    
    // Add each video to the download queue
    const jobs = [];
    const errors = [];
    
    for (const video of playlistData.videos) {
      try {
        const metadata = {
          video_id: video.video_id,
          title: video.title,
          channel: video.channel,
          duration: video.duration,
          thumbnail: video.thumbnail,
          url: video.url,
        };
        
        const job = await downloadQueue.addJob(video.url, metadata, folder_ids);
        jobs.push(job);
      } catch (error) {
        // Log but continue with other videos
        logger.warn({ 
          video_id: video.video_id, 
          title: video.title, 
          error: error.message 
        }, 'Failed to add video from playlist');
        
        errors.push({
          video_id: video.video_id,
          title: video.title,
          error: error.message,
        });
      }
    }
    
    res.status(201).json({
      message: `Added ${jobs.length} videos from playlist to download queue`,
      playlist_title: playlistData.playlist_title,
      total_videos: playlistData.video_count,
      added: jobs.length,
      skipped: errors.length,
      jobs,
      errors: errors.length > 0 ? errors : undefined,
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to add playlist downloads');
    res.status(500).json({
      error: 'Failed to add playlist downloads',
      message: error.message,
    });
  }
});

/**
 * Add a new download job from direct URL
 * POST /api/downloads
 * Body: { youtubeUrl: string, folder_ids?: array }
 */
router.post('/', authRequired(), async (req, res) => {
  try {
    const { youtubeUrl, folder_ids } = req.body;
    
    if (!youtubeUrl || typeof youtubeUrl !== 'string') {
      return res.status(400).json({
        error: 'YouTube URL is required',
      });
    }
    
    if (!isValidYouTubeUrl(youtubeUrl)) {
      return res.status(400).json({
        error: 'Invalid YouTube URL',
      });
    }
    
    logger.info({ youtubeUrl, folder_ids }, 'Download job requested via URL');
    
    const job = await downloadQueue.addJob(youtubeUrl, null, folder_ids);
    
    res.status(201).json({
      message: 'Download job added to queue',
      job,
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to add download job');
    
    if (error.message.includes('already')) {
      return res.status(409).json({
        error: error.message,
      });
    }
    
    res.status(500).json({
      error: 'Failed to add download job',
      message: error.message,
    });
  }
});

/**
 * Add a new download job from search result
 * POST /api/downloads/from-search
 * Body: { video_id, title, channel, duration, thumbnail, url, folder_ids }
 */
router.post('/from-search', authRequired(), async (req, res) => {
  try {
    const { video_id, title, channel, duration, thumbnail, url, folder_ids } = req.body;
    
    if (!video_id || !url) {
      return res.status(400).json({
        error: 'video_id and url are required',
      });
    }
    
    logger.info({ video_id, title, folder_ids }, 'Download job requested from search result');
    
    // Prepare metadata from search result
    const metadata = {
      video_id,
      title,
      channel,
      duration,
      thumbnail,
      url,
    };
    
    const job = await downloadQueue.addJob(url, metadata, folder_ids);
    
    res.status(201).json({
      message: 'Download job added to queue',
      job,
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to add download job from search');
    
    if (error.message.includes('already')) {
      return res.status(409).json({
        error: error.message,
      });
    }
    
    res.status(500).json({
      error: 'Failed to add download job',
      message: error.message,
    });
  }
});

/**
 * Get all download jobs
 * GET /api/downloads?limit=50&offset=0&status=pending
 */
router.get('/', (req, res) => {
  try {
    const { limit = 50, offset = 0, status } = req.query;
    
    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);
    
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 200) {
      return res.status(400).json({
        error: 'Limit must be between 1 and 200',
      });
    }
    
    if (isNaN(offsetNum) || offsetNum < 0) {
      return res.status(400).json({
        error: 'Offset must be non-negative',
      });
    }
    
    const validStatuses = ['pending', 'downloading', 'completed', 'failed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Status must be one of: ${validStatuses.join(', ')}`,
      });
    }
    
    const jobs = downloadQueue.getAllJobs(limitNum, offsetNum, status || null);
    const queueStatus = downloadQueue.getQueueStatus();
    
    res.json({
      jobs,
      total: jobs.length,
      queueStatus,
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to get download jobs');
    res.status(500).json({
      error: 'Failed to get download jobs',
      message: error.message,
    });
  }
});

/**
 * Get queue status
 * GET /api/downloads/queue/status
 */
router.get('/queue/status', (req, res) => {
  try {
    const status = downloadQueue.getQueueStatus();
    res.json(status);
  } catch (error) {
    logger.error({ error }, 'Failed to get queue status');
    res.status(500).json({
      error: 'Failed to get queue status',
      message: error.message,
    });
  }
});

/**
 * Get specific download job
 * GET /api/downloads/:jobId
 */
router.get('/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    
    const job = downloadQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({
        error: 'Job not found',
      });
    }
    
    res.json(job);
    
  } catch (error) {
    logger.error({ error }, 'Failed to get download job');
    res.status(500).json({
      error: 'Failed to get download job',
      message: error.message,
    });
  }
});

/**
 * Cancel a download job
 * DELETE /api/downloads/:jobId
 */
router.delete('/:jobId', authRequired(), (req, res) => {
  try {
    const { jobId } = req.params;
    
    downloadQueue.cancelJob(jobId);
    
    res.json({
      message: 'Job cancelled successfully',
      jobId,
    });
    
  } catch (error) {
    logger.error({ error, jobId: req.params.jobId }, 'Failed to cancel job');
    
    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message,
      });
    }
    
    res.status(400).json({
      error: error.message,
    });
  }
});

/**
 * Retry a failed download job
 * POST /api/downloads/:jobId/retry
 */
router.post('/:jobId/retry', authRequired(), async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const job = await downloadQueue.retryJob(jobId);
    
    res.json({
      message: 'Job retried successfully',
      job,
    });
    
  } catch (error) {
    logger.error({ error, jobId: req.params.jobId }, 'Failed to retry job');
    
    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message,
      });
    }
    
    res.status(400).json({
      error: error.message,
    });
  }
});

/**
 * Delete a completed/failed job
 * POST /api/downloads/:jobId/delete
 */
router.post('/:jobId/delete', authRequired(), (req, res) => {
  try {
    const { jobId } = req.params;
    
    downloadQueue.deleteJob(jobId);
    
    res.json({
      message: 'Job deleted successfully',
      jobId,
    });
    
  } catch (error) {
    logger.error({ error, jobId: req.params.jobId }, 'Failed to delete job');
    
    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message,
      });
    }
    
    res.status(400).json({
      error: error.message,
    });
  }
});

/**
 * Clear all completed jobs
 * POST /api/downloads/clear/completed
 */
router.post('/clear/completed', authRequired(), (req, res) => {
  try {
    const deletedCount = downloadQueue.clearCompleted();
    
    res.json({
      message: 'Completed jobs cleared successfully',
      deletedCount,
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to clear completed jobs');
    res.status(500).json({
      error: 'Failed to clear completed jobs',
      message: error.message,
    });
  }
});

/**
 * Clear all jobs from queue
 * POST /api/downloads/clear/all
 */
router.post('/clear/all', authRequired(), (req, res) => {
  try {
    const deletedCount = downloadQueue.clearAll();
    
    res.json({
      message: 'All jobs cleared successfully',
      deletedCount,
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to clear all jobs');
    res.status(500).json({
      error: 'Failed to clear all jobs',
      message: error.message,
    });
  }
});

export default router;
