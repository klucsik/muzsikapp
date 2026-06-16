#!/usr/bin/env node
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { access, rename } from 'fs/promises';
import { join, basename } from 'path';
import config from '../src/config/config.js';

/**
 * reDownload — Re-downloads tracks as M4a if they are not in the correct format or missing.
 */
async function processTrack(track, db) {
  const youtubeUrl = track.youtube_url;
  if (!youtubeUrl) return;

  console.log(`[reDownload] Processing track ${track.id}: ${youtubeUrl}`);

  const timestamp = Date.now();
  // We'll download to a temporary file in the same directory as the target to ensure rename is atomic and on same partition
  const targetDir = join(config.musicDir || '/data/music', 'downloads'); // This might not be correct, let's use track.filepath dir
  // Better: just use the current directory of the script or a known temp dir. 
  // Let's use /tmp for simplicity if we can move it later, but same-partition is better.
  const targetPathDir = join(track.filepath, '..'); // This assumes track.filepath is absolute and correct

  // Actually, let's just download to a temp file in the current working directory or /tmp
  const tempFileBase = `yt-${Date.now()}-temp`;
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
        // Fallback: find the file in current dir that starts with tempFileBase and ends with .m4a
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
        await rename(downloadedFile, finalNewPath);
        db.prepare('UPDATE tracks SET filepath = ?, format = ? WHERE id = ?').run(finalNewPath, 'm4a', track.id);
        console.log(`[reDownload] Successfully migrated to ${finalNewPath}`);
        resolve();
      } catch (err) {
        reject(new Error(`Failed to finalize download: ${err.message}`));
      }
    });

    ytdlp.on('error', reject);
  });
}

async function run() {
  console.log('[reDownload] Starting...');
  const dbPath = config.databasePath;
  let db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    console.error('[reDownload] Cannot open database at', dbPath, e);
    process.exit(1);
  }

  const tracks = db.prepare(`
    SELECT id, filepath, format, youtube_url 
    FROM tracks 
    WHERE (format != 'm4a' OR filepath NOT LIKE '%.m4a')
      AND youtube_url IS NOT NULL
  `).all();

  console.log(`[reDownload] Found ${tracks.length} tracks needing re-download.`);

  for (const track of tracks) {
    try {
      await processTrack(track, db);
    } catch (err) {
      console.error(`[reDownload] Error processing track ${track.id}:`, err.message);
    }
  }
}

run().catch(err => console.error('[reDownload] Fatal error:', err));
