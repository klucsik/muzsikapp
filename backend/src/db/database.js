import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import * as collectionQueriesModule from './collectionQueries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;

/**
 * Run database migrations
 */
async function runMigrations() {
  if (!db) {
    throw new Error('Database not initialized');
  }
  
  logger.info('Running database migrations...');
  
  // Check if youtube_url column exists in tracks table
  const tableInfo = db.prepare("PRAGMA table_info(tracks)").all();
  const hasYoutubeUrl = tableInfo.some(col => col.name === 'youtube_url');
  const hasYoutubeVideoId = tableInfo.some(col => col.name === 'youtube_video_id');
  const hasYoutubeThumbnail = tableInfo.some(col => col.name === 'youtube_thumbnail');
  const hasMseMeta = tableInfo.some(col => col.name === 'mse_meta');
  
  if (!hasYoutubeUrl) {
    logger.info('Adding youtube_url column to tracks table');
    db.exec('ALTER TABLE tracks ADD COLUMN youtube_url TEXT');
  }
  
  if (!hasYoutubeVideoId) {
    logger.info('Adding youtube_video_id column to tracks table');
    db.exec('ALTER TABLE tracks ADD COLUMN youtube_video_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_youtube_video_id ON tracks(youtube_video_id)');
  }
  
  if (!hasYoutubeThumbnail) {
    logger.info('Adding youtube_thumbnail column to tracks table');
    db.exec('ALTER TABLE tracks ADD COLUMN youtube_thumbnail TEXT');
  }

  if (!hasMseMeta) {
    // Fragment index for the V2 (MediaSource) player: fingerprint, media type and byte
    // ranges of each fragment. Kept per track so startup only re-scans changed files.
    logger.info('Adding mse_meta column to tracks table');
    db.exec('ALTER TABLE tracks ADD COLUMN mse_meta TEXT');
  }
  
  // Check if download_jobs table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='download_jobs'").all();
  const hasDownloadJobsTable = tables.length > 0;
  
  if (!hasDownloadJobsTable) {
    logger.info('Creating download_jobs table');
    db.exec(`
      CREATE TABLE download_jobs (
        id TEXT PRIMARY KEY,
        youtube_url TEXT NOT NULL,
        youtube_video_id TEXT NOT NULL,
        youtube_title TEXT,
        youtube_channel TEXT,
        youtube_thumbnail TEXT,
        youtube_duration INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        track_id TEXT,
        folder_id TEXT,
        error_message TEXT,
        progress_percent INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
      )
    `);
    
    db.exec('CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_download_jobs_video_id ON download_jobs(youtube_video_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_download_jobs_created_at ON download_jobs(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_download_jobs_folder_id ON download_jobs(folder_id)');
    
    logger.info('Download jobs table created');
  } else {
    // Check if folder_id column exists in download_jobs
    const downloadJobsInfo = db.prepare("PRAGMA table_info(download_jobs)").all();
    const hasFolderId = downloadJobsInfo.some(col => col.name === 'folder_id');
    
    if (!hasFolderId) {
      logger.info('Adding folder_id column to download_jobs table');
      db.exec('ALTER TABLE download_jobs ADD COLUMN folder_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_download_jobs_folder_id ON download_jobs(folder_id)');
    }
  }
  
  // Check if room-specific playlists exist in track_collections (for multi-room support)
  const collectionsTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='track_collections'").all();
  if (collectionsTableExists.length > 0) {
    for (let i = 1; i <= 5; i++) {
      const roomPlaylistId = `current-playlist-room-${i}`;
      const roomPlaylistExists = db.prepare("SELECT id FROM track_collections WHERE id = ?").get(roomPlaylistId);
      
      if (!roomPlaylistExists) {
        logger.info(`Creating room ${i} playlist collection`);
        db.prepare(`
          INSERT INTO track_collections (id, name, type, parent_id, sort_order, is_ordered, created_at, updated_at)
          VALUES (?, ?, 'playlist', NULL, 0, 1, strftime('%s', 'now'), strftime('%s', 'now'))
        `).run(roomPlaylistId, `Room ${i} Playlist`);
      }
    }
  }
  
  logger.info('Database migrations completed');
}

