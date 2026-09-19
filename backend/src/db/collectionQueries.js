/**
 * Unified Collection Queries
 * Handles all operations for track collections (library, playlists, folders)
 */

import logger from '../utils/logger.js';

/**
 * Columns a rendered track row needs. `mse_meta` is deliberately excluded: it holds one entry per
 * stream fragment, so it accounts for most of the payload, and the only consumer that needs it (the
 * manifest route) reads the track directly rather than from a collection response.
 */
const LIST_COLUMNS = [
  't.id', 't.title', 't.artist', 't.album', 't.duration', 't.format',
  't.file_size', 't.youtube_thumbnail', 't.youtube_video_id',
];

/** Resolve the requested projection into a SELECT list. */
function trackColumns(fields) {
  return fields === 'list' ? LIST_COLUMNS.join(', ') : 't.*';
}

/**
 * Get a collection by ID with its tracks
 * @param {Object} db - Database instance
 * @param {string} collectionId - Collection ID
 * @param {string} orderBy - Order field for library: 'title', 'artist', 'album', 'created_at'
 * @param {string} orderDir - Order direction: 'asc', 'desc'
 * @param {string} searchQuery - Optional search query to filter tracks
 * @param {string} fields - 'full' (default) or 'list' for row-rendering columns only
 * @returns {Object|null} Collection with tracks array
 */
function getCollection(db, collectionId, orderBy = 'title', orderDir = 'asc', searchQuery = '', fields = 'full') {
  try {
    // Get collection metadata
    const collection = db.prepare(`
      SELECT * FROM track_collections WHERE id = ?
    `).get(collectionId);

    if (!collection) {
      return null;
    }

    // Get tracks in this collection
    let tracks;
    if (collection.type === 'library') {
      // Validate ordering parameters to prevent SQL injection
      const validOrderBy = ['title', 'artist', 'album', 'created_at', 'updated_at'];
      const validOrderDir = ['asc', 'desc'];
      
      const safeOrderBy = validOrderBy.includes(orderBy) ? orderBy : 'title';
      const safeOrderDir = validOrderDir.includes(orderDir.toLowerCase()) ? orderDir.toLowerCase() : 'asc';
      
      // Use COLLATE NOCASE for text fields
      const collate = ['title', 'artist', 'album'].includes(safeOrderBy) ? ' COLLATE NOCASE' : '';
      
      // Build search condition
      let whereClause = '';
      const params = [collectionId];
      
      if (searchQuery && searchQuery.trim()) {
        whereClause = `WHERE (
          t.title LIKE ? COLLATE NOCASE OR 
          t.artist LIKE ? COLLATE NOCASE OR 
          t.album LIKE ? COLLATE NOCASE
        )`;
        const searchPattern = `%${searchQuery.trim()}%`;
        params.push(searchPattern, searchPattern, searchPattern);
      }
      
      // Library shows all tracks with custom ordering
      tracks = db.prepare(`
        SELECT 
          ${trackColumns(fields)},
          ct.position,
          ct.added_at
        FROM tracks t
        LEFT JOIN collection_tracks ct ON t.id = ct.track_id AND ct.collection_id = ?
        ${whereClause}
        ORDER BY t.${safeOrderBy}${collate} ${safeOrderDir.toUpperCase()}
      `).all(...params);
    } else {
      // Other collections show only their tracks, ordered by position
      const params = [collectionId];
      let whereClause = 'WHERE ct.collection_id = ?';
      
      if (searchQuery && searchQuery.trim()) {
        whereClause += ` AND (
          t.title LIKE ? COLLATE NOCASE OR 
          t.artist LIKE ? COLLATE NOCASE OR 
          t.album LIKE ? COLLATE NOCASE
        )`;
        const searchPattern = `%${searchQuery.trim()}%`;
        params.push(searchPattern, searchPattern, searchPattern);
      }
      
      tracks = db.prepare(`
        SELECT 
          ${trackColumns(fields)},
          ct.position,
          ct.added_at
        FROM collection_tracks ct
        JOIN tracks t ON ct.track_id = t.id
        ${whereClause}
        ORDER BY ct.position ASC
      `).all(...params);
    }

    return {
      ...collection,
      tracks: tracks || []
    };
  } catch (error) {
    logger.error('Error getting collection:', error);
    throw error;
  }
}

