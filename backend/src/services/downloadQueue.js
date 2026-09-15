import { v4 as uuidv4 } from 'uuid';
import { join } from 'path';
import { parseFile } from 'music-metadata';
import { stat } from 'fs/promises';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { downloadJobQueries, trackQueries, collectionQueries } from '../db/database.js';
import { downloadAudio, fetchVideoMetadata, extractVideoId } from './ytdlpDownloader.js';
import { findDuplicateByMetadata, mergeDuplicateTracks } from './deduplication.js';
import { normalizeTrack } from './formatNormalizer.js';

/**
 * Download Queue Manager
 * Singleton service that manages the queue of download jobs
 */
class DownloadQueue {
  constructor() {
    this.processing = false;
    this.currentJob = null;
    this.io = null; // Will be set by setIO()
  }

  /**
   * Set Socket.io instance for broadcasting events
   */
  setIO(io) {
    this.io = io;
    logger.info('Download queue connected to WebSocket');
  }

  /**
   * Broadcast event to all connected clients
   */
  broadcast(event, data) {
    if (this.io) {
      this.io.emit(event, data);
      logger.debug({ event, data }, 'Broadcast download event');
    }
  }

  /**
   * Add a new download job to the queue
   */
  async addJob(youtubeUrl, metadata = null, folderIds = null) {
    try {
      const videoId = extractVideoId(youtubeUrl);
      
      // Check if video is already downloaded
      const existingTrack = trackQueries.getByYoutubeVideoId(videoId);
      if (existingTrack) {
        throw new Error('This video has already been downloaded');
      }
      
      // Check if job already exists in queue
      const existingJob = downloadJobQueries.getByVideoId(videoId);
      if (existingJob && (existingJob.status === 'pending' || existingJob.status === 'downloading')) {
        throw new Error('This video is already in the download queue');
      }
      
      // Fetch metadata if not provided
      let jobMetadata = metadata;
      if (!jobMetadata) {
        try {
          jobMetadata = await fetchVideoMetadata(youtubeUrl);
        } catch (error) {
          logger.warn({ error, youtubeUrl }, 'Failed to fetch video metadata, continuing without it');
          jobMetadata = {
            video_id: videoId,
            title: null,
            channel: null,
            duration: null,
            thumbnail: null,
            url: youtubeUrl,
          };
        }
      }
      
      // Create job
      const jobId = uuidv4();
      const job = {
        id: jobId,
        youtube_url: youtubeUrl,
        youtube_video_id: videoId,
        youtube_title: jobMetadata.title,
        youtube_channel: jobMetadata.channel,
        youtube_thumbnail: jobMetadata.thumbnail,
        youtube_duration: jobMetadata.duration,
        status: 'pending',
        track_id: null,
        folder_id: folderIds && folderIds.length > 0 ? JSON.stringify(folderIds) : null,
        error_message: null,
        progress_percent: 0,
        created_at: Date.now(),
        started_at: null,
        completed_at: null,
      };
      
      downloadJobQueries.insert(job);
      logger.info({ jobId, videoId, title: jobMetadata.title, folderIds }, 'Download job added to queue');
      
      // Broadcast event
      this.broadcast('download_job_added', job);
      this.broadcast('download_queue_updated', this.getQueueStatus());
      
      // Start processing if not already running
      this.processQueue();
      
      return job;
    } catch (error) {
      logger.error({ error, youtubeUrl }, 'Failed to add download job');
      throw error;
    }
  }

