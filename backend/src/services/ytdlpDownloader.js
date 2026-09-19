import { spawn } from 'child_process';
import { promisify } from 'util';
import { access, rename, unlink } from 'fs/promises';
import { join, extname, basename } from 'path';
import config from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * Extract video ID from YouTube URL
 */
export function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/,
    /^([a-zA-Z0-9_-]{11})$/, // Direct video ID
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  throw new Error('Invalid YouTube URL or video ID');
}

/**
 * Check if URL is a playlist
 */
export function isPlaylistUrl(url) {
  const playlistPatterns = [
    /[?&]list=([a-zA-Z0-9_-]+)/,
    /youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/,
  ];
  
  return playlistPatterns.some(pattern => pattern.test(url));
}

/**
 * Extract playlist ID from URL
 */
export function extractPlaylistId(url) {
  const playlistPatterns = [
    /[?&]list=([a-zA-Z0-9_-]+)/,
    /youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/,
  ];
  
  for (const pattern of playlistPatterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  throw new Error('Invalid playlist URL');
}

/**
 * Validate YouTube URL (video or playlist)
 */
export function isValidYouTubeUrl(url) {
  try {
    extractVideoId(url);
    return true;
  } catch {
    // If not a video, check if it's a playlist
    return isPlaylistUrl(url);
  }
}

/**
 * Fetch video metadata without downloading
 */
export async function fetchVideoMetadata(videoIdOrUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-playlist',
      videoIdOrUrl,
    ];
    
    logger.debug({ args }, 'Fetching video metadata with yt-dlp');
    
    const ytdlp = spawn(config.ytdlpPath, args);
    let stdout = '';
    let stderr = '';
    
    ytdlp.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ytdlp.on('close', (code) => {
      if (code !== 0) {
        logger.error({ code, stderr }, 'Failed to fetch video metadata');
        return reject(new Error(`yt-dlp failed with code ${code}: ${stderr}`));
      }
      
      try {
        const metadata = JSON.parse(stdout);
        const result = {
          video_id: metadata.id,
          title: metadata.title,
          channel: metadata.uploader || metadata.channel,
          duration: metadata.duration,
          thumbnail: metadata.thumbnail,
          url: metadata.webpage_url || `https://www.youtube.com/watch?v=${metadata.id}`,
          description: metadata.description,
          upload_date: metadata.upload_date,
        };
        
        logger.debug({ video_id: result.video_id, title: result.title }, 'Video metadata fetched');
        resolve(result);
      } catch (error) {
        logger.error({ error }, 'Failed to parse video metadata JSON');
        reject(new Error('Failed to parse video metadata'));
      }
    });
    
    ytdlp.on('error', (error) => {
      logger.error({ error }, 'Failed to spawn yt-dlp');
      reject(error);
    });
  });
}

/**
 * Fetch playlist metadata without downloading
 */
export async function fetchPlaylistMetadata(playlistUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--flat-playlist',
      '--yes-playlist',
      playlistUrl,
    ];
    
    logger.debug({ args }, 'Fetching playlist metadata with yt-dlp');
    
    const ytdlp = spawn(config.ytdlpPath, args);
    let stdout = '';
    let stderr = '';
    
    ytdlp.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ytdlp.on('close', (code) => {
      if (code !== 0) {
        logger.error({ code, stderr }, 'Failed to fetch playlist metadata');
        return reject(new Error(`yt-dlp failed with code ${code}: ${stderr}`));
      }
      
      try {
        // Parse each line as a separate JSON object (one per video)
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        if (lines.length === 0) {
          return reject(new Error('Empty playlist or failed to fetch'));
        }
        
        // First line may contain playlist info
        const firstItem = JSON.parse(lines[0]);
        const playlistTitle = firstItem.playlist_title || firstItem.playlist || 'Unknown Playlist';
        const playlistId = firstItem.playlist_id || extractPlaylistId(playlistUrl);
        
        // Parse all videos
        const videos = lines.map(line => {
          try {
            const data = JSON.parse(line);
            return {
              video_id: data.id,
              title: data.title,
              channel: data.uploader || data.channel,
              duration: data.duration,
              thumbnail: data.thumbnail || data.thumbnails?.[0]?.url,
              url: data.url || `https://www.youtube.com/watch?v=${data.id}`,
            };
          } catch (error) {
            logger.warn({ line, error }, 'Failed to parse playlist video line');
            return null;
          }
        }).filter(video => video !== null);
        
        const result = {
          playlist_id: playlistId,
          playlist_title: playlistTitle,
          playlist_url: playlistUrl,
          video_count: videos.length,
          videos,
        };
        
        logger.info({ 
          playlist_id: playlistId, 
          title: playlistTitle, 
          video_count: videos.length 
        }, 'Playlist metadata fetched');
        
        resolve(result);
      } catch (error) {
        logger.error({ error }, 'Failed to parse playlist metadata JSON');
        reject(new Error('Failed to parse playlist metadata'));
      }
    });
    
    ytdlp.on('error', (error) => {
      logger.error({ error }, 'Failed to spawn yt-dlp');
      reject(error);
    });
  });
}

