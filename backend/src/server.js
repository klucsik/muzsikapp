import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import config from './config/config.js';
import logger from './utils/logger.js';
import { initDatabase, closeDatabase } from './db/database.js';
import { authOptional } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import systemRoutes from './routes/system.js';
import trackRoutes from './routes/tracks.js';
import audioRoutes from './routes/audio.js';
import scannerRoutes from './routes/scanner.js';
import playbackRoutes from './routes/playback.js';
import folderRoutes from './routes/folders.js';
import collectionsRoutes from './routes/collections.js';
import downloadsRoutes from './routes/downloads.js';
import { scanMusicLibrary } from './scanner/fileScanner.js';
import { initWebSocket, closeWebSocket, getClientCount } from './websocket/socketServer.js';
import downloadQueue from './services/downloadQueue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const httpServer = createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Debug logging for POST requests
app.use((req, res, next) => {
  if (req.method === 'POST') {
    logger.info({ method: req.method, url: req.url, body: req.body }, '📬 POST request body');
  }
  next();
});

// Serve test client HTML in development
if (config.isDevelopment) {
  app.get('/test-client', (req, res) => {
    res.sendFile('test-client.html', { root: '.' });
  });
}

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
    });
  });
  next();
});

// Authentication middleware (optional - attaches user if token present)
app.use(authOptional());

// API Routes (must be before static files)
app.use('/api/auth', authRoutes);
app.use('/api', systemRoutes);
app.use('/api/tracks', trackRoutes);
app.use('/api/folders', folderRoutes);
app.use('/audio', audioRoutes);
app.use('/api/scan', scannerRoutes);
app.use('/api/playback', playbackRoutes);
app.use('/api/downloads', downloadsRoutes);
// Unified collections API (replaces old playlist and folders routes)
app.use('/api/collections', collectionsRoutes());

// Serve static files from frontend build
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// Serve index.html for all non-API routes (SPA fallback)
app.get('*', (req, res, next) => {
  // Skip if it's an API route or socket.io
  if (req.url.startsWith('/api') || req.url.startsWith('/audio') || req.url.startsWith('/socket.io')) {
    return next();
  }
  
  const indexPath = path.join(publicPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      logger.warn({ error: err }, 'Failed to serve index.html - frontend may not be built yet');
      res.status(200).json({
        name: 'RPG Music Streaming Server',
        version: '1.0.0',
        status: 'running',
        message: 'Frontend not built. Run "npm run build" in the frontend directory.',
        endpoints: {
          health: '/api/health',
          config: '/api/config',
          stats: '/api/stats',
          tracks: '/api/tracks',
          audio: '/audio/:trackId',
          scan: '/api/scan',
          scanStatus: '/api/scan/status',
          playback: '/api/playback',
          websocket: '/socket.io',
        }
      });
    }
  });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.url,
  });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: 'Internal Server Error',
    message: config.isDevelopment ? err.message : 'An error occurred',
  });
});

/**
 * Start the server
 */
async function start() {
  try {
    // Initialize database
    logger.info('Initializing database...');
    await initDatabase();
    
    // Perform initial scan if configured
    if (config.scanOnStartup) {
      logger.info('Performing initial music library scan...');
      const scanResult = await scanMusicLibrary();
      if (scanResult.success) {
        logger.info({ stats: scanResult.stats }, 'Initial scan completed');
      } else {
        logger.warn({ error: scanResult.error }, 'Initial scan failed');
      }
    }
    
    // Start HTTP server
    httpServer.listen(config.port, config.host, () => {
      logger.info({
        port: config.port,
        host: config.host,
        env: config.env,
      }, 'Server started successfully');
      
      logger.info(`Server running at http://${config.host}:${config.port}`);
      logger.info(`Health check: http://${config.host}:${config.port}/api/health`);
      logger.info(`WebSocket: ws://${config.host}:${config.port}/socket.io`);
    });
    
    // Initialize WebSocket server
    logger.info('Initializing WebSocket server...');
    const { io } = initWebSocket(httpServer);
    
    // Attach io to app for use in routes
    app.set('io', io);
    logger.info('WebSocket server ready');
    
    // Connect download queue to WebSocket
    downloadQueue.setIO(io);
    logger.info('Download queue connected to WebSocket');
    
    // Resume download queue (process any pending jobs from previous run)
    await downloadQueue.resumeQueue();
    
    // File watcher disabled - library updates happen on startup scan and through download queue
    logger.info('File watcher disabled - library synced on startup and through downloads');
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  logger.info('Shutting down gracefully...');
  
  // Close WebSocket server
  closeWebSocket();
  
  // Close HTTP server
  httpServer.close(() => {
    logger.info('HTTP server closed');
  });
  
  // Close database
  closeDatabase();
  
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception');
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
  shutdown();
});

// Start the server
start();