  /**
   * Process the download queue (one job at a time)
   */
  async processQueue() {
    if (this.processing) {
      logger.debug('Queue already processing');
      return;
    }
    
    this.processing = true;
    
    try {
      while (true) {
        // Get next pending job
        const pendingJobs = downloadJobQueries.getPendingJobs();
        if (pendingJobs.length === 0) {
          logger.debug('No pending jobs in queue');
          break;
        }
        
        const job = pendingJobs[0];
        this.currentJob = job;
        
        logger.info({ jobId: job.id, videoId: job.youtube_video_id }, 'Starting download job');
        
        // Update status to downloading
        downloadJobQueries.updateStatus(job.id, 'downloading', 0);
        downloadJobQueries.updateStartedAt(job.id, Date.now());
        
        const updatedJob = downloadJobQueries.getById(job.id);
        this.broadcast('download_job_started', updatedJob);
        this.broadcast('download_queue_updated', this.getQueueStatus());
        
        try {
          // Download the audio
          const result = await downloadAudio(
            job.youtube_url,
            config.musicDir,
            (percent, etaSeconds) => {
              // Throttle progress updates (only update if change > 2%)
              const currentPercent = downloadJobQueries.getById(job.id).progress_percent;
              if (Math.abs(percent - currentPercent) >= 2 || percent >= 100) {
                downloadJobQueries.updateProgress(job.id, Math.round(percent));
                
                const progressJob = downloadJobQueries.getById(job.id);
                this.broadcast('download_job_progress', {
                  ...progressJob,
                  etaSeconds,
                });
              }
            }
          );
          
          logger.info({ 
            jobId: job.id, 
            file: result.filepath 
          }, 'Download completed, extracting metadata');
          
          // Extract metadata from downloaded file
          const audioMetadata = await this.extractAudioMetadata(result.filepath);
          
          // Create track in database
          const trackId = uuidv4();
          const relativePath = result.filename; // File is already in music dir
          
          const track = {
            id: trackId,
            filepath: relativePath,
            filename: result.filename,
            title: audioMetadata.title || job.youtube_title || result.filename.replace('.mp3', ''),
            artist: audioMetadata.artist || job.youtube_channel,
            album: audioMetadata.album,
            duration: audioMetadata.duration || job.youtube_duration,
            format: audioMetadata.format || 'mp3',
            bitrate: audioMetadata.bitrate,
            sample_rate: audioMetadata.sample_rate,
            file_size: audioMetadata.file_size,
            youtube_url: job.youtube_url,
            youtube_video_id: job.youtube_video_id,
            youtube_thumbnail: job.youtube_thumbnail,
            created_at: Date.now(),
            updated_at: Date.now(),
          };
          
          trackQueries.insert(track);
          logger.info({ trackId, title: track.title }, 'Track added to library');
          
          // Check for duplicates
          let finalTrackId = trackId;
          let finalTrack = track;
          
          try {
            logger.info({ 
              title: track.title, 
              artist: track.artist, 
              duration: track.duration 
            }, 'Checking for duplicate tracks by metadata');
            
            const duplicateOf = await findDuplicateByMetadata({
              title: track.title,
              artist: track.artist,
              duration: track.duration,
            }, relativePath);
            
            if (duplicateOf) {
              logger.info({ 
                newTrack: trackId, 
                existingTrack: duplicateOf.id,
                newFile: relativePath,
                existingFile: duplicateOf.filepath
              }, 'Duplicate detected, merging tracks');
              
              // Parse folder IDs for merging
              let folderIds = null;
              if (job.folder_id) {
                try {
                  folderIds = JSON.parse(job.folder_id);
                } catch (e) {
                  logger.warn({ folder_id: job.folder_id }, 'Failed to parse folder_id');
                }
              }
              
              // Merge the duplicate into the existing track
              const youtubeMetadata = {
                url: job.youtube_url,
                video_id: job.youtube_video_id,
                thumbnail: job.youtube_thumbnail,
              };
              
              finalTrack = await mergeDuplicateTracks(
                trackId, 
                duplicateOf.id, 
                youtubeMetadata,
                folderIds
              );
              
              finalTrackId = duplicateOf.id;
              
              logger.info({ 
                keptTrack: finalTrackId,
                deletedTrack: trackId 
              }, 'Duplicate merged successfully');
            } else {
              // No duplicate found, add track to folders normally
              if (job.folder_id) {
                try {
                  const folderIds = JSON.parse(job.folder_id);
                  if (Array.isArray(folderIds) && folderIds.length > 0) {
                    for (const folderId of folderIds) {
                      try {
                        // Add track to folder (position will be automatically set to end)
                        collectionQueries.addTrack(folderId, trackId);
                        logger.info({ trackId, folderId }, 'Track added to folder');
                      } catch (folderError) {
                        logger.error({ error: folderError, trackId, folderId }, 'Failed to add track to folder');
                        // Continue with other folders even if one fails
                      }
                    }
                  }
                } catch (parseError) {
                  logger.error({ error: parseError, trackId, folder_id: job.folder_id }, 'Failed to parse folder_id JSON');
                }
              }
            }
          } catch (dedupeError) {
            logger.error({ error: dedupeError }, 'Deduplication check failed, continuing with original track');
            // If deduplication fails, continue with the original track
            // Add track to folders normally
            if (job.folder_id) {
              try {
                const folderIds = JSON.parse(job.folder_id);
                if (Array.isArray(folderIds) && folderIds.length > 0) {
                  for (const folderId of folderIds) {
                    try {
                      collectionQueries.addTrack(folderId, trackId);
                      logger.info({ trackId, folderId }, 'Track added to folder');
                    } catch (folderError) {
                      logger.error({ error: folderError, trackId, folderId }, 'Failed to add track to folder');
                    }
                  }
                }
              } catch (parseError) {
                logger.error({ error: parseError, trackId, folder_id: job.folder_id }, 'Failed to parse folder_id JSON');
              }
            }
          }
          
          // Update job status
          downloadJobQueries.updateStatus(job.id, 'completed', 100);
          downloadJobQueries.updateTrackId(job.id, finalTrackId);
          downloadJobQueries.updateCompletedAt(job.id, Date.now());
          
          const completedJob = downloadJobQueries.getById(job.id);
          this.broadcast('download_job_completed', { job: completedJob, track: finalTrack });
          this.broadcast('download_queue_updated', this.getQueueStatus());
          this.broadcast('track_updated', finalTrack);

          // Make the new file V2-ready now rather than paying for a remux on first play.
          const importedTrack = trackQueries.getById(finalTrackId);
          if (importedTrack) {
            normalizeTrack(importedTrack).catch((error) => {
              logger.warn({ error: error.message, trackId: finalTrackId }, 'Post-download normalisation failed');
            });
          }
          
        } catch (error) {
          logger.error({ error, jobId: job.id }, 'Download job failed');
          
          // Update job with error
          downloadJobQueries.updateStatus(job.id, 'failed', 0);
          downloadJobQueries.updateError(job.id, error.message);
          downloadJobQueries.updateCompletedAt(job.id, Date.now());
          
          const failedJob = downloadJobQueries.getById(job.id);
          this.broadcast('download_job_failed', failedJob);
          this.broadcast('download_queue_updated', this.getQueueStatus());
        }
        
        this.currentJob = null;
      }
    } finally {
      this.processing = false;
      logger.info('Queue processing finished');
    }
  }

