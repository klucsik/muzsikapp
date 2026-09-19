import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Collection responses used to carry every track column, including the per-fragment playback
 * index, which is most of the payload and unused by list rendering. The projection has to keep
 * what rows render and drop what they do not — these assertions pin both halves.
 */

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'projection-db-')), 'test.db');

const { initDatabase, closeDatabase, getDb } = await import('../src/db/database.js');
const cq = await import('../src/db/collectionQueries.js');

let db;

beforeAll(async () => {
  await initDatabase();
  db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`
    INSERT INTO tracks (id, filepath, filename, title, artist, album, duration, format, bitrate,
                        sample_rate, file_size, created_at, updated_at, youtube_thumbnail, mse_meta)
    VALUES (@id, @filepath, @filename, @title, 'Artist', 'Album', 243, 'M4A', 192, 44100, 5242880,
            @now, @now, 'https://thumb/1', @mse_meta)
  `);
  // One fragment entry per ~2s of audio: this is what makes the full row expensive.
  const fragments = Array.from({ length: 119 }, (_, i) => ({ index: i, start: i * 2.053, byteLength: 51200 }));
  const meta = JSON.stringify({ version: 2, fragmentCount: fragments.length, fragments });
  db.transaction(() => {
    for (let i = 0; i < 5; i++) {
      insert.run({ id: `t${i}`, filepath: `/music/t${i}.m4a`, filename: `t${i}.m4a`, title: `Track ${i}`, now, mse_meta: meta });
    }
    db.prepare(`INSERT INTO track_collections (id, name, type, parent_id, sort_order, is_ordered, created_at, updated_at)
                VALUES ('f1', 'Folder', 'folder', NULL, 0, 1, ?, ?)`).run(now, now);
    const link = db.prepare('INSERT INTO collection_tracks (collection_id, track_id, position, added_at) VALUES (?,?,?,?)');
    for (let i = 0; i < 5; i++) link.run('f1', `t${i}`, i, now);
  })();
});

afterAll(() => closeDatabase());

describe('collection list projection', () => {
  it('returns every column by default', () => {
    const full = cq.getCollection(db, 'f1');
    expect(full.tracks).toHaveLength(5);
    expect(full.tracks[0].mse_meta).toBeTruthy();
    expect(full.tracks[0].filepath).toBe('/music/t0.m4a');
  });

  it('drops playback metadata and paths for list rows', () => {
    const list = cq.getCollection(db, 'f1', 'title', 'asc', '', 'list');
    expect(list.tracks).toHaveLength(5);
    const row = list.tracks[0];
    expect(row.mse_meta).toBeUndefined();
    expect(row.filepath).toBeUndefined();
    expect(row.filename).toBeUndefined();
    expect(row.bitrate).toBeUndefined();
  });

  it('keeps the columns a rendered row uses, in playlist order', () => {
    const list = cq.getCollection(db, 'f1', 'title', 'asc', '', 'list');
    expect(Object.keys(list.tracks[0]).sort()).toEqual([
      'added_at', 'album', 'artist', 'duration', 'file_size', 'format', 'id', 'position', 'title',
      'youtube_thumbnail', 'youtube_video_id',
    ].sort());
    expect(list.tracks.map((t) => t.position)).toEqual([0, 1, 2, 3, 4]);
    expect(list.name).toBe('Folder');
  });

  it('shrinks the payload substantially', () => {
    const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
    const full = bytes(cq.getCollection(db, 'f1'));
    const list = bytes(cq.getCollection(db, 'f1', 'title', 'asc', '', 'list'));
    expect(list).toBeLessThan(full / 4);
  });

  it('still projects the library branch, which joins differently', () => {
    const lib = cq.getCollection(db, 'library', 'title', 'asc', '', 'list');
    expect(lib.tracks.length).toBeGreaterThan(0);
    expect(lib.tracks[0].mse_meta).toBeUndefined();
    expect(lib.tracks[0].title).toBeTruthy();
  });

  it('projects the paginated variant too, and is not capped at 1000', () => {
    // The WebSocket join path used to call this with a hard limit of 1000, silently truncating
    // playlists longer than that while HTTP returned everything.
    const page = cq.getCollectionTracks(db, 'f1', 5000, 0, 'list');
    expect(page.total).toBe(5);
    expect(page.tracks).toHaveLength(5);
    expect(page.tracks[0].mse_meta).toBeUndefined();
    expect(page.tracks[0].filepath).toBeUndefined();
    expect(page.tracks.map((t) => t.position)).toEqual([0, 1, 2, 3, 4]);

    const full = cq.getCollectionTracks(db, 'f1', 5000, 0);
    expect(full.tracks[0].mse_meta).toBeTruthy();
  });
});
