import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = {
  // Server
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  
  // Paths
  musicDir: process.env.MUSIC_DIR || '/music',
  databasePath: process.env.DATABASE_PATH || join(__dirname, '../../data/rpg-music.db'),
  
  // Audio
  defaultBitrate: parseInt(process.env.DEFAULT_BITRATE || '256', 10),
  maxDriftSeconds: parseInt(process.env.MAX_DRIFT_SECONDS || '10', 10),
  positionCheckInterval: parseInt(process.env.POSITION_CHECK_INTERVAL || '3000', 10), // Check every 3 seconds for sync and autoplay
  
  // WebSocket
  wsPingInterval: parseInt(process.env.WS_PING_INTERVAL || '25000', 10),
  wsPingTimeout: parseInt(process.env.WS_PING_TIMEOUT || '60000', 10),
  
  // Rooms
  roomCount: parseInt(process.env.ROOM_COUNT || '5', 10),
  
  // Scanning
  scanOnStartup: process.env.SCAN_ON_STARTUP === 'true',
  watchFileChanges: process.env.WATCH_FILE_CHANGES === 'true',
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  
  // YouTube Downloads
  ytdlpPath: process.env.YTDLP_PATH || '/usr/local/bin/yt-dlp',
  downloadTimeout: parseInt(process.env.DOWNLOAD_TIMEOUT || '600000', 10), // 10 minutes default
  downloadRetryAttempts: parseInt(process.env.DOWNLOAD_RETRY_ATTEMPTS || '3', 10),
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '100', 10),
  youtubeSearchLimit: parseInt(process.env.YOUTUBE_SEARCH_LIMIT || '10', 10),
  youtubeSearchTimeout: parseInt(process.env.YOUTUBE_SEARCH_TIMEOUT || '30000', 10), // 30 seconds
  
  // External Links
  addMusicUrl: process.env.ADD_MUSIC_URL || '',
  addMusicText: process.env.ADD_MUSIC_TEXT || 'Click "Continue" to open the music source in a new tab.',
  
  // Authentication
  auth: {
    password: process.env.AUTH_PASSWORD || '',
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    tokenExpiresIn: 604800, // 1 week in seconds
    keycloak: {
      url: process.env.AUTH_KEYCLOAK_URL || '',
      realm: process.env.AUTH_KEYCLOAK_REALM || '',
      clientId: process.env.AUTH_KEYCLOAK_CLIENT_ID || '',
      clientSecret: process.env.AUTH_KEYCLOAK_CLIENT_SECRET || '',
      redirectUri: process.env.AUTH_KEYCLOAK_REDIRECT_URI || '',
    },
  },
  
  // Computed
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',
};

export default config;
