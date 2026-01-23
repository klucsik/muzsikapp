import express from 'express';
import fileScanner from '../scanner/fileScanner.js';
import logger from '../utils/logger.js';
import { authRequired } from '../middleware/auth.js';

const { scanMusicLibrary, getScanStats, SUPPORTED_FORMATS } = fileScanner;

const router = express.Router();

// Track scan progress
let scanInProgress = false;
let lastScanResult = null;
let scanProgress = null;

/**
 * Trigger a music library scan
 * POST /api/scan
 */
router.post('/', authRequired(), async (req, res) => {
  if (scanInProgress) {
    return res.status(409).json({
      error: 'Scan already in progress',
      progress: scanProgress,
    });
  }
  
  // Start scan in background
  scanInProgress = true;
  scanProgress = {
    current: 0,
    total: 0,
    stats: {
      scanned: 0,
      added: 0,
      updated: 0,
      errors: 0,
    },
  };
  
  // Respond immediately
  res.json({
    message: 'Music library scan started',
    status: 'in_progress',
  });
  
  // Run scan
  try {
    const result = await scanMusicLibrary((progress) => {
      scanProgress = progress;
    });
    
    lastScanResult = {
      ...result,
      timestamp: Date.now(),
    };
    
    logger.info({ result }, 'Scan completed');
  } catch (error) {
    logger.error({ error }, 'Scan failed');
    lastScanResult = {
      success: false,
      error: error.message,
      timestamp: Date.now(),
    };
  } finally {
    scanInProgress = false;
    scanProgress = null;
  }
});

/**
 * Get scan status
 * GET /api/scan/status
 */
router.get('/status', (req, res) => {
  if (scanInProgress) {
    return res.json({
      status: 'in_progress',
      progress: scanProgress,
    });
  }
  
  if (lastScanResult) {
    return res.json({
      status: lastScanResult.success ? 'completed' : 'failed',
      lastScan: lastScanResult,
    });
  }
  
  res.json({
    status: 'idle',
    message: 'No scan has been performed yet',
  });
});

/**
 * Get scan statistics
 * GET /api/scan/stats
 */
router.get('/stats', (req, res) => {
  const stats = getScanStats();
  res.json({
    ...stats,
    supportedFormats: SUPPORTED_FORMATS,
  });
});

export default router;