/**
 * Get all collections of a specific type
 * @param {Object} db - Database instance
 * @param {string} type - Collection type ('library', 'playlist', 'folder')
 * @param {string} parentId - Optional parent ID for hierarchical collections
 * @returns {Array} Array of collections
 */
function getCollections(db, type = null, parentId = null) {
  try {
    let query = `
      SELECT 
        tc.*,
        COUNT(ct.id) as track_count
      FROM track_collections tc
      LEFT JOIN collection_tracks ct ON tc.id = ct.collection_id
      WHERE 1=1
    `;
    const params = [];

    if (type) {
      query += ' AND tc.type = ?';
      params.push(type);
    }

    if (parentId !== null) {
      if (parentId === '') {
        query += ' AND tc.parent_id IS NULL';
      } else {
        query += ' AND tc.parent_id = ?';
        params.push(parentId);
      }
    }

    query += ' GROUP BY tc.id ORDER BY tc.sort_order ASC, tc.name ASC';

    return db.prepare(query).all(...params);
  } catch (error) {
    logger.error('Error getting collections:', error);
    throw error;
  }
}

/**
 * Create a new collection
 * @param {Object} db - Database instance
 * @param {Object} data - Collection data
 * @returns {Object} Created collection
 */
function createCollection(db, data) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const id = data.id || `${data.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const stmt = db.prepare(`
      INSERT INTO track_collections (id, name, type, parent_id, sort_order, is_ordered, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.name,
      data.type,
      data.parent_id || null,
      data.sort_order || 0,
      data.is_ordered !== undefined ? data.is_ordered : 1,
      now,
      now
    );

    return getCollection(db, id);
  } catch (error) {
    logger.error('Error creating collection:', error);
    throw error;
  }
}

/**
 * Update a collection
 * @param {Object} db - Database instance
 * @param {string} collectionId - Collection ID
 * @param {Object} updates - Fields to update
 * @returns {Object} Updated collection
 */
