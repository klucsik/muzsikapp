import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { folderQueries, trackFolderQueries, trackQueries } from '../db/database.js';
import logger from '../utils/logger.js';
import { authRequired } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/folders
 * Get all folders
 */
router.get('/', (req, res) => {
  try {
    const folders = folderQueries.getAll();
    
    // Build tree structure
    const folderMap = new Map();
    const rootFolders = [];
    
    // First pass: create map
    folders.forEach(folder => {
      folderMap.set(folder.id, { ...folder, children: [] });
    });
    
    // Second pass: build tree
    folders.forEach(folder => {
      const node = folderMap.get(folder.id);
      if (folder.parent_id) {
        const parent = folderMap.get(folder.parent_id);
        if (parent) {
          parent.children.push(node);
        }
      } else {
        rootFolders.push(node);
      }
    });
    
    // Sort by sort_order
    const sortFolders = (folders) => {
      folders.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      folders.forEach(folder => {
        if (folder.children.length > 0) {
          sortFolders(folder.children);
        }
      });
    };
    sortFolders(rootFolders);
    
    res.json({
      folders: rootFolders,
      total: folders.length,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get folders');
    res.status(500).json({ error: 'Failed to get folders' });
  }
});

/**
 * GET /api/folders/flat
 * Get all folders as flat list
 */
router.get('/flat', (req, res) => {
  try {
    const folders = folderQueries.getAll();
    res.json({ folders, total: folders.length });
  } catch (error) {
    logger.error({ error }, 'Failed to get folders');
    res.status(500).json({ error: 'Failed to get folders' });
  }
});

/**
 * GET /api/folders/:id
 * Get folder by ID
 */
router.get('/:id', (req, res) => {
  try {
    const folder = folderQueries.getById(req.params.id);
    
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    // Get tracks in this folder
    const tracks = trackFolderQueries.getTracksByFolder(req.params.id);
    
    // Get child folders
    const children = folderQueries.getChildren(req.params.id);
    
    res.json({
      ...folder,
      tracks,
      children,
    });
  } catch (error) {
    logger.error({ error, folderId: req.params.id }, 'Failed to get folder');
    res.status(500).json({ error: 'Failed to get folder' });
  }
});

/**
 * POST /api/folders
 * Create new folder
 */
router.post('/', authRequired(), (req, res) => {
  try {
    const { name, parent_id, sort_order } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Folder name is required' });
    }
    
    // Validate parent exists if specified
    if (parent_id) {
      const parent = folderQueries.getById(parent_id);
      if (!parent) {
        return res.status(400).json({ error: 'Parent folder not found' });
      }
    }
    
    const folder = {
      id: uuidv4(),
      name: name.trim(),
      parent_id: parent_id || null,
      sort_order: sort_order || 0,
      created_at: Date.now(),
    };
    
    folderQueries.insert(folder);
    
    logger.info({ folderId: folder.id, name: folder.name }, 'Folder created');
    
    res.status(201).json(folder);
  } catch (error) {
    logger.error({ error }, 'Failed to create folder');
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

/**
 * PUT /api/folders/:id
 * Update folder
 */
router.put('/:id', authRequired(), (req, res) => {
  try {
    const folder = folderQueries.getById(req.params.id);
    
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    const { name, parent_id, sort_order } = req.body;
    
    // Validate parent exists and prevent circular reference
    if (parent_id !== undefined && parent_id !== null) {
      if (parent_id === req.params.id) {
        return res.status(400).json({ error: 'Folder cannot be its own parent' });
      }
      
      const parent = folderQueries.getById(parent_id);
      if (!parent) {
        return res.status(400).json({ error: 'Parent folder not found' });
      }
      
      // Check for circular reference (basic check)
      let current = parent;
      while (current.parent_id) {
        if (current.parent_id === req.params.id) {
          return res.status(400).json({ error: 'Circular folder reference detected' });
        }
        current = folderQueries.getById(current.parent_id);
        if (!current) break;
      }
    }
    
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (parent_id !== undefined) updates.parent_id = parent_id;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }
    
    folderQueries.update(req.params.id, updates);
    
    const updated = folderQueries.getById(req.params.id);
    
    logger.info({ folderId: req.params.id, updates }, 'Folder updated');
    
    res.json(updated);
  } catch (error) {
    logger.error({ error, folderId: req.params.id }, 'Failed to update folder');
    res.status(500).json({ error: 'Failed to update folder' });
  }
});

/**
 * DELETE /api/folders/:id
 * Delete folder
 */
router.delete('/:id', authRequired(), (req, res) => {
  try {
    const folder = folderQueries.getById(req.params.id);
    
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    // Check if folder has children
    const children = folderQueries.getChildren(req.params.id);
    if (children.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete folder with children. Delete or move child folders first.' 
      });
    }
    
    // Remove all track associations
    trackFolderQueries.removeAllFromFolder(req.params.id);
    
    // Delete folder
    folderQueries.delete(req.params.id);
    
    logger.info({ folderId: req.params.id }, 'Folder deleted');
    
    res.json({ success: true, message: 'Folder deleted' });
  } catch (error) {
    logger.error({ error, folderId: req.params.id }, 'Failed to delete folder');
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

/**
 * POST /api/folders/:id/tracks/:trackId
 * Add track to folder
 */
router.post('/:id/tracks/:trackId', authRequired(), (req, res) => {
  try {
    const folder = folderQueries.getById(req.params.id);
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    const track = trackQueries.getById(req.params.trackId);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }
    
    // Check if already added
    const existing = trackFolderQueries.getByTrackAndFolder(req.params.trackId, req.params.id);
    if (existing) {
      return res.status(400).json({ error: 'Track already in folder' });
    }
    
    trackFolderQueries.add(req.params.trackId, req.params.id);
    
    logger.info({ 
      folderId: req.params.id, 
      trackId: req.params.trackId 
    }, 'Track added to folder');
    
    res.json({ success: true, message: 'Track added to folder' });
  } catch (error) {
    logger.error({ error }, 'Failed to add track to folder');
    res.status(500).json({ error: 'Failed to add track to folder' });
  }
});

/**
 * DELETE /api/folders/:id/tracks/:trackId
 * Remove track from folder
 */
router.delete('/:id/tracks/:trackId', authRequired(), (req, res) => {
  try {
    const existing = trackFolderQueries.getByTrackAndFolder(req.params.trackId, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Track not in folder' });
    }
    
    trackFolderQueries.remove(req.params.trackId, req.params.id);
    
    logger.info({ 
      folderId: req.params.id, 
      trackId: req.params.trackId 
    }, 'Track removed from folder');
    
    res.json({ success: true, message: 'Track removed from folder' });
  } catch (error) {
    logger.error({ error }, 'Failed to remove track from folder');
    res.status(500).json({ error: 'Failed to remove track from folder' });
  }
});

/**
 * GET /api/folders/:id/tracks
 * Get all tracks in folder
 */
router.get('/:id/tracks', (req, res) => {
  try {
    const folder = folderQueries.getById(req.params.id);
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    
    const tracks = trackFolderQueries.getTracksByFolder(req.params.id);
    
    res.json({
      folder,
      tracks,
      total: tracks.length,
    });
  } catch (error) {
    logger.error({ error, folderId: req.params.id }, 'Failed to get folder tracks');
    res.status(500).json({ error: 'Failed to get folder tracks' });
  }
});

export default router;