  /**
   * Extract metadata from audio file
   */
  async extractAudioMetadata(filepath) {
    try {
      const metadata = await parseFile(filepath);
      const stats = await stat(filepath);
      
      return {
        title: metadata.common.title || null,
        artist: metadata.common.artist || null,
        album: metadata.common.album || null,
        duration: metadata.format.duration || null,
        format: metadata.format.container || 'mp3',
        bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : null,
        sample_rate: metadata.format.sampleRate || null,
        file_size: stats.size,
      };
    } catch (error) {
      logger.warn({ filepath, error }, 'Failed to extract audio metadata');
      const stats = await stat(filepath);
      return {
        title: null,
        artist: null,
        album: null,
        duration: null,
        format: 'mp3',
        bitrate: null,
        sample_rate: null,
        file_size: stats.size,
      };
    }
  }

  /**
   * Get current queue status
   */
  getQueueStatus() {
    const all = downloadJobQueries.getAll();
    const pending = all.filter(j => j.status === 'pending').length;
    const downloading = all.filter(j => j.status === 'downloading').length;
    const completed = all.filter(j => j.status === 'completed').length;
    const failed = all.filter(j => j.status === 'failed').length;
    
    return {
      total: all.length,
      pending,
      downloading,
      completed,
      failed,
      currentJob: this.currentJob,
      processing: this.processing,
    };
  }