/**
 * Initialize the database connection and create tables
 */
export async function initDatabase() {
  try {
    // Ensure the data directory exists
    const dbDir = dirname(config.databasePath);
    await mkdir(dbDir, { recursive: true });
    
    // Create database connection
    db = new Database(config.databasePath);
    
    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    
    // Enable foreign keys
    db.pragma('foreign_keys = ON');
    
    logger.info({ path: config.databasePath }, 'Database connection established');
    
    // Run base schema (backwards compatible)
    const schema = readFileSync(`${__dirname}/schema-base.sql`, 'utf-8');
    db.exec(schema);
    
    logger.info('Database base schema initialized');
    
    // Run migrations for YouTube support
    try {
      await runMigrations();
    } catch (error) {
      logger.error({ error }, 'Failed to run migrations');
      throw error;
    }
    
    // Run collections schema (new unified system)
    try {
      const collectionsSchema = readFileSync(`${__dirname}/schema-collections.sql`, 'utf-8');
      db.exec(collectionsSchema);
      logger.info('Collections schema initialized');
    } catch (error) {
      // Collections schema is optional for now during transition
      logger.warn({ error }, 'Collections schema not found or failed to initialize');
    }
    
    return db;
  } catch (error) {
    logger.error({ error }, 'Failed to initialize database');
    throw error;
  }
}

/**
 * Get the database instance
 */
export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase() {
  if (db) {
    db.close();
    logger.info('Database connection closed');
  }
}

