#!/usr/bin/env node
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { access, rename, unlink } from 'fs/promises';
import { join } from 'path';
import config from '../src/config/config.js';

/**
 * migrate-format — re-download MP3 tracks as M4a using stored YouTube URLs.
 */

let dryRun = true;
for (const arg of process.argv.slice(2)) {
  if (arg === '--apply') dryRun = false;
}

async function processTrack(track, db) {
  const youtubeUrl = track.youtube_url;
  if (!youtubeUrl) return;

  console.log(`[MIGRATE] Processing track ${track.id}: ${youtubeUrl}`);

  const timestamp = Date.now();
  // We'll download to a temporary file in the current working directory
  const tempFileBase = `yt-${timestamp}-migrate`;
  const outputTemplate = `${tempFileBase}.%(ext)s`;

  return new Promise((resolve, reject) => {
    const ytdlpArgs = [
      '--extract-audio',
      '--audio-format', 'm4a',
      '--audio-quality', '0',
      '--add-metadata',
      '--embed-thumbnail',
      '--output', outputTemplate,
      '--newline',
      '--no-playlist',
      youtubeUrl,
    ];

    const ytdlp = spawn(config.ytdlpPath || 'yt-dlp', ytdlpArgs);
    let downloadedFile = null;
    let stderrAccum = '';

    ytdlp.stdout.on('data', (d) => {
      const out = d.toString();
      const destMatch = /\[download\] Destination: (.+)/.exec(out);
      if (destMatch) downloadedFile = destMatch[1].trim();
      const finalMatch = /\[ffmpeg\] Destination: (.+)/.exec(out);
      if (finalMatch) downloadedFile = finalMatch[1].trim();
    });

    ytdlp.stderr.on('data', (d) => { stderrAccum += d.toString(); });

    ytdlp.on('close', async (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp failed with code ${code}: ${stderrAccum}`));
      }
      if (!downloadedFile) {
        // Fallback: find the file in current dir
        const fs = await import('fs/promises');
        const files = await fs.readdir('.');
        downloadedFile = files.find(f => f.startsWith(tempFileBase) && f.endsWith('.m4a'));
        if (downloadedFile) downloadedFile = `./${downloadedFile}`;
      }

      if (!downloadedFile) {
        return reject(new Error('Download completed but destination not detected'));
      }

      try {
        await access(downloadedFile);
        const finalNewPath = track.filepath.substring(0, track.filepath.lastIndexOf('.')) + '.m4a';

        if (dryRun) {
          console.log(`[MIGRATE] [DRY-RUN] Would replace ${track.filepath} with ${finalNewPath}`);
          // Clean up temp file even in dry run to avoid cluttering
          const fs = await import('fs/promises');
          await fs.unlink(downloadedFile);
        } else {
          await rename(downloadedFile, finalNewPath);
          db.prepare('UPDATE tracks SET filepath = ?, format = ? WHERE id = ?').run(finalNewPath, 'm4a', track.id);
          console.log(`[MIGRATE] Successfully migrated to ${finalNewPath}`);

          // Delete old MP3 if it exists and is different from the new path
          if (track.filepath !== finalNewPath) {
            const fs = await import('fs/promises');
            try {
              await fs.unlink(track.filepath);
              console.log(`[MIGRATE] Deleted old file: ${track.filepath}`);
            } catch (e) {
              console.warn(`[MIGRATE] Could not delete old file ${track.filepath}: ${e.message}`);
            }
          }
        }
        resolve();
      } catch (err) {
        reject(new Error(`Failed to finalize download: ${err.message}`));
      }
    });

    ytdlp.on('error', reject);
  });
}

async function run() {
  console.log(`[MIGRATE] Starting... Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  const dbPath = config.databasePath;
  let db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    console.error('[MIGRATE] Cannot open database at', dbPath, e);
    process.exit(1);
  }

  const tracks = db.prepare(`
    SELECT id, filepath, format, youtube_url 
    FROM tracks 
    WHERE (format != 'm4a' OR filepath NOT LIKE '%.m4a')
      AND youtube_url IS NOT NULL
  `).all();

  console.log(`[MIGRATE] Found ${tracks.length} tracks needing migration.`);

  for (const track of tracks) {
    try {
      await processTrack(track, db);
    } catch (err) {
      console.error(`[MIGRATE] Error processing track ${track.id}:`, err.message);
    }
  }
  console.log('[MIGRATE] Done.');
}

run().catch(err => console.error('[MIGRATE] Fatal error:', err));