function updateCollection(db, collectionId, updates) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.parent_id !== undefined) {
      fields.push('parent_id = ?');
      values.push(updates.parent_id);
    }
    if (updates.sort_order !== undefined) {
      fields.push('sort_order = ?');
      values.push(updates.sort_order);
    }
    if (updates.is_ordered !== undefined) {
      fields.push('is_ordered = ?');
      values.push(updates.is_ordered);
    }

    fields.push('updated_at = ?');
    values.push(now);

    values.push(collectionId);

    const stmt = db.prepare(`
      UPDATE track_collections 
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    stmt.run(...values);

    return getCollection(db, collectionId);
  } catch (error) {
    logger.error('Error updating collection:', error);
    throw error;
  }
}

/**
 * Delete a collection
 * @param {Object} db - Database instance
 * @param {string} collectionId - Collection ID
 */
function deleteCollection(db, collectionId) {
  try {
    // Protected collections cannot be deleted
    if (collectionId === 'library' || collectionId === 'current-playlist') {
      throw new Error('Cannot delete protected collection');
    }

    const stmt = db.prepare('DELETE FROM track_collections WHERE id = ?');
    stmt.run(collectionId);
  } catch (error) {
    logger.error('Error deleting collection:', error);
    throw error;
  }
}

/**
 * Add many tracks to a collection in a single transaction.
 *
 * The per-track endpoint made "play folder" one HTTP request and one broadcast per track, each
 * returning the whole collection; this is the path that collapses that burst into one round trip.
 *
 * @param {Object} db - Database instance
 * @param {string} collectionId - Target collection ID
 * @param {Array<string>} trackIds - Track IDs to append, in order (ignored when sourceCollectionId is set)
 * @param {Object} options - { mode: 'append'|'replace', sourceCollectionId: string|null }
 * @returns {Object} Updated collection plus how many rows were added and which ids were skipped
 */
function addTracks(db, collectionId, trackIds = [], { mode = 'append', sourceCollectionId = null } = {}) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = { added: 0, skipped: [] };

    const bulkTransaction = db.transaction(() => {
      if (mode === 'replace') {
        db.prepare('DELETE FROM collection_tracks WHERE collection_id = ?').run(collectionId);
      }

      const startRow = db.prepare(`
        SELECT COALESCE(MAX(position), -1) as max_pos FROM collection_tracks WHERE collection_id = ?
      `).get(collectionId).max_pos;

      // Copying another collection keeps its ordering without shipping its track list to the
      // client first, so a folder load costs no payload at all until the response.
      if (sourceCollectionId) {
        const copied = db.prepare(`
          INSERT INTO collection_tracks (collection_id, track_id, position, added_at)
          SELECT ?, ct.track_id, ? + ct.position + 1, ?
          FROM collection_tracks ct
          WHERE ct.collection_id = ?
            AND EXISTS (SELECT 1 FROM tracks t WHERE t.id = ct.track_id)
          ORDER BY ct.position ASC
        `).run(collectionId, startRow, now, sourceCollectionId);
        result.added = copied.changes;
        return;
      }

      const exists = db.prepare('SELECT 1 FROM tracks WHERE id = ?');
      const insert = db.prepare(`
        INSERT INTO collection_tracks (collection_id, track_id, position, added_at)
        VALUES (?, ?, ?, ?)
      `);
      trackIds.forEach((trackId, index) => {
        if (!trackId || !exists.get(trackId)) {
          result.skipped.push(trackId);
          return;
        }
        insert.run(collectionId, trackId, startRow + index + 1, now);
        result.added += 1;
      });
    });

    bulkTransaction();

    db.prepare('UPDATE track_collections SET updated_at = ? WHERE id = ?').run(now, collectionId);

    return { ...getCollection(db, collectionId), ...result };
  } catch (error) {
    logger.error('Error adding tracks to collection:', error);
    throw error;
  }
}

/**
 * Add a track to a collection at a specific position
 * @param {Object} db - Database instance
 * @param {string} collectionId - Collection ID
 * @param {string} trackId - Track ID
 * @param {number} position - Position to insert at (null = end)
 * @returns {Object} Updated collection
 */
function addTrack(db, collectionId, trackId, position = null) {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Get max position if position not specified
    if (position === null) {
      const maxPos = db.prepare(`
        SELECT COALESCE(MAX(position), -1) as max_pos 
        FROM collection_tracks 
        WHERE collection_id = ?
      `).get(collectionId);
      position = maxPos.max_pos + 1;
    }

    // Use a transaction to avoid UNIQUE constraint violations
    const addTransaction = db.transaction(() => {
      if (position !== null) {
        // Get all tracks that need to be shifted (using row id)
        const tracksToShift = db.prepare(`
          SELECT id, position 
          FROM collection_tracks 
          WHERE collection_id = ? AND position >= ?
          ORDER BY position DESC
        `).all(collectionId, position);

        // Shift them down one by one in reverse order
        for (const track of tracksToShift) {
          db.prepare(`
            UPDATE collection_tracks 
            SET position = ? 
            WHERE id = ?
          `).run(track.position + 1, track.id);
        }
      }

      // Insert track
      db.prepare(`
        INSERT INTO collection_tracks (collection_id, track_id, position, added_at)
        VALUES (?, ?, ?, ?)
      `).run(collectionId, trackId, position, now);

      // Update collection timestamp
      db.prepare(`
        UPDATE track_collections 
        SET updated_at = ? 
        WHERE id = ?
      `).run(now, collectionId);
    });

    // Execute transaction
    addTransaction();

    return getCollection(db, collectionId);
  } catch (error) {
    logger.error('Error adding track to collection:', error);
    throw error;
  }
}

/**
 * Remove a track from a collection
 * @param {Object} db - Database instance
 * @param {string} collectionId - Collection ID
 * @param {string} trackId - Track ID (removes first occurrence)
 * @param {number} position - Optional: specify position to remove specific instance
 * @returns {Object} Updated collection
 */
function removeTrack(db, collectionId, trackId, position = null) {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Use transaction to avoid UNIQUE constraint violations
    const removeTransaction = db.transaction(() => {
      let trackPosition;

      if (position !== null) {
        // Remove by position
        trackPosition = position;
        db.prepare(`
          DELETE FROM collection_tracks 
          WHERE collection_id = ? AND position = ?
        `).run(collectionId, position);
      } else {
        // Get position of first occurrence of track
        const track = db.prepare(`
          SELECT position FROM collection_tracks 
          WHERE collection_id = ? AND track_id = ?
          ORDER BY position ASC
          LIMIT 1
        `).get(collectionId, trackId);

        if (!track) {
          return; // Nothing to remove
        }

        trackPosition = track.position;

        // Delete first occurrence
        db.prepare(`
          DELETE FROM collection_tracks 
          WHERE collection_id = ? AND track_id = ? AND position = ?
        `).run(collectionId, trackId, trackPosition);
      }

      // Get tracks that need to shift up
      const tracksToShift = db.prepare(`
        SELECT id, position 
        FROM collection_tracks 
        WHERE collection_id = ? AND position > ?
        ORDER BY position ASC
      `).all(collectionId, trackPosition);

      // Shift remaining tracks up one by one
      for (const track of tracksToShift) {
        db.prepare(`
          UPDATE collection_tracks 
          SET position = ? 
          WHERE id = ?
        `).run(track.position - 1, track.id);
      }

      // Update collection timestamp
      db.prepare(`
        UPDATE track_collections 
        SET updated_at = ? 
        WHERE id = ?
      `).run(now, collectionId);
    });

    removeTransaction();

    return getCollection(db, collectionId);
  } catch (error) {
    logger.error('Error removing track from collection:', error);
    throw error;
  }
}

/**
 * Reorder a track within a collection
 * @param {Object} db - Database instance
 * @param {string} collectionId - Collection ID
 * @param {string} trackId - Track ID (or position if passed as oldPosition parameter)
 * @param {number} newPosition - New position
 * @param {number} oldPosition - Optional: specify old position directly (for duplicates)
 * @returns {Object} Updated collection
 */
function reorderTrack(db, collectionId, trackId, newPosition, oldPosition = null) {
  try {
    const now = Math.floor(Date.now() / 1000);

    // If oldPosition not provided, find the track by trackId (first occurrence)
    if (oldPosition === null) {
      const track = db.prepare(`
        SELECT position FROM collection_tracks 
        WHERE collection_id = ? AND track_id = ?
        ORDER BY position ASC
        LIMIT 1
      `).get(collectionId, trackId);

      if (!track) {
        throw new Error('Track not found in collection');
      }
      oldPosition = track.position;
    }
    if (oldPosition === newPosition) {
      return getCollection(db, collectionId);
    }

    // Use a transaction for atomic reordering
    const reorder = db.transaction(() => {
      // First, get the row ID of the track we're moving (by position)
      const movingTrack = db.prepare(`
        SELECT id FROM collection_tracks 
        WHERE collection_id = ? AND position = ?
      `).get(collectionId, oldPosition);

      if (!movingTrack) {
        throw new Error('Track not found at specified position');
      }

      // Set the moving track to a temporary negative position to avoid conflicts
      db.prepare(`
        UPDATE collection_tracks 
        SET position = -1 
        WHERE id = ?
      `).run(movingTrack.id);

      if (newPosition > oldPosition) {
        // Moving down: shift tracks up between old and new position
        const tracksToShift = db.prepare(`
          SELECT id, position 
          FROM collection_tracks 
          WHERE collection_id = ? AND position > ? AND position <= ?
          ORDER BY position ASC
        `).all(collectionId, oldPosition, newPosition);

        for (const track of tracksToShift) {
          db.prepare(`
            UPDATE collection_tracks 
            SET position = ? 
            WHERE id = ?
          `).run(track.position - 1, track.id);
        }
      } else {
        // Moving up: shift tracks down between new and old position
        const tracksToShift = db.prepare(`
          SELECT id, position 
          FROM collection_tracks 
          WHERE collection_id = ? AND position >= ? AND position < ?
          ORDER BY position DESC
        `).all(collectionId, newPosition, oldPosition);

        for (const track of tracksToShift) {
          db.prepare(`
            UPDATE collection_tracks 
            SET position = ? 
            WHERE id = ?
          `).run(track.position + 1, track.id);
        }
      }

      // Finally, update the moved track to its new position
      db.prepare(`
        UPDATE collection_tracks 
        SET position = ? 
        WHERE id = ?
      `).run(newPosition, movingTrack.id);

      // Update collection timestamp
      db.prepare(`
        UPDATE track_collections 
        SET updated_at = ? 
        WHERE id = ?
      `).run(now, collectionId);
    });

    reorder();

    return getCollection(db, collectionId);
  } catch (error) {
    logger.error('Error reordering track in collection:', error);
    throw error;
  }
}

/**
 * Clear all tracks from a collection
 * @param {Object} db - Database instance
 * @param {string} collectionId - Collection ID
 * @returns {Object} Updated collection
 */
function clearTracks(db, collectionId) {
  try {
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
      DELETE FROM collection_tracks 
      WHERE collection_id = ?
    `).run(collectionId);

    // Update collection timestamp
    db.prepare(`
      UPDATE track_collections 
      SET updated_at = ? 
      WHERE id = ?
    `).run(now, collectionId);

    return getCollection(db, collectionId);
  } catch (error) {
    logger.error('Error clearing collection tracks:', error);
    throw error;
  }
}