/**
 * Download audio from YouTube video
 * @param {string} videoIdOrUrl - YouTube video ID or URL
 * @param {string} outputDir - Directory to save the downloaded file
 * @param {function} onProgress - Progress callback (percent, eta)
 * @returns {Promise<{filepath: string, filename: string, metadata: object}>}
 */
export async function downloadAudio(videoIdOrUrl, outputDir, onProgress = null) {
  return new Promise((resolve, reject) => {
    // Generate a unique temporary filename template
    const timestamp = Date.now();
    const outputTemplate = join(outputDir, `yt-%(id)s-${timestamp}.%(ext)s`);
    
    const args = [
      '--extract-audio',
      '--audio-format', 'm4a',
      '--audio-quality', '0', // Best quality
      '--add-metadata',
      '--embed-thumbnail',
      '--output', outputTemplate,
      '--newline',
      '--no-playlist',
      '--quiet', // Reduce stderr noise
      '--progress', // Show progress on stdout
      videoIdOrUrl,
    ];
    
    logger.info({ videoIdOrUrl, outputDir }, 'Starting audio download with yt-dlp');
    
    const ytdlp = spawn(config.ytdlpPath, args);
    let stderr = '';
    let downloadedFile = null;
    let videoId = null;
    
    // Parse progress from stdout
    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Parse progress line: [download]  45.2% of 3.45MiB at 123.45KiB/s ETA 00:12
      const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (progressMatch && onProgress) {
        const percent = parseFloat(progressMatch[1]);
        
        // Parse ETA
        const etaMatch = output.match(/ETA\s+(\d{2}):(\d{2})/);
        let etaSeconds = null;
        if (etaMatch) {
          etaSeconds = parseInt(etaMatch[1]) * 60 + parseInt(etaMatch[2]);
        }
        
        onProgress(percent, etaSeconds);
      }
      
      // Parse destination line: [download] Destination: /path/to/file.m4a
      const destMatch = output.match(/\[download\] Destination: (.+)/);
      if (destMatch) {
        downloadedFile = destMatch[1].trim();
        logger.debug({ file: downloadedFile }, 'Download destination detected');
      }
      
      // Parse final filename after post-processing
      const finalMatch = output.match(/\[ffmpeg\] Destination: (.+)/);
      if (finalMatch) {
        downloadedFile = finalMatch[1].trim();
        logger.debug({ file: downloadedFile }, 'Final file after post-processing');
      }
    });
    
    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ytdlp.on('close', async (code) => {
      if (code !== 0) {
        logger.error({ code, stderr }, 'yt-dlp download failed');
        return reject(new Error(`Download failed: ${stderr || 'Unknown error'}`));
      }
      
      // If we didn't detect the file from stdout, try to find it
      if (!downloadedFile) {
        try {
          // The file should match the pattern yt-*-timestamp.m4a
          const { readdir } = await import('fs/promises');
          const files = await readdir(outputDir);
          const matchingFile = files.find(f => 
            f.startsWith('yt-') && 
            f.includes(`-${timestamp}`) && 
            f.endsWith('.m4a')
          );
          
          if (matchingFile) {
            downloadedFile = join(outputDir, matchingFile);
          }
        } catch (error) {
          logger.error({ error }, 'Failed to find downloaded file');
        }
      }
      
      if (!downloadedFile) {
        return reject(new Error('Download completed but file not found'));
      }
      
      // Verify file exists
      try {
        await access(downloadedFile);
      } catch (error) {
        logger.error({ file: downloadedFile }, 'Downloaded file does not exist');
        return reject(new Error('Downloaded file not found'));
      }
      
      // Extract video ID from filename if not already known
      const filenameMatch = basename(downloadedFile).match(/yt-([a-zA-Z0-9_-]{11})-/);
      if (filenameMatch) {
        videoId = filenameMatch[1];
      }
      
      logger.info({ 
        file: downloadedFile, 
        videoId 
      }, 'Audio download completed');
      
      resolve({
        filepath: downloadedFile,
        filename: basename(downloadedFile),
        videoId,
      });
    });
    
    ytdlp.on('error', (error) => {
      logger.error({ error }, 'Failed to spawn yt-dlp');
      reject(new Error('Failed to start download process'));
    });
    
    // Handle timeout
    const timeout = setTimeout(() => {
      ytdlp.kill();
      reject(new Error('Download timeout exceeded'));
    }, config.downloadTimeout);
    
    ytdlp.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Search YouTube for videos
 * @param {string} query - Search query
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} - Array of search results
 */
