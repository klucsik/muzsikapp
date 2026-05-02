# Multi-stage Dockerfile for RPG Music Streaming Server
# Stage 1: Build frontend
FROM node:24-alpine AS frontend-builder

WORKDIR /app

# Copy frontend and create backend directory structure
COPY frontend/package*.json ./frontend/
COPY frontend/ ./frontend/

# Create backend/public directory for build output
RUN mkdir -p ./backend/public

# Install frontend dependencies and build
WORKDIR /app/frontend
RUN npm ci && npm run build

# Stage 2: Build backend and final image
FROM node:24-alpine AS production

WORKDIR /app

# Install required system dependencies for better-sqlite3, yt-dlp, and ffmpeg
RUN apk add --no-cache python3 py3-pip make g++ sqlite ffmpeg
RUN pip3 install -U --break-system-packages yt-dlp && \
    ln -sf $(which yt-dlp) /usr/local/bin/yt-dlp

# Copy backend package files
COPY backend/package*.json ./

# Install backend dependencies
RUN npm ci --only=production

# Copy backend source
COPY backend/ ./

# Copy built frontend from frontend-builder stage to backend's public directory
COPY --from=frontend-builder /app/backend/public ./public

# Create directories for data and music
RUN mkdir -p /app/data /app/music

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV MUSIC_DIR=/app/music
ENV DB_PATH=/app/data/rpg-music.db
ENV LOG_LEVEL=info

# Expose the application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server (database initialization happens automatically in server.js)
CMD ["node", "src/server.js"]