// Track operations
export const trackQueries = {
  /**
   * Insert a new track
   */
  insert: (track) => {
    const stmt = getDb().prepare(`
      INSERT INTO tracks (id, filepath, filename, title, artist, album, duration, 
                         format, bitrate, sample_rate, file_size, youtube_url, 
                         youtube_video_id, youtube_thumbnail, created_at, updated_at)
      VALUES (@id, @filepath, @filename, @title, @artist, @album, @duration,
              @format, @bitrate, @sample_rate, @file_size, @youtube_url,
              @youtube_video_id, @youtube_thumbnail, @created_at, @updated_at)
    `);
    return stmt.run(track);
  },

  /**
   * Get track by ID
   */
  getById: (id) => {
    const stmt = getDb().prepare('SELECT * FROM tracks WHERE id = ?');
    return stmt.get(id);
  },

  /**
   * Get track by filepath
   */
  getByFilepath: (filepath) => {
    const stmt = getDb().prepare('SELECT * FROM tracks WHERE filepath = ?');
    return stmt.get(filepath);
  },

  /**
   * Get all tracks with pagination and ordering
   * @param {number} limit - Maximum number of tracks
   * @param {number} offset - Offset for pagination
   * @param {string} orderBy - Order field: 'title', 'created_at'
   * @param {string} orderDir - Order direction: 'asc', 'desc'
   */
  getAll: (limit = 100, offset = 0, orderBy = 'title', orderDir = 'asc') => {
    // Validate orderBy to prevent SQL injection
    const validOrderBy = ['title', 'artist', 'album', 'created_at', 'updated_at'];
    const validOrderDir = ['asc', 'desc'];
    
    const safeOrderBy = validOrderBy.includes(orderBy) ? orderBy : 'title';
    const safeOrderDir = validOrderDir.includes(orderDir.toLowerCase()) ? orderDir.toLowerCase() : 'asc';
    
    // Use COLLATE NOCASE for text fields
    const collate = ['title', 'artist', 'album'].includes(safeOrderBy) ? ' COLLATE NOCASE' : '';
    
    const stmt = getDb().prepare(`
      SELECT * FROM tracks 
      ORDER BY ${safeOrderBy}${collate} ${safeOrderDir.toUpperCase()}
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset);
  },

  /**
   * Search tracks by title, artist, or album
   */
  search: (query, limit = 100) => {
    const searchPattern = `%${query}%`;
    const stmt = getDb().prepare(`
      SELECT * FROM tracks 
      WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
      ORDER BY title COLLATE NOCASE
      LIMIT ?
    `);
    return stmt.all(searchPattern, searchPattern, searchPattern, limit);
  },

  /**
   * Get tracks in a folder
   */
  getByFolder: (folderId, limit = 100, offset = 0) => {
    const stmt = getDb().prepare(`
      SELECT t.* FROM tracks t
      INNER JOIN track_folders tf ON t.id = tf.track_id
      WHERE tf.folder_id = ?
      ORDER BY t.title COLLATE NOCASE
      LIMIT ? OFFSET ?
    `);
    return stmt.all(folderId, limit, offset);
  },

  /**
   * Count all tracks
   */
  count: () => {
    const stmt = getDb().prepare('SELECT COUNT(*) as count FROM tracks');
    return stmt.get().count;
  },

  /**
   * Tracks the V2 player cannot stream yet. `mse_meta` is written by the converter — in place, or
   * on first play — so anything above zero means part of the library still falls back to V1 until
   * `npm run v2convert` or a listener gets to it. Stale-but-present metadata is not counted: this
   * is a pointer at startup, not an audit.
   */
  countWithoutPlayMeta: () => {
    const stmt = getDb().prepare('SELECT COUNT(*) as count FROM tracks WHERE mse_meta IS NULL');
    return stmt.get().count;
  },

  /**
   * Delete track by ID
   */
  delete: (id) => {
    const stmt = getDb().prepare('DELETE FROM tracks WHERE id = ?');
    return stmt.run(id);
  },

  /**
   * Update track
   */
  update: (id, updates) => {
    const fields = Object.keys(updates).map(key => `${key} = @${key}`).join(', ');
    const stmt = getDb().prepare(`
      UPDATE tracks 
      SET ${fields}, updated_at = @updated_at
      WHERE id = @id
    `);
    return stmt.run({ id, ...updates, updated_at: Date.now() });
  },

  /**
   * Get track by YouTube video ID
   */
  getByYoutubeVideoId: (videoId) => {
    const stmt = getDb().prepare('SELECT * FROM tracks WHERE youtube_video_id = ?');
    return stmt.get(videoId);
  },

  /**
   * Update YouTube URL and video ID for a track
   */
  updateYoutubeData: (id, youtubeUrl, youtubeVideoId) => {
    const stmt = getDb().prepare(`
      UPDATE tracks 
      SET youtube_url = ?, youtube_video_id = ?, updated_at = ?
      WHERE id = ?
    `);
    return stmt.run(youtubeUrl, youtubeVideoId, Date.now(), id);
  },
};

// Folder operations
export const folderQueries = {
  /**
   * Insert a new folder
   */
  insert: (folder) => {
    const stmt = getDb().prepare(`
      INSERT INTO folders (id, name, parent_id, sort_order, created_at)
      VALUES (@id, @name, @parent_id, @sort_order, @created_at)
    `);
    return stmt.run(folder);
  },

  /**
   * Get folder by ID
   */
  getById: (id) => {
    const stmt = getDb().prepare('SELECT * FROM folders WHERE id = ?');
    return stmt.get(id);
  },

  /**
   * Get all root folders (no parent)
   */
  getRoots: () => {
    const stmt = getDb().prepare(`
      SELECT * FROM folders 
      WHERE parent_id IS NULL 
      ORDER BY sort_order, name COLLATE NOCASE
    `);
    return stmt.all();
  },

  /**
   * Get child folders
   */
  getChildren: (parentId) => {
    const stmt = getDb().prepare(`
      SELECT * FROM folders 
      WHERE parent_id = ? 
      ORDER BY sort_order, name COLLATE NOCASE
    `);
    return stmt.all(parentId);
  },

  /**
   * Get all folders
   */
  getAll: () => {
    const stmt = getDb().prepare(`
      SELECT * FROM folders 
      ORDER BY sort_order, name COLLATE NOCASE
    `);
    return stmt.all();
  },

  /**
   * Update folder
   */
  update: (id, updates) => {
    const fields = Object.keys(updates).map(key => `${key} = @${key}`).join(', ');
    const stmt = getDb().prepare(`
      UPDATE folders 
      SET ${fields}
      WHERE id = @id
    `);
    return stmt.run({ id, ...updates });
  },

  /**
   * Delete folder
   */
  delete: (id) => {
    const stmt = getDb().prepare('DELETE FROM folders WHERE id = ?');
    return stmt.run(id);
  },

  /**
   * Count tracks in folder
   */
  countTracks: (folderId) => {
    const stmt = getDb().prepare(`
      SELECT COUNT(*) as count FROM track_folders 
      WHERE folder_id = ?
    `);
    return stmt.get(folderId).count;
  },
};

// Track-Folder relationship operations
export const trackFolderQueries = {
  /**
   * Add track to folder
   */
  add: (trackId, folderId) => {
    const stmt = getDb().prepare(`
      INSERT OR IGNORE INTO track_folders (track_id, folder_id, added_at)
      VALUES (?, ?, ?)
    `);
    return stmt.run(trackId, folderId, Date.now());
  },

  /**
   * Remove track from folder
   */
  remove: (trackId, folderId) => {
    const stmt = getDb().prepare(`
      DELETE FROM track_folders 
      WHERE track_id = ? AND folder_id = ?
    `);
    return stmt.run(trackId, folderId);
  },

  /**
   * Get all folders for a track
   */
  getFoldersForTrack: (trackId) => {
    const stmt = getDb().prepare(`
      SELECT f.* FROM folders f
      INNER JOIN track_folders tf ON f.id = tf.folder_id
      WHERE tf.track_id = ?
      ORDER BY f.name COLLATE NOCASE
    `);
    return stmt.all(trackId);
  },

  /**
   * Remove track from all folders
   */
  removeTrackFromAll: (trackId) => {
    const stmt = getDb().prepare('DELETE FROM track_folders WHERE track_id = ?');
    return stmt.run(trackId);
  },

  /**
   * Remove all tracks from a folder
   */
  removeAllFromFolder: (folderId) => {
    const stmt = getDb().prepare('DELETE FROM track_folders WHERE folder_id = ?');
    return stmt.run(folderId);
  },

  /**
   * Get tracks by folder
   */
  getTracksByFolder: (folderId) => {
    const stmt = getDb().prepare(`
      SELECT t.* FROM tracks t
      INNER JOIN track_folders tf ON t.id = tf.track_id
      WHERE tf.folder_id = ?
      ORDER BY t.title COLLATE NOCASE
    `);
    return stmt.all(folderId);
  },

  /**
   * Get track-folder relationship
   */
  getByTrackAndFolder: (trackId, folderId) => {
    const stmt = getDb().prepare(`
      SELECT * FROM track_folders 
      WHERE track_id = ? AND folder_id = ?
    `);
    return stmt.get(trackId, folderId);
  },
};

// Collection operations (unified system replacing old playlist/folder systems)
export const collectionQueries = {
  getCollection: (collectionId) => 
    collectionQueriesModule.getCollection(getDb(), collectionId),
  
  getCollections: (type = null, parentId = null) => 
    collectionQueriesModule.getCollections(getDb(), type, parentId),
  
  createCollection: (data) => 
    collectionQueriesModule.createCollection(getDb(), data),
  
  updateCollection: (collectionId, updates) => 
    collectionQueriesModule.updateCollection(getDb(), collectionId, updates),
  
  deleteCollection: (collectionId) => 
    collectionQueriesModule.deleteCollection(getDb(), collectionId),
  
  addTrack: (collectionId, trackId, position = null) => 
    collectionQueriesModule.addTrack(getDb(), collectionId, trackId, position),
  
  removeTrack: (collectionId, trackId) => 
    collectionQueriesModule.removeTrack(getDb(), collectionId, trackId),
  
  reorderTrack: (collectionId, trackId, newPosition) => 
    collectionQueriesModule.reorderTrack(getDb(), collectionId, trackId, newPosition),
  
  clearTracks: (collectionId) => 
    collectionQueriesModule.clearTracks(getDb(), collectionId),
  
  getCollectionTracks: (collectionId, limit = 50, offset = 0) => 
    collectionQueriesModule.getCollectionTracks(getDb(), collectionId, limit, offset)
};

// Download job operations
export const downloadJobQueries = {
  /**
   * Insert a new download job
   */
  insert: (job) => {
    const stmt = getDb().prepare(`
      INSERT INTO download_jobs (
        id, youtube_url, youtube_video_id, youtube_title, youtube_channel,
        youtube_thumbnail, youtube_duration, status, track_id, folder_id, error_message,
        progress_percent, created_at, started_at, completed_at
      ) VALUES (
        @id, @youtube_url, @youtube_video_id, @youtube_title, @youtube_channel,
        @youtube_thumbnail, @youtube_duration, @status, @track_id, @folder_id, @error_message,
        @progress_percent, @created_at, @started_at, @completed_at
      )
    `);
    return stmt.run(job);
  },

  /**
   * Get job by ID
   */
  getById: (id) => {
    const stmt = getDb().prepare('SELECT * FROM download_jobs WHERE id = ?');
    return stmt.get(id);
  },

  /**
   * Get job by YouTube video ID
   */
  getByVideoId: (videoId) => {
    const stmt = getDb().prepare('SELECT * FROM download_jobs WHERE youtube_video_id = ?');
    return stmt.get(videoId);
  },

  /**
   * Get all jobs with pagination
   */
  getAll: (limit = 100, offset = 0) => {
    const stmt = getDb().prepare(`
      SELECT * FROM download_jobs 
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset);
  },

  /**
   * Get jobs by status
   */
  getByStatus: (status, limit = 100, offset = 0) => {
    const stmt = getDb().prepare(`
      SELECT * FROM download_jobs 
      WHERE status = ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(status, limit, offset);
  },

  /**
   * Get pending jobs (ordered by creation time)
   */
  getPendingJobs: () => {
    const stmt = getDb().prepare(`
      SELECT * FROM download_jobs 
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `);
    return stmt.all();
  },

  /**
   * Update job status and progress
   */
  updateStatus: (id, status, progressPercent) => {
    const stmt = getDb().prepare(`
      UPDATE download_jobs 
      SET status = ?, progress_percent = ?
      WHERE id = ?
    `);
    return stmt.run(status, progressPercent, id);
  },

  /**
   * Update job progress
   */
  updateProgress: (id, progressPercent) => {
    const stmt = getDb().prepare(`
      UPDATE download_jobs 
      SET progress_percent = ?
      WHERE id = ?
    `);
    return stmt.run(progressPercent, id);
  },

  /**
   * Update job error message
   */
  updateError: (id, errorMessage) => {
    const stmt = getDb().prepare(`
      UPDATE download_jobs 
      SET error_message = ?
      WHERE id = ?
    `);
    return stmt.run(errorMessage, id);
  },

  /**
   * Update job track ID (when download completes)
   */
  updateTrackId: (id, trackId) => {
    const stmt = getDb().prepare(`
      UPDATE download_jobs 
      SET track_id = ?
      WHERE id = ?
    `);
    return stmt.run(trackId, id);
  },

  /**
   * Update started_at timestamp
   */
  updateStartedAt: (id, timestamp) => {
    const stmt = getDb().prepare(`
      UPDATE download_jobs 
      SET started_at = ?
      WHERE id = ?
    `);
    return stmt.run(timestamp, id);
  },

  /**
   * Update completed_at timestamp
   */
  updateCompletedAt: (id, timestamp) => {
    const stmt = getDb().prepare(`
      UPDATE download_jobs 
      SET completed_at = ?
      WHERE id = ?
    `);
    return stmt.run(timestamp, id);
  },

  /**
   * Delete job
   */
  delete: (id) => {
    const stmt = getDb().prepare('DELETE FROM download_jobs WHERE id = ?');
    return stmt.run(id);
  },

  /**
   * Count jobs by status
   */
  countByStatus: (status) => {
    const stmt = getDb().prepare('SELECT COUNT(*) as count FROM download_jobs WHERE status = ?');
    return stmt.get(status).count;
  },

  /**
   * Get total count
   */
  count: () => {
    const stmt = getDb().prepare('SELECT COUNT(*) as count FROM download_jobs');
    return stmt.get().count;
  },
};

export default {
  initDatabase,
  getDb,
  closeDatabase,
  trackQueries,
  folderQueries,
  trackFolderQueries,
  collectionQueries,
  downloadJobQueries,
};