  /**
   * Cancel a pending job
   */
  cancelJob(jobId) {
    const job = downloadJobQueries.getById(jobId);
    if (!job) {
      throw new Error('Job not found');
    }
    
    if (job.status === 'downloading') {
      throw new Error('Cannot cancel job that is currently downloading');
    }
    
    if (job.status !== 'pending') {
      throw new Error('Can only cancel pending jobs');
    }
    
    downloadJobQueries.delete(jobId);
    logger.info({ jobId }, 'Download job cancelled');
    
    this.broadcast('download_queue_updated', this.getQueueStatus());
    
    return true;
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId) {
    const job = downloadJobQueries.getById(jobId);
    if (!job) {
      throw new Error('Job not found');
    }
    
    if (job.status !== 'failed') {
      throw new Error('Can only retry failed jobs');
    }
    
    // Reset job status
    downloadJobQueries.updateStatus(jobId, 'pending', 0);
    downloadJobQueries.updateError(jobId, null);
    downloadJobQueries.updateStartedAt(jobId, null);
    downloadJobQueries.updateCompletedAt(jobId, null);
    
    logger.info({ jobId }, 'Download job retried');
    
    const retriedJob = downloadJobQueries.getById(jobId);
    this.broadcast('download_queue_updated', this.getQueueStatus());
    
    // Start processing
    this.processQueue();
    
    return retriedJob;
  }

  /**
   * Delete a job (completed or failed only)
   */
  deleteJob(jobId) {
    const job = downloadJobQueries.getById(jobId);
    if (!job) {
      throw new Error('Job not found');
    }
    
    if (job.status === 'pending' || job.status === 'downloading') {
      throw new Error('Cannot delete pending or downloading jobs. Cancel them first.');
    }
    
    downloadJobQueries.delete(jobId);
    logger.info({ jobId }, 'Download job deleted');
    
    this.broadcast('download_queue_updated', this.getQueueStatus());
    
    return true;
  }

  /**
   * Get all jobs
   */
  getAllJobs(limit = 100, offset = 0, status = null) {
    if (status) {
      return downloadJobQueries.getByStatus(status, limit, offset);
    }
    return downloadJobQueries.getAll(limit, offset);
  }

  /**
   * Get job by ID
   */
  getJob(jobId) {
    return downloadJobQueries.getById(jobId);
  }

  /**
   * Clear all completed jobs
   */
  clearCompleted() {
    const completedJobs = downloadJobQueries.getByStatus('completed');
    let deletedCount = 0;
    
    for (const job of completedJobs) {
      downloadJobQueries.delete(job.id);
      deletedCount++;
    }
    
    logger.info({ deletedCount }, 'Cleared completed download jobs');
    this.broadcast('download_queue_updated', this.getQueueStatus());
    
    return deletedCount;
  }

  /**
   * Clear all jobs (with confirmation)
   */
  clearAll() {
    // Cancel/stop any currently downloading job
    if (this.currentJob) {
      logger.info({ jobId: this.currentJob.id }, 'Stopping current download job before clearing all');
      try {
        // Mark it as cancelled instead of using cancelJob
        downloadJobQueries.updateStatus(this.currentJob.id, 'failed', 0);
        downloadJobQueries.updateError(this.currentJob.id, 'Cancelled by user');
        this.currentJob = null;
      } catch (error) {
        logger.error({ error, jobId: this.currentJob.id }, 'Failed to stop current job');
      }
    }
    
    const allJobs = downloadJobQueries.getAll();
    let deletedCount = 0;
    
    for (const job of allJobs) {
      try {
        downloadJobQueries.delete(job.id);
        deletedCount++;
      } catch (error) {
        logger.error({ error, jobId: job.id }, 'Failed to delete job during clear all');
      }
    }
    
    logger.info({ deletedCount }, 'Cleared all download jobs');
    this.broadcast('download_queue_updated', this.getQueueStatus());
    
    return deletedCount;
  }

  /**
   * Resume processing on server restart
   */
  async resumeQueue() {
    logger.info('Resuming download queue on server start');
    
    // Reset any jobs stuck in "downloading" status (likely from server crash)
    const stuckJobs = downloadJobQueries.getByStatus('downloading');
    for (const job of stuckJobs) {
      logger.warn({ jobId: job.id }, 'Resetting stuck downloading job to pending');
      downloadJobQueries.updateStatus(job.id, 'pending', 0);
      downloadJobQueries.updateStartedAt(job.id, null);
    }
    
    // Start processing
    this.processQueue();
  }
}

// Export singleton instance
const downloadQueue = new DownloadQueue();
export default downloadQueue;