export async function searchYouTube(query, limit = 10, offset = 0) {
  return new Promise((resolve, reject) => {
    // yt-dlp's ytsearch only takes a count from the top of the result set, so paging fetches
    // limit+offset entries and discards the ones already shown. YouTube keeps the ordering stable
    // for a query within a session, which is what makes the pages line up without overlap.
    const searchQuery = `ytsearch${limit + offset}:${query}`;
    const args = [
      searchQuery,
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
    ];
    
    logger.debug({ query, limit, offset }, 'Searching YouTube with yt-dlp');
    
    const ytdlp = spawn(config.ytdlpPath, args);
    let stdout = '';
    let stderr = '';
    
    ytdlp.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ytdlp.on('close', (code) => {
      if (code !== 0) {
        logger.error({ code, stderr }, 'YouTube search failed');
        return reject(new Error(`Search failed: ${stderr || 'Unknown error'}`));
      }
      
      try {
        // Parse each line as a separate JSON object
        const results = stdout
          .trim()
          .split('\n')
          .filter(line => line.trim())
          .map(line => {
            try {
              const data = JSON.parse(line);
              return {
                video_id: data.id,
                title: data.title,
                channel: data.uploader || data.channel,
                duration: data.duration,
                thumbnail: data.thumbnail || data.thumbnails?.[0]?.url,
                url: data.url || `https://www.youtube.com/watch?v=${data.id}`,
                view_count: data.view_count,
              };
            } catch (error) {
              logger.warn({ line, error }, 'Failed to parse search result line');
              return null;
            }
          })
          .filter(result => result !== null)
          .slice(offset, offset + limit);
        
        logger.info({ query, resultCount: results.length, offset }, 'YouTube search completed');
        resolve(results);
      } catch (error) {
        logger.error({ error, stdout }, 'Failed to parse search results');
        reject(new Error('Failed to parse search results'));
      }
    });
    
    ytdlp.on('error', (error) => {
      logger.error({ error }, 'Failed to spawn yt-dlp for search');
      reject(new Error('Failed to start search process'));
    });
    
    // Handle search timeout
    const timeout = setTimeout(() => {
      ytdlp.kill();
      reject(new Error('Search timeout exceeded'));
    }, config.youtubeSearchTimeout);
    
    ytdlp.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

export default {
  extractVideoId,
  extractPlaylistId,
  isValidYouTubeUrl,
  isPlaylistUrl,
  fetchVideoMetadata,
  fetchPlaylistMetadata,
  downloadAudio,
  searchYouTube,
};