/**
 * Get tracks in a collection with pagination
 * @param {Object} db - Database instance
 * @param {string} collectionId - Collection ID
 * @param {number} limit - Number of tracks per page
 * @param {number} offset - Offset for pagination
 * @returns {Object} Tracks and total count
 */
function getCollectionTracks(db, collectionId, limit = 50, offset = 0, fields = 'full') {
  try {
    const collection = db.prepare(`
      SELECT * FROM track_collections WHERE id = ?
    `).get(collectionId);

    if (!collection) {
      return { tracks: [], total: 0 };
    }

    let tracks;
    let total;

    if (collection.type === 'library') {
      // Library shows all tracks
      total = db.prepare('SELECT COUNT(*) as count FROM tracks').get().count;
      
      tracks = db.prepare(`
        SELECT 
          ${trackColumns(fields)},
          ct.position,
          ct.added_at
        FROM tracks t
        LEFT JOIN collection_tracks ct ON t.id = ct.track_id AND ct.collection_id = ?
        ORDER BY t.title ASC, t.artist ASC
        LIMIT ? OFFSET ?
      `).all(collectionId, limit, offset);
    } else {
      // Other collections
      total = db.prepare(`
        SELECT COUNT(*) as count 
        FROM collection_tracks 
        WHERE collection_id = ?
      `).get(collectionId).count;

      tracks = db.prepare(`
        SELECT 
          ${trackColumns(fields)},
          ct.position,
          ct.added_at
        FROM collection_tracks ct
        JOIN tracks t ON ct.track_id = t.id
        WHERE ct.collection_id = ?
        ORDER BY ct.position ASC
        LIMIT ? OFFSET ?
      `).all(collectionId, limit, offset);
    }

    return { tracks, total };
  } catch (error) {
    logger.error('Error getting collection tracks:', error);
    throw error;
  }
}

export {
  getCollection,
  getCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  addTrack,
  addTracks,
  removeTrack,
  reorderTrack,
  clearTracks,
  getCollectionTracks
};
